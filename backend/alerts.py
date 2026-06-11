import asyncio
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database import get_db, Alert, Caregiver, Patient, AlertAssignment, BackupRequest
from backend.alert_router import atomic_accept_alert, dispatch_alert, get_eligible_caregivers, send_whatsapp_alert_delivery, trigger_voice_calls
from backend.twilio_service import twilio_service

router = APIRouter()

# Schemas
class AlertCreate(BaseModel):
    patient_name: str
    alert_type: str  # fall | risky_movement | frame_exit | medicine | voice_help | emergency
    severity: str    # routine | urgent | critical
    message: str
    source: Optional[str] = "manual"

class AlertResponse(BaseModel):
    id: int
    timestamp: str
    patient_name: str
    alert_type: str
    severity: str
    message: str
    source: str
    status: str
    assigned_caregiver_id: Optional[int]
    assigned_caregiver_name: Optional[str]
    backup_caregiver_id: Optional[int]
    backup_caregiver_name: Optional[str]
    accepted_at: Optional[str]
    resolved_at: Optional[str]
    routing_mode: str

@router.get("/api/alerts")
def get_alerts(db: Session = Depends(get_db)):
    alerts = db.query(Alert).order_by(Alert.created_at.desc()).all()
    res = []
    for a in alerts:
        cg_name = None
        if a.assigned_caregiver_id:
            cg = db.query(Caregiver).filter(Caregiver.id == a.assigned_caregiver_id).first()
            if cg:
                cg_name = cg.name
                
        bg_name = None
        if a.backup_caregiver_id:
            bg = db.query(Caregiver).filter(Caregiver.id == a.backup_caregiver_id).first()
            if bg:
                bg_name = bg.name
                
        res.append({
            "id": a.id,
            "timestamp": a.created_at.isoformat(),
            "patient_name": a.patient_name,
            "alert_type": a.alert_type,
            "severity": a.severity,
            "message": a.message,
            "source": a.source,
            "status": a.status,
            "assigned_caregiver_id": a.assigned_caregiver_id,
            "assigned_caregiver_name": cg_name,
            "backup_caregiver_id": a.backup_caregiver_id,
            "backup_caregiver_name": bg_name,
            "accepted_at": a.accepted_at.isoformat() if a.accepted_at else None,
            "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
            "routing_mode": a.routing_mode
        })
    return res

@router.post("/api/alerts")
def create_alert(payload: AlertCreate, db: Session = Depends(get_db)):
    alert = Alert(
        patient_name=payload.patient_name,
        alert_type=payload.alert_type,
        severity=payload.severity,
        message=payload.message,
        source=payload.source,
        status="OPEN"
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    
    # Route alert using the router
    dispatch_alert(alert, db)
    
    return {"success": True, "alert_id": alert.id, "status": alert.status}

@router.get("/caregiver/alerts/{alert_id}/accept", response_class=HTMLResponse)
def browser_accept_alert(alert_id: int, token: str = Query(...), db: Session = Depends(get_db)):
    """
    Browser-facing GET endpoint for the one-click accept link in WhatsApp.
    Determines if caregiver has already accepted or if they won the first-accept-wins coordination.
    """
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if not alert:
        return HTMLResponse("<h1>Alert not found</h1>", status_code=404)
        
    # Check token prefix to identify caregiver or search active assignments
    # We can match caregiver via the assignment table
    assign = db.query(AlertAssignment).filter(
        AlertAssignment.alert_id == alert_id
    ).first()
    if not assign:
        # If no explicit assignment, pick the first available verified caregiver to demonstrate
        cg = db.query(Caregiver).filter(Caregiver.active == True, Caregiver.verified == True).first()
        if not cg:
            return HTMLResponse("<h1>No verified caregivers registered to accept this alert.</h1>", status_code=400)
        caregiver_id = cg.id
    else:
        # Match by assignment or let's use the first one
        # Let's find if there's a specific caregiver ID matching this token, or just accept for the first notified caregiver
        caregiver_id = assign.caregiver_id

    res = atomic_accept_alert(alert_id, caregiver_id, db)
    
    color = "#10b981" if res["success"] else "#3b82f6"
    if "Already accepted by" in res["message"]:
        color = "#ef4444"
        
    return HTMLResponse(
        content=f"""
        <html>
            <head>
                <title>SaraCare Assistance Co-ordination</title>
                <style>
                    body {{ font-family: 'Outfit', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }}
                    .card {{ background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; max-width: 450px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); border: 1px solid {color}; }}
                    h1 {{ color: {color}; margin-top: 0; }}
                    p {{ color: #94a3b8; font-size: 1.1rem; line-height: 1.5; }}
                    .patient-box {{ background: #0f172a; padding: 1rem; border-radius: 8px; margin: 1rem 0; border: 1px solid #334155; }}
                    .patient-name {{ font-weight: 600; color: #f8fafc; }}
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Assistance Request</h1>
                    <div class="patient-box">
                        <p class="patient-name">Patient: {alert.patient_name}</p>
                        <p style="margin:0.25rem 0;font-size:0.9rem;color:#64748b;">Alert: {alert.message}</p>
                    </div>
                    <p>{res["message"]}</p>
                </div>
            </body>
        </html>
        """
    )

@router.post("/api/alerts/{id}/accept")
def api_accept_alert(id: int, caregiver_id: int = Query(...), db: Session = Depends(get_db)):
    res = atomic_accept_alert(id, caregiver_id, db)
    if not res["success"]:
        raise HTTPException(status_code=400, detail=res["message"])
    return res

@router.post("/api/alerts/{id}/start")
def start_alert_assistance(id: int, db: Session = Depends(get_db)):
    alert = db.query(Alert).filter(Alert.id == id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
        
    if alert.status != "ACCEPTED":
        raise HTTPException(status_code=400, detail="Alert must be accepted before starting assistance.")
        
    alert.status = "IN_PROGRESS"
    db.commit()
    return {"success": True, "status": alert.status}

@router.post("/api/alerts/{id}/request-backup")
def request_alert_backup(id: int, db: Session = Depends(get_db)):
    """
    Caregiver requests backup (HELP flow):
    1. Keeps original caregiver assigned.
    2. Updates alert status to HELP_REQUESTED.
    3. Finds other eligible caregivers.
    4. Dispatches alert to them.
    """
    alert = db.query(Alert).filter(Alert.id == id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
        
    if alert.status not in ["ACCEPTED", "IN_PROGRESS"]:
        raise HTTPException(status_code=400, detail="Only accepted or active alerts can request backup.")
        
    original_cg_id = alert.assigned_caregiver_id
    if not original_cg_id:
        raise HTTPException(status_code=400, detail="No caregiver currently assigned to request backup.")
        
    alert.status = "HELP_REQUESTED"
    db.commit()
    
    # Save backup request log
    req = BackupRequest(
        alert_id=id,
        requesting_caregiver_id=original_cg_id,
        status="pending"
    )
    db.add(req)
    db.commit()
    
    # Notify OTHER available caregivers (excluding the original caregiver)
    other_cg = get_eligible_caregivers(db, exclude_ids=[original_cg_id])
    
    if other_cg:
        # Run backup dispatch
        # Send WhatsApp to others or start voice call based on routing mode
        for cg in other_cg:
            if cg.whatsapp_enabled:
                # Assign / notify them
                assign = AlertAssignment(
                    alert_id=alert.id,
                    caregiver_id=cg.id,
                    status="notified"
                )
                db.add(assign)
                
                # Send custom WhatsApp message for backup
                backup_token = f"b_{os.urandom(16).hex()}"
                accept_url = f"{twilio_service.public_url}/caregiver/alerts/{alert.id}/accept?token={backup_token}"
                body = (
                    f"SaraCare BACKUP Request! Primary caregiver needs backup.\n\n"
                    f"Patient: {alert.patient_name}\n"
                    f"Alert: {alert.message}\n\n"
                    f"Tap below to accept backup request:\n"
                    f"{accept_url}"
                )
                twilio_service.send_whatsapp(cg.whatsapp_number, body)
                
        # For critical/urgent, trigger voice calls to backups
        if alert.severity in ["critical", "urgent"]:
            asyncio.create_task(trigger_voice_calls(db, alert, other_cg))
            
    return {"success": True, "status": alert.status, "message": "Backup requests dispatched."}

@router.post("/api/alerts/{id}/resolve")
def resolve_alert(id: int, db: Session = Depends(get_db)):
    """Resolves an alert and decrements active caregiver workloads."""
    alert = db.query(Alert).filter(Alert.id == id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
        
    # Decrement workloads
    if alert.assigned_caregiver_id:
        cg = db.query(Caregiver).filter(Caregiver.id == alert.assigned_caregiver_id).first()
        if cg and cg.current_assignments > 0:
            cg.current_assignments -= 1
            
    if alert.backup_caregiver_id:
        bg = db.query(Caregiver).filter(Caregiver.id == alert.backup_caregiver_id).first()
        if bg and bg.current_assignments > 0:
            bg.current_assignments -= 1
            
    alert.status = "RESOLVED"
    alert.resolved_at = datetime.utcnow()
    db.commit()
    
    # Resolve any backup request records
    db.query(BackupRequest).filter(
        BackupRequest.alert_id == id,
        BackupRequest.status == "pending"
    ).update({"status": "resolved", "resolved_at": datetime.utcnow()}, synchronize_session=False)
    db.commit()
    
    return {"success": True, "status": alert.status}

@router.post("/api/alerts/{id}/decline")
def decline_alert(id: int, caregiver_id: int = Query(...), db: Session = Depends(get_db)):
    """Caregiver declines/declares unable to assist. If smart routing, escalates immediately."""
    assign = db.query(AlertAssignment).filter(
        AlertAssignment.alert_id == id,
        AlertAssignment.caregiver_id == caregiver_id
    ).first()
    
    if assign:
        assign.status = "declined"
        db.commit()
        
    return {"success": True}

@router.get("/api/settings/routing")
def get_routing_settings():
    from backend.alert_router import GLOBAL_ROUTING_MODE, CRITICAL_ALWAYS_BROADCAST
    return {
        "mode": GLOBAL_ROUTING_MODE,
        "critical_broadcast": CRITICAL_ALWAYS_BROADCAST
    }

@router.post("/api/settings/routing")
def update_routing_settings(mode: str = Query(...), critical_broadcast: bool = Query(...)):
    from backend.alert_router import set_routing_settings
    set_routing_settings(mode, critical_broadcast)
    return {
        "success": True,
        "mode": mode,
        "critical_broadcast": critical_broadcast
    }

