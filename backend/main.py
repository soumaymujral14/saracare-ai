import os
import asyncio
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv
from sqlalchemy.orm import Session

# Load dot-env variables from .env
load_dotenv()

# Initialize FastAPI
app = FastAPI(title="SaraCare AI Patient Safety Monitor API")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for stop request (preserved for backward compatibility)
stop_request_status = {
    "patient_name": "",
    "approved": False,
    "timestamp": None
}

# Import database layer and init
from backend.database import init_db, get_db, Alert, Patient, Caregiver
from backend.twilio_service import twilio_service
from backend.alert_router import dispatch_alert

# Import Routers
from backend.caregivers import router as caregivers_router
from backend.medicines import router as medicines_router, check_medicine_reminders
from backend.alerts import router as alerts_router
from backend.calls import router as calls_router
from backend.providers import router as providers_router

# Include Routers
app.include_router(caregivers_router)
app.include_router(medicines_router)
app.include_router(alerts_router)
app.include_router(calls_router)
app.include_router(providers_router)

# Background scheduler loop
async def medicine_scheduler_loop():
    """
    Background loop that runs every 30 seconds to check for medicine schedules.
    NOTE: Render Free tier may sleep or spin down if inactive, meaning
    this scheduler loop won't run while the server is asleep. For production,
    schedule this check via an external HTTP CRON service calling:
    POST /api/medicines/trigger (or trigger via Cloud Run Job / Google Cloud Scheduler).
    """
    print("Medicine scheduler background task loop started.")
    while True:
        try:
            from backend.database import SessionLocal
            db = SessionLocal()
            try:
                check_medicine_reminders(db)
            finally:
                db.close()
        except Exception as e:
            print(f"Error in medicine scheduler: {e}")
        await asyncio.sleep(30)

@app.on_event("startup")
async def startup_event():
    # Setup tables and default patient
    init_db()
    # Start internal scheduler loop in the background
    asyncio.create_task(medicine_scheduler_loop())

class AlertPayload(BaseModel):
    patient_name: str
    alert_type: str  # fall | risky_movement | frame_exit | medicine | voice_help | emergency
    severity: str    # routine | urgent | critical
    message: str

class MockCallPayload(BaseModel):
    caregiver_name: Optional[str] = None
    caregiver_phone: Optional[str] = None
    message: str

class StopRequestPayload(BaseModel):
    patient_name: str
    caregiver_name: str
    caregiver_whatsapp: str

class StopApprovalPayload(BaseModel):
    patient_name: str
    approved_by: str

@app.get("/health")
def get_health():
    return {
        "status": "ok",
        "app": "SaraCare"
    }

@app.get("/whatsapp-status")
def get_whatsapp_status():
    """Legacy endpoint preserved for status panel checks."""
    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_NUMBER")
    to_whatsapp = os.getenv("CAREGIVER_WHATSAPP")
    configured = bool(account_sid and auth_token and from_whatsapp and to_whatsapp)
    return {
        "configured": configured,
        "twilio_account_sid_present": bool(account_sid),
        "twilio_auth_token_present": bool(auth_token),
        "twilio_whatsapp_number_present": bool(from_whatsapp),
        "caregiver_whatsapp_present": bool(to_whatsapp)
    }

@app.post("/alert")
def create_alert_legacy(payload: AlertPayload, db: Session = Depends(get_db)):
    """Legacy alert endpoint mapped to SQLAlchemy DB and coordination routing."""
    alert = Alert(
        patient_name=payload.patient_name,
        alert_type=payload.alert_type,
        severity=payload.severity,
        message=payload.message,
        source="camera_vision",
        status="OPEN"
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    
    # Route alert to caregivers
    dispatch_alert(alert, db)
    
    # Check Twilio delivery status for immediate response compatibility
    mode = twilio_service.get_status()["mode"]
    whatsapp_status = "mock_whatsapp_sent" if mode == "mock" else "whatsapp_sent"
    
    return {
        "success": True,
        "alert": {
            "timestamp": alert.created_at.isoformat(),
            "patient_name": alert.patient_name,
            "alert_type": alert.alert_type,
            "severity": alert.severity,
            "message": alert.message
        },
        "whatsapp_status": whatsapp_status
    }

@app.get("/alerts")
def get_alerts_legacy(db: Session = Depends(get_db)):
    """Legacy alerts endpoint mapped to DB. Returns alerts sorted by latest first."""
    alerts = db.query(Alert).order_by(Alert.created_at.desc()).all()
    res = []
    for a in alerts:
        res.append({
            "timestamp": a.created_at.isoformat(),
            "patient_name": a.patient_name,
            "alert_type": a.alert_type,
            "severity": a.severity,
            "message": a.message
        })
    return res

@app.post("/mock-call")
def mock_call(payload: MockCallPayload):
    return {
        "success": True,
        "action": "mock_call_started",
        "message": f"Calling caregiver {payload.caregiver_name or ''} ({payload.caregiver_phone or ''}). Alert: {payload.message}"
    }

@app.post("/trugen-alert")
def trugen_alert(payload: AlertPayload, db: Session = Depends(get_db)):
    """TruGen webhook endpoint. Saves to database and dispatches caregiver route."""
    alert = Alert(
        patient_name=payload.patient_name,
        alert_type=payload.alert_type,
        severity=payload.severity,
        message=payload.message + " (via TruGen AI Webhook)",
        source="trugen",
        status="OPEN"
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    
    # Route alert
    dispatch_alert(alert, db)
    
    mode = twilio_service.get_status()["mode"]
    whatsapp_status = "mock_whatsapp_sent" if mode == "mock" else "whatsapp_sent"
    
    return {
        "success": True,
        "action": "caregiver_alert_triggered",
        "spoken_message": "Caregiver has been alerted.",
        "whatsapp_status": whatsapp_status
    }

@app.post("/request-stop-monitoring")
def request_stop_monitoring(payload: StopRequestPayload, db: Session = Depends(get_db)):
    stop_request_status["patient_name"] = payload.patient_name
    stop_request_status["approved"] = False
    stop_request_status["timestamp"] = datetime.now().isoformat()
    
    message_body = f"{payload.patient_name} requested to stop monitoring. Caregiver approval required."
    
    # Log alert event
    alert = Alert(
        patient_name=payload.patient_name,
        alert_type="stop_monitoring_requested",
        severity="routine",
        message=message_body,
        source="manual",
        status="OPEN"
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    
    # Route alert
    dispatch_alert(alert, db)
    
    mode = twilio_service.get_status()["mode"]
    whatsapp_status = "mock_whatsapp_sent" if mode == "mock" else "whatsapp_sent"
    
    return {
        "success": True,
        "status": "approval_pending",
        "whatsapp_status": whatsapp_status,
        "message": "Caregiver approval request sent."
    }

@app.post("/approve-stop-monitoring")
def approve_stop_monitoring(payload: StopApprovalPayload, db: Session = Depends(get_db)):
    stop_request_status["approved"] = True
    
    # Log approval event
    alert = Alert(
        patient_name=payload.patient_name,
        alert_type="stop_monitoring_approved",
        severity="routine",
        message=f"Caregiver {payload.approved_by} approved monitoring stop.",
        source="manual",
        status="RESOLVED",
        resolved_at=datetime.utcnow()
    )
    db.add(alert)
    db.commit()
    
    return {
        "success": True,
        "status": "approved",
        "message": "Stop monitoring approved by caregiver."
    }

# Serving the static frontend
current_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.join(os.path.dirname(current_dir), "frontend")

if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
else:
    print(f"Warning: Frontend directory not found at {frontend_dir}. Cannot serve static files.")
