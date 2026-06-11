import re
from datetime import datetime
from fastapi import APIRouter, Depends, Form, HTTPException, Response
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
import logging

from backend.database import get_db, Caregiver, Alert, AlertAssignment, BackupRequest
from backend.alert_router import atomic_accept_alert
from backend.twilio_service import twilio_service

logger = logging.getLogger("InboundProviders")
router = APIRouter()

@router.get("/api/integrations/twilio/status")
def get_twilio_status():
    """Reports Twilio integration configuration status without exposing credentials."""
    status_info = twilio_service.get_status()
    return {
        "configured": twilio_service.is_configured(),
        "mode": status_info["mode"],
        "account_sid_present": status_info["account_sid_configured"],
        "auth_token_present": status_info["auth_token_configured"],
        "whatsapp_number_present": status_info["whatsapp_sender_configured"],
        "voice_number_present": status_info["voice_sender_configured"],
        "template_sid_present": status_info["template_sid_configured"],
        "public_url": status_info["public_url"]
    }

@router.post("/api/whatsapp/inbound")
def inbound_whatsapp(
    From: str = Form(...),
    Body: str = Form(...),
    db: Session = Depends(get_db)
):
    """
    Twilio WhatsApp inbound webhook.
    Parses commands: ACCEPT [id], HELP [id], RESOLVE [id], DECLINE [id]
    Replies with TwiML messaging response.
    """
    logger.info("Inbound WhatsApp message from %s: %s", From, Body)
    
    # Extract phone number (e.g. "whatsapp:+919876543210" -> "+919876543210")
    normalized_from = From.replace("whatsapp:", "").strip()
    
    # Retrieve sender caregiver
    cg = db.query(Caregiver).filter(
        Caregiver.whatsapp_number == normalized_from,
        Caregiver.active == True
    ).first()
    
    if not cg:
        logger.warning("Rejected inbound message: phone %s is not registered.", normalized_from)
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>SaraCare: Your phone number {normalized_from} is not registered in our system.</Message>
</Response>"""
        return Response(content=twiml, media_type="application/xml")
        
    if not cg.verified:
        logger.warning("Rejected inbound message: phone %s is not verified.", normalized_from)
        twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>SaraCare: Please verify your phone number using the registration link before replying.</Message>
</Response>"""
        return Response(content=twiml, media_type="application/xml")
        
    # Parse command
    text = Body.strip().upper()
    match = re.match(r"^(ACCEPT|HELP|RESOLVE|DECLINE|BACKUP)(?:\s+(\d+))?$", text)
    
    if not match:
        twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>SaraCare: Invalid command format. Supported commands: ACCEPT [id], HELP [id], RESOLVE [id], DECLINE [id]</Message>
</Response>"""
        return Response(content=twiml, media_type="application/xml")
        
    cmd, alert_id_str = match.groups()
    alert_id = int(alert_id_str) if alert_id_str else None
    
    # If no alert_id is provided, try to find the most recent open/active assignment for this caregiver
    if alert_id is None:
        latest_assignment = db.query(AlertAssignment).filter(
            AlertAssignment.caregiver_id == cg.id
        ).order_by(AlertAssignment.assigned_at.desc()).first()
        
        if latest_assignment:
            alert_id = latest_assignment.alert_id
            
    if alert_id is None:
        twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>SaraCare: No recent alert assignment was found for your account. Please specify the alert ID, e.g. ACCEPT 12.</Message>
</Response>"""
        return Response(content=twiml, media_type="application/xml")
        
    # Process commands
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if not alert:
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>SaraCare: Alert ID {alert_id} not found.</Message>
</Response>"""
        return Response(content=twiml, media_type="application/xml")
        
    response_msg = ""
    
    if cmd == "ACCEPT":
        # Concurrency-safe atomic accept
        res = atomic_accept_alert(alert_id, cg.id, db)
        response_msg = res["message"]
        
    elif cmd in ["HELP", "BACKUP"]:
        # Verify caregiver is assigned
        if alert.assigned_caregiver_id != cg.id:
            response_msg = "You are not assigned as the primary caregiver for this alert and cannot request backup."
        elif alert.status not in ["ACCEPTED", "IN_PROGRESS"]:
            response_msg = f"Cannot request backup. Alert status is currently {alert.status}."
        else:
            # Trigger backup escalation
            from backend.alerts import request_alert_backup
            # We can invoke backend alerts function directly
            alert.status = "HELP_REQUESTED"
            db.commit()
            
            # Save backup request
            req = BackupRequest(
                alert_id=alert_id,
                requesting_caregiver_id=cg.id,
                status="pending"
            )
            db.add(req)
            db.commit()
            
            # Notify others
            other_cg = db.query(Caregiver).filter(
                Caregiver.active == True,
                Caregiver.verified == True,
                Caregiver.availability == "available",
                Caregiver.id != cg.id
            ).all()
            
            for o_cg in other_cg:
                if o_cg.whatsapp_enabled:
                    # Notify o_cg
                    backup_token = f"b_{os.urandom(16).hex()}"
                    accept_url = f"{twilio_service.public_url}/caregiver/alerts/{alert.id}/accept?token={backup_token}"
                    body = (
                        f"SaraCare BACKUP Request! Caregiver {cg.name} needs assistance.\n\n"
                        f"Patient: {alert.patient_name}\n"
                        f"Alert: {alert.message}\n\n"
                        f"Tap to accept backup:\n{accept_url}"
                    )
                    twilio_service.send_whatsapp(o_cg.whatsapp_number, body)
                    
            response_msg = "SaraCare: Backup assistance request has been dispatched to other caregivers."
            
    elif cmd == "RESOLVE":
        if alert.status == "RESOLVED":
            response_msg = "This alert has already been resolved."
        else:
            # Decrement caregiver assignments
            if alert.assigned_caregiver_id:
                assignee = db.query(Caregiver).filter(Caregiver.id == alert.assigned_caregiver_id).first()
                if assignee and assignee.current_assignments > 0:
                    assignee.current_assignments -= 1
            if alert.backup_caregiver_id:
                backup_assignee = db.query(Caregiver).filter(Caregiver.id == alert.backup_caregiver_id).first()
                if backup_assignee and backup_assignee.current_assignments > 0:
                    backup_assignee.current_assignments -= 1
                    
            alert.status = "RESOLVED"
            alert.resolved_at = datetime.utcnow()
            db.commit()
            
            db.query(BackupRequest).filter(
                BackupRequest.alert_id == alert_id,
                BackupRequest.status == "pending"
            ).update({"status": "resolved", "resolved_at": datetime.utcnow()}, synchronize_session=False)
            db.commit()
            
            response_msg = f"SaraCare: Alert ID {alert_id} has been marked as RESOLVED. Thank you."
            
    elif cmd == "DECLINE":
        assign = db.query(AlertAssignment).filter(
            AlertAssignment.alert_id == alert_id,
            AlertAssignment.caregiver_id == cg.id
        ).first()
        if assign:
            assign.status = "declined"
            db.commit()
        response_msg = f"SaraCare: You have declined alert {alert_id}. We are escalating this alert."
        
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>{response_msg}</Message>
</Response>"""
    return Response(content=twiml, media_type="application/xml")
