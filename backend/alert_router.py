import asyncio
from datetime import datetime, timedelta
import logging
from sqlalchemy.orm import Session
from sqlalchemy import or_

from backend.database import SessionLocal, Alert, Caregiver, AlertAssignment, AlertDelivery, CallAttempt, Patient
from backend.twilio_service import twilio_service

logger = logging.getLogger("AlertRouter")

# Get settings (could be in DB, let's query patient or default)
GLOBAL_ROUTING_MODE = "broadcast"  # broadcast or smart
CRITICAL_ALWAYS_BROADCAST = True
ESCALATION_DELAY_SECONDS = 30 # Default delay before smart-routing next candidate or voice calling

def safe_create_task(coro):
    """Safely handles asyncio tasks in both async environments and synchronous tests."""
    try:
        loop = asyncio.get_running_loop()
        return loop.create_task(coro)
    except RuntimeError:
        return asyncio.run(coro)


def set_routing_settings(mode: str, critical_broadcast: bool):
    global GLOBAL_ROUTING_MODE, CRITICAL_ALWAYS_BROADCAST
    GLOBAL_ROUTING_MODE = mode
    CRITICAL_ALWAYS_BROADCAST = critical_broadcast

def score_caregiver(cg: Caregiver, db: Session) -> float:
    """
    Scores caregivers for Smart Duty Routing:
    - Base score is 100.
    - Priority: priority 1 is best. Deduct (priority - 1) * 10.
    - Workload: Deduct active assignments * 20.
    - Availability: Must be available (pre-filtered).
    - Rotation: Deduct 25 if they had an assignment in the last 15 minutes.
    """
    score = 100.0
    
    # Priority penalty (lower priority number is better)
    priority = cg.priority or 1
    score -= (priority - 1) * 10
    
    # Active assignments penalty
    score -= cg.current_assignments * 20
    
    # Rotation check
    fifteen_mins_ago = datetime.utcnow() - timedelta(minutes=15)
    recent_assign = db.query(AlertAssignment).filter(
        AlertAssignment.caregiver_id == cg.id,
        AlertAssignment.assigned_at >= fifteen_mins_ago
    ).first()
    
    if recent_assign:
        score -= 25.0
        
    return score

def get_eligible_caregivers(db: Session, exclude_ids: list = None) -> list:
    """Returns verified and available caregivers, sorted by smart score desc."""
    if exclude_ids is None:
        exclude_ids = []
        
    query = db.query(Caregiver).filter(
        Caregiver.active == True,
        Caregiver.verified == True,
        Caregiver.availability == "available"
    )
    if exclude_ids:
        query = query.filter(Caregiver.id.not_in(exclude_ids))
        
    caregivers = query.all()
    
    # Score and sort
    scored = [(cg, score_caregiver(cg, db)) for cg in caregivers]
    scored.sort(key=lambda x: x[1], reverse=True)
    
    return [item[0] for item in scored]

def dispatch_alert(alert: Alert, db: Session):
    """
    Routes alerts when created:
    1. Update status to NOTIFYING or OPEN.
    2. Start async task to handle escalation (WhatsApp/Voice).
    """
    alert.status = "NOTIFYING"
    db.commit()
    
    # Use asyncio to run the escalation task in the background
    safe_create_task(run_alert_escalation_loop(alert.id))

async def run_alert_escalation_loop(alert_id: int):
    """
    Handles escalation lifecycle:
    - Smart routing next-candidate delay.
    - Voice call escalation for critical/urgent alerts.
    - Verification state polling.
    """
    # Create isolated DB session for background task
    db = SessionLocal()
    try:
        alert = db.query(Alert).filter(Alert.id == alert_id).first()
        if not alert:
            return
            
        routing_mode = alert.routing_mode or GLOBAL_ROUTING_MODE
        
        # Check if critical alerts always broadcast
        if alert.severity == "critical" and CRITICAL_ALWAYS_BROADCAST:
            routing_mode = "broadcast"
            
        alert.routing_mode = routing_mode
        db.commit()
        
        # Track caregivers already notified to prevent duplicates
        notified_caregiver_ids = []
        
        if routing_mode == "broadcast":
            # Broadcast to all available
            caregivers = get_eligible_caregivers(db)
            if not caregivers:
                logger.warning("No eligible caregivers available for broadcast alert %s", alert_id)
                return
                
            for cg in caregivers:
                if cg.whatsapp_enabled:
                    send_whatsapp_alert_delivery(db, alert, cg)
                    notified_caregiver_ids.append(cg.id)
            
            # For critical alerts: call immediately
            if alert.severity == "critical":
                await trigger_voice_calls(db, alert, caregivers)
            # For urgent alerts: wait then call if not accepted
            elif alert.severity == "urgent":
                await asyncio.sleep(ESCALATION_DELAY_SECONDS)
                # Refresh alert
                db.refresh(alert)
                if alert.status in ["NOTIFYING", "OPEN"]:
                    await trigger_voice_calls(db, alert, caregivers)
                    
        else: # Smart routing
            # Get best candidate
            caregivers = get_eligible_caregivers(db)
            if not caregivers:
                logger.warning("No eligible caregivers available for smart route alert %s", alert_id)
                return
                
            # If critical: broadcast/call immediately
            if alert.severity == "critical":
                # Fall back to immediate broadcast + call
                for cg in caregivers:
                    if cg.whatsapp_enabled:
                        send_whatsapp_alert_delivery(db, alert, cg)
                await trigger_voice_calls(db, alert, caregivers)
                return
                
            # Smart sequential escalation
            for idx, cg in enumerate(caregivers):
                # Check if alert already accepted
                db.refresh(alert)
                if alert.status not in ["NOTIFYING", "OPEN"]:
                    break
                    
                # Assign to current caregiver
                if cg.whatsapp_enabled:
                    send_whatsapp_alert_delivery(db, alert, cg)
                    notified_caregiver_ids.append(cg.id)
                    
                # For urgent: call current caregiver as well
                if alert.severity == "urgent" and cg.calls_enabled:
                    # Wait slightly or call
                    trigger_single_voice_call(db, alert, cg)
                    
                # Wait for accept
                await asyncio.sleep(ESCALATION_DELAY_SECONDS)
                
                # Check status
                db.refresh(alert)
                if alert.status not in ["NOTIFYING", "OPEN"]:
                    break
                    
            # If still not accepted and we ran out of available candidates, try all backup calls
            db.refresh(alert)
            if alert.status in ["NOTIFYING", "OPEN"] and alert.severity in ["urgent", "critical"]:
                # Broadcast call to all notified
                still_pending_caregivers = db.query(Caregiver).filter(
                    Caregiver.id.in_(notified_caregiver_ids),
                    Caregiver.calls_enabled == True
                ).all()
                await trigger_voice_calls(db, alert, still_pending_caregivers)
                
    except Exception as e:
        logger.exception("Error in alert escalation loop: %s", e)
    finally:
        db.close()

def send_whatsapp_alert_delivery(db: Session, alert: Alert, cg: Caregiver):
    """Helper to register assignment and send WhatsApp."""
    # Register assignment
    assign = AlertAssignment(
        alert_id=alert.id,
        caregiver_id=cg.id,
        status="notified"
    )
    db.add(assign)
    db.commit()
    
    # Generate delivery secure token
    # We use a random delivery token
    delivery_token = secrets_token = f"d_{os.urandom(16).hex()}"
    
    # Save delivery log
    delivery = AlertDelivery(
        alert_id=alert.id,
        caregiver_id=cg.id,
        channel="whatsapp",
        status="sending"
    )
    db.add(delivery)
    db.commit()
    
    # Send via Twilio
    res = twilio_service.send_alert(
        to_number=cg.whatsapp_number,
        patient_name=alert.patient_name,
        alert_type=alert.alert_type,
        severity=alert.severity,
        message=alert.message,
        alert_id=alert.id,
        delivery_token=delivery_token
    )
    
    # Update delivery
    delivery.status = res["status"]
    delivery.sid = res["sid"]
    delivery.error_code = res["error_code"]
    delivery.error_message = res["error_message"]
    db.commit()

async def trigger_voice_calls(db: Session, alert: Alert, caregivers: list):
    """Triggers voice call attempts sequentially for multiple caregivers."""
    for cg in caregivers:
        if not cg.calls_enabled:
            continue
            
        db.refresh(alert)
        if alert.status not in ["NOTIFYING", "OPEN"]:
            break
            
        trigger_single_voice_call(db, alert, cg)
        # Wait small gap between triggers (e.g. 5 seconds) to avoid spamming Twilio all at once
        await asyncio.sleep(5)

def trigger_single_voice_call(db: Session, alert: Alert, cg: Caregiver):
    """Executes a single Twilio voice call and logs details."""
    # Check if already calling this caregiver for this alert
    existing = db.query(CallAttempt).filter(
        CallAttempt.alert_id == alert.id,
        CallAttempt.caregiver_id == cg.id
    ).first()
    if existing:
        return
        
    attempt = CallAttempt(
        alert_id=alert.id,
        caregiver_id=cg.id,
        status="queued"
    )
    db.add(attempt)
    db.commit()
    
    res = twilio_service.start_voice_call(
        to_number=cg.calling_number,
        alert_id=alert.id,
        caregiver_id=cg.id,
        patient_name=alert.patient_name,
        message=alert.message
    )
    
    attempt.status = res["status"]
    attempt.call_sid = res["sid"]
    attempt.failure_reason = res["error_message"]
    db.commit()

# Atomic First Accept Logic
def atomic_accept_alert(alert_id: int, caregiver_id: int, db: Session) -> dict:
    """
    Performs concurrency-safe atomic update to assign caregiver to an alert.
    Uses SQLAlchemy ORM update query with status condition to prevent race conditions.
    """
    cg = db.query(Caregiver).filter(Caregiver.id == caregiver_id).first()
    if not cg:
        return {"success": False, "message": "Caregiver not found."}
        
    # Atomic conditional update
    result = db.query(Alert).filter(
        Alert.id == alert_id,
        Alert.status.in_(["OPEN", "NOTIFYING", "HELP_REQUESTED"])
    ).update(
        {
            "status": "ACCEPTED",
            "assigned_caregiver_id": caregiver_id,
            "accepted_at": datetime.utcnow()
        },
        synchronize_session=False
    )
    db.commit()
    
    if result == 1:
        # Caregiver won the race! Update caregiver assignments
        cg.current_assignments += 1
        db.commit()
        
        # Notify other caregivers about stand down
        safe_create_task(notify_others_stand_down(alert_id, caregiver_id))
        
        return {"success": True, "message": f"You have accepted this request. Please assist the patient."}
    else:
        # Check who already accepted
        alert = db.query(Alert).filter(Alert.id == alert_id).first()
        if not alert:
            return {"success": False, "message": "Alert not found."}
            
        if alert.assigned_caregiver_id == caregiver_id:
            return {"success": True, "message": "You have already accepted this request."}
            
        acceptor_name = "another caregiver"
        if alert.assigned_caregiver_id:
            acceptor = db.query(Caregiver).filter(Caregiver.id == alert.assigned_caregiver_id).first()
            if acceptor:
                acceptor_name = acceptor.name
                
        return {"success": False, "message": f"This request has already been accepted by {acceptor_name}."}

async def notify_others_stand_down(alert_id: int, accepted_cg_id: int):
    """Notifies other caregivers that the alert has been resolved/accepted."""
    db = SessionLocal()
    try:
        alert = db.query(Alert).filter(Alert.id == alert_id).first()
        acceptor = db.query(Caregiver).filter(Caregiver.id == accepted_cg_id).first()
        if not alert or not acceptor:
            return
            
        # Get all caregivers who were assigned/notified except the acceptor
        assignments = db.query(AlertAssignment).filter(
            AlertAssignment.alert_id == alert_id,
            AlertAssignment.caregiver_id != accepted_cg_id
        ).all()
        
        for assign in assignments:
            cg = db.query(Caregiver).filter(Caregiver.id == assign.caregiver_id).first()
            if cg and cg.whatsapp_enabled:
                msg = f"{acceptor.name} has accepted the alert '{alert.message}'. No further action is required."
                twilio_service.send_status_update(cg.whatsapp_number, alert.message, acceptor.name, msg)
                
                # Update assignment status
                assign.status = "dismissed"
                db.commit()
    except Exception as e:
        logger.exception("Error sending stand down: %s", e)
    finally:
        db.close()
