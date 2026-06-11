from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Form
from fastapi.responses import Response
from sqlalchemy.orm import Session
import logging

from backend.database import get_db, Alert, Caregiver, CallAttempt
from backend.alert_router import atomic_accept_alert

logger = logging.getLogger("VoiceCalls")
router = APIRouter()

@router.post("/api/calls/voice")
def voice_webhook(alert_id: int = Query(...), caregiver_id: int = Query(...), db: Session = Depends(get_db)):
    """
    Twilio voice webhook. Generates TwiML to announce the alert and prompt
    the caregiver to press 1 to accept.
    """
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    cg = db.query(Caregiver).filter(Caregiver.id == caregiver_id).first()
    
    patient_name = alert.patient_name if alert else "Eleanor Vance"
    alert_msg = alert.message if alert else "Urgent patient assistance requested."
    
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather numDigits="1" action="/api/calls/accept?alert_id={alert_id}&amp;caregiver_id={caregiver_id}" method="POST" timeout="10">
        <Say voice="alice">This is a SaraCare urgent alert for {patient_name}. {alert_msg}. Press 1 to accept assistance.</Say>
    </Gather>
    <Say voice="alice">We did not receive any input. Goodbye.</Say>
    <Hangup/>
</Response>"""
    
    # Update CallAttempt status to calling/ringing in database
    attempt = db.query(CallAttempt).filter(
        CallAttempt.alert_id == alert_id,
        CallAttempt.caregiver_id == caregiver_id
    ).first()
    if attempt:
        attempt.status = "ringing"
        db.commit()
        
    return Response(content=twiml, media_type="application/xml")

@router.post("/api/calls/accept")
def voice_accept_webhook(
    alert_id: int = Query(...),
    caregiver_id: int = Query(...),
    Digits: str = Form(None),
    db: Session = Depends(get_db)
):
    """
    Twilio voice gather callback. Processes the caregiver's DTMF selection.
    If '1' is pressed, atomic first-accept coordination is executed.
    """
    logger.info("Voice call accept callback. Alert: %s, Caregiver: %s, Digit: %s", alert_id, caregiver_id, Digits)
    
    attempt = db.query(CallAttempt).filter(
        CallAttempt.alert_id == alert_id,
        CallAttempt.caregiver_id == caregiver_id
    ).first()
    
    if Digits == "1":
        # Atomic first-accept coordination
        res = atomic_accept_alert(alert_id, caregiver_id, db)
        
        if res["success"]:
            # Update CallAttempt log
            if attempt:
                attempt.status = "accepted"
                attempt.answered_at = datetime.utcnow()
                attempt.accepted_from_call = True
                db.commit()
                
            twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. You have accepted this request. Please assist the patient immediately. Goodbye.</Say>
    <Hangup/>
</Response>"""
        else:
            if attempt:
                attempt.status = "answered"
                attempt.answered_at = datetime.utcnow()
                db.commit()
                
            twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">This request has already been accepted by another caregiver. Thank you, goodbye.</Say>
    <Hangup/>
</Response>"""
    else:
        twiml = """<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Invalid option selected. Goodbye.</Say>
    <Hangup/>
</Response>"""
        
    return Response(content=twiml, media_type="application/xml")

@router.post("/api/calls/status")
def voice_status_callback(
    CallSid: str = Form(None),
    CallStatus: str = Form(None),
    SequenceNumber: str = Form(None),
    db: Session = Depends(get_db)
):
    """
    Twilio voice call status callback. Keeps database records synchronized
    with real-world telephony status (busy, completed, failed, no-answer).
    """
    logger.info("Voice status callback. Sid: %s, Status: %s", CallSid, CallStatus)
    
    attempt = db.query(CallAttempt).filter(CallAttempt.call_sid == CallSid).first()
    if attempt:
        # Map Twilio call statuses to our log formats
        attempt.status = CallStatus
        if CallStatus in ["busy", "failed", "no-answer"]:
            attempt.failure_reason = f"Twilio status: {CallStatus}"
        elif CallStatus == "completed" and attempt.status != "accepted":
            attempt.status = "completed"
            
        db.commit()
        
    return {"status": "ok"}
