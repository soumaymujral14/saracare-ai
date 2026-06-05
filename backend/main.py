import os
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

# Load dot-env variables from .env
load_dotenv()

app = FastAPI(title="SaraCare AI Patient Safety Monitor API")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for the hackathon MVP
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for alerts
alerts_db = []

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

# In-memory store for stop request
stop_request_status = {
    "patient_name": "",
    "approved": False,
    "timestamp": None
}

# Helper to verify if WhatsApp alert should be sent
def should_trigger_whatsapp(alert_type: str, severity: str) -> bool:
    if severity in ["urgent", "critical"]:
        return True
    if alert_type in ["stop_monitoring_requested", "emergency"]:
        return True
    return False

# Function to execute Twilio WhatsApp alerts
def send_whatsapp_alert(patient_name: str, alert_type: str, severity: str, message: str) -> dict:
    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_NUMBER")
    to_whatsapp = os.getenv("CAREGIVER_WHATSAPP")
    
    if account_sid and auth_token and from_whatsapp and to_whatsapp:
        try:
            from twilio.rest import Client
            
            from_whatsapp_formatted = from_whatsapp if from_whatsapp.startswith("whatsapp:") else f"whatsapp:{from_whatsapp}"
            recipient_formatted = to_whatsapp if to_whatsapp.startswith("whatsapp:") else f"whatsapp:{to_whatsapp}"
            
            body = f"SaraCare Alert: {severity.upper()} - {alert_type} for {patient_name}. {message}"
            
            client = Client(account_sid, auth_token)
            sent_msg = client.messages.create(
                body=body,
                from_=from_whatsapp_formatted,
                to=recipient_formatted
            )
            return {
                "whatsapp_status": "real_whatsapp_sent",
                "whatsapp_sid": sent_msg.sid
            }
        except Exception as e:
            # Print only in backend console, not UI
            print(f"Twilio API Error details: {e}")
            return {
                "whatsapp_status": "mock_whatsapp_sent"
            }
    else:
        print("Twilio environmental variables missing. Falling back to Mock WhatsApp Alert.")
        return {
            "whatsapp_status": "mock_whatsapp_sent"
        }

@app.get("/health")
def get_health():
    return {
        "status": "ok",
        "app": "SaraCare"
    }

@app.get("/whatsapp-status")
def get_whatsapp_status():
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
def create_alert(payload: AlertPayload):
    new_alert = {
        "timestamp": datetime.now().isoformat(),
        "patient_name": payload.patient_name,
        "alert_type": payload.alert_type,
        "severity": payload.severity,
        "message": payload.message
    }
    alerts_db.append(new_alert)
    
    # Process WhatsApp alert
    whatsapp_info = {"whatsapp_status": "mock_whatsapp_sent"}
    if should_trigger_whatsapp(payload.alert_type, payload.severity):
        whatsapp_info = send_whatsapp_alert(
            patient_name=payload.patient_name,
            alert_type=payload.alert_type,
            severity=payload.severity,
            message=payload.message
        )
        
    return {
        "success": True,
        "alert": new_alert,
        **whatsapp_info
    }

@app.get("/alerts")
def get_alerts():
    # Return alerts sorted by latest first
    return sorted(alerts_db, key=lambda x: x["timestamp"], reverse=True)

@app.post("/mock-call")
def mock_call(payload: MockCallPayload):
    return {
        "success": True,
        "action": "mock_call_started",
        "message": f"Calling caregiver {payload.caregiver_name or ''} ({payload.caregiver_phone or ''}). Alert: {payload.message}"
    }

@app.post("/trugen-alert")
def trugen_alert(payload: AlertPayload):
    new_alert = {
        "timestamp": datetime.now().isoformat(),
        "patient_name": payload.patient_name,
        "alert_type": payload.alert_type,
        "severity": payload.severity,
        "message": payload.message + " (via TruGen AI Webhook)"
    }
    alerts_db.append(new_alert)
    
    # Process WhatsApp alert
    whatsapp_info = {"whatsapp_status": "mock_whatsapp_sent"}
    if should_trigger_whatsapp(payload.alert_type, payload.severity):
        whatsapp_info = send_whatsapp_alert(
            patient_name=payload.patient_name,
            alert_type=payload.alert_type,
            severity=payload.severity,
            message=payload.message + " (via TruGen AI Webhook)"
        )
        
    return {
        "success": True,
        "action": "caregiver_alert_triggered",
        "spoken_message": "Caregiver has been alerted.",
        **whatsapp_info
    }

@app.post("/request-stop-monitoring")
def request_stop_monitoring(payload: StopRequestPayload):
    stop_request_status["patient_name"] = payload.patient_name
    stop_request_status["approved"] = False
    stop_request_status["timestamp"] = datetime.now().isoformat()
    
    # Log alert event
    message_body = f"{payload.patient_name} requested to stop monitoring. Caregiver approval required."
    new_alert = {
        "timestamp": datetime.now().isoformat(),
        "patient_name": payload.patient_name,
        "alert_type": "stop_monitoring_requested",
        "severity": "routine",
        "message": message_body
    }
    alerts_db.append(new_alert)
    
    # Trigger real or mock WhatsApp
    whatsapp_info = send_whatsapp_alert(
        patient_name=payload.patient_name,
        alert_type="stop_monitoring_requested",
        severity="routine",
        message=message_body
    )
    
    return {
        "success": True,
        "status": "approval_pending",
        **whatsapp_info,
        "message": "Caregiver approval request sent."
    }

@app.post("/approve-stop-monitoring")
def approve_stop_monitoring(payload: StopApprovalPayload):
    stop_request_status["approved"] = True
    
    # Log approval event
    new_alert = {
        "timestamp": datetime.now().isoformat(),
        "patient_name": payload.patient_name,
        "alert_type": "stop_monitoring_approved",
        "severity": "routine",
        "message": "Caregiver approved monitoring stop."
    }
    alerts_db.append(new_alert)
    
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
