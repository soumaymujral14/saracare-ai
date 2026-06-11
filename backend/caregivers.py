import secrets
import hashlib
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database import get_db, Caregiver, CaregiverVerification, Patient
from backend.twilio_service import twilio_service

router = APIRouter()

# Masking helper
def mask_phone(num: str) -> str:
    if not num:
        return ""
    num = num.strip()
    if len(num) <= 7:
        return "****" + num[-2:]
    return num[:3] + "*" * (len(num) - 7) + num[-4:]

# Helper to normalize numbers
def normalize_phone(num: str) -> str:
    # Retain only digits and '+'
    clean = "".join(c for c in num if c.isdigit() or c == "+")
    if not clean.startswith("+"):
        # Default to + if missing, assuming international format starts with country code
        clean = "+" + clean
    return clean

# Schemas
class CaregiverCreate(BaseModel):
    name: str = Field(..., min_length=1)
    whatsapp_number: str = Field(..., min_length=5)
    calling_number: Optional[str] = None
    role: Optional[str] = None
    priority: int = 1
    availability: str = "available" # available, busy, off_duty
    whatsapp_enabled: bool = True
    calls_enabled: bool = True

class CaregiverResponse(BaseModel):
    id: int
    name: str
    whatsapp_number_masked: str
    calling_number_masked: str
    role: Optional[str]
    priority: int
    availability: str
    whatsapp_enabled: bool
    calls_enabled: bool
    verified: bool
    verification_status: str
    active: bool
    current_assignments: int
    created_at: datetime
    verified_at: Optional[datetime]

    class Config:
        orm_mode = True

@router.get("/api/caregivers", response_model=List[CaregiverResponse])
def get_caregivers(db: Session = Depends(get_db)):
    caregivers = db.query(Caregiver).filter(Caregiver.active == True).all()
    res = []
    for c in caregivers:
        # Mask numbers for security
        whatsapp_masked = mask_phone(c.whatsapp_number)
        calling_masked = mask_phone(c.calling_number)
        
        res.append(CaregiverResponse(
            id=c.id,
            name=c.name,
            whatsapp_number_masked=whatsapp_masked,
            calling_number_masked=calling_masked,
            role=c.role,
            priority=c.priority,
            availability=c.availability,
            whatsapp_enabled=c.whatsapp_enabled,
            calls_enabled=c.calls_enabled,
            verified=c.verified,
            verification_status=c.verification_status,
            active=c.active,
            current_assignments=c.current_assignments,
            created_at=c.created_at,
            verified_at=c.verified_at
        ))
    return res

@router.post("/api/caregivers", response_model=CaregiverResponse)
def create_caregiver(payload: CaregiverCreate, db: Session = Depends(get_db)):
    whatsapp_norm = normalize_phone(payload.whatsapp_number)
    calling_norm = normalize_phone(payload.calling_number) if payload.calling_number else whatsapp_norm
    
    # Check if number already registered
    existing = db.query(Caregiver).filter(Caregiver.whatsapp_number == whatsapp_norm, Caregiver.active == True).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Caregiver with this WhatsApp number already exists."
        )
    
    cg = Caregiver(
        name=payload.name,
        whatsapp_number=whatsapp_norm,
        calling_number=calling_norm,
        role=payload.role,
        priority=payload.priority,
        availability=payload.availability,
        whatsapp_enabled=payload.whatsapp_enabled,
        calls_enabled=payload.calls_enabled,
        verified=False,
        verification_status="unverified",
        active=True,
        current_assignments=0
    )
    db.add(cg)
    db.commit()
    db.refresh(cg)
    
    return CaregiverResponse(
        id=cg.id,
        name=cg.name,
        whatsapp_number_masked=mask_phone(cg.whatsapp_number),
        calling_number_masked=mask_phone(cg.calling_number),
        role=cg.role,
        priority=cg.priority,
        availability=cg.availability,
        whatsapp_enabled=cg.whatsapp_enabled,
        calls_enabled=cg.calls_enabled,
        verified=cg.verified,
        verification_status=cg.verification_status,
        active=cg.active,
        current_assignments=cg.current_assignments,
        created_at=cg.created_at,
        verified_at=cg.verified_at
    )

@router.put("/api/caregivers/{id}", response_model=CaregiverResponse)
def update_caregiver(id: int, payload: CaregiverCreate, db: Session = Depends(get_db)):
    cg = db.query(Caregiver).filter(Caregiver.id == id, Caregiver.active == True).first()
    if not cg:
        raise HTTPException(status_code=404, detail="Caregiver not found")
        
    whatsapp_norm = normalize_phone(payload.whatsapp_number)
    calling_norm = normalize_phone(payload.calling_number) if payload.calling_number else whatsapp_norm
    
    # If whatsapp number changes, reset verification
    if cg.whatsapp_number != whatsapp_norm:
        cg.verified = False
        cg.verification_status = "unverified"
        cg.verified_at = None
        
    cg.name = payload.name
    cg.whatsapp_number = whatsapp_norm
    cg.calling_number = calling_norm
    cg.role = payload.role
    cg.priority = payload.priority
    cg.availability = payload.availability
    cg.whatsapp_enabled = payload.whatsapp_enabled
    cg.calls_enabled = payload.calls_enabled
    
    db.commit()
    db.refresh(cg)
    
    return CaregiverResponse(
        id=cg.id,
        name=cg.name,
        whatsapp_number_masked=mask_phone(cg.whatsapp_number),
        calling_number_masked=mask_phone(cg.calling_number),
        role=cg.role,
        priority=cg.priority,
        availability=cg.availability,
        whatsapp_enabled=cg.whatsapp_enabled,
        calls_enabled=cg.calls_enabled,
        verified=cg.verified,
        verification_status=cg.verification_status,
        active=cg.active,
        current_assignments=cg.current_assignments,
        created_at=cg.created_at,
        verified_at=cg.verified_at
    )

@router.delete("/api/caregivers/{id}")
def delete_caregiver(id: int, db: Session = Depends(get_db)):
    cg = db.query(Caregiver).filter(Caregiver.id == id).first()
    if not cg:
        raise HTTPException(status_code=404, detail="Caregiver not found")
    
    # Hard or soft delete? The spec says "Delete Caregiver", let's soft-delete by setting active=False
    cg.active = False
    db.commit()
    return {"success": True, "message": "Caregiver deleted successfully"}

@router.post("/api/caregivers/{id}/send-verification")
def send_verification(id: int, db: Session = Depends(get_db)):
    cg = db.query(Caregiver).filter(Caregiver.id == id, Caregiver.active == True).first()
    if not cg:
        raise HTTPException(status_code=404, detail="Caregiver not found")
        
    # Generate verification token
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.utcnow() + timedelta(hours=24)
    
    # Save verification record
    db.query(CaregiverVerification).filter(CaregiverVerification.caregiver_id == id).delete()
    verify_rec = CaregiverVerification(
        caregiver_id=cg.id,
        token_hash=token_hash,
        expires_at=expires_at
    )
    db.add(verify_rec)
    
    # Set caregiver status to pending
    cg.verification_status = "pending"
    db.commit()
    
    # Send verification message using Twilio service
    patient = db.query(Patient).first()
    patient_name = patient.name if patient else "Eleanor Vance"
    
    res = twilio_service.send_verification(
        to_number=cg.whatsapp_number,
        patient_name=patient_name,
        token=token
    )
    
    if res["status"] == "failed":
        cg.verification_status = "failed"
        db.commit()
        raise HTTPException(
            status_code=502,
            detail=f"Twilio message delivery failed: {res['error_message']} (Code: {res['error_code']})"
        )
    
    return {
        "success": True,
        "message": "Verification sent successfully",
        "twilio_sid": res["sid"],
        "mode": twilio_service.get_status()["mode"]
    }

@router.get("/caregiver/verify", response_class=HTMLResponse)
def verify_caregiver(token: str = Query(...), db: Session = Depends(get_db)):
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    verify_rec = db.query(CaregiverVerification).filter(
        CaregiverVerification.token_hash == token_hash,
        CaregiverVerification.verified == False,
        CaregiverVerification.expires_at > datetime.utcnow()
    ).first()
    
    if not verify_rec:
        return HTMLResponse(
            content="""
            <html>
                <head>
                    <title>SaraCare Verification Failed</title>
                    <style>
                        body { font-family: 'Outfit', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .card { background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); border: 1px solid #ef4444; }
                        h1 { color: #ef4444; margin-top: 0; }
                        p { color: #94a3b8; font-size: 1rem; line-height: 1.5; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Verification Failed</h1>
                        <p>The verification link is invalid, expired, or has already been used. Please request a new verification code from the administrator.</p>
                    </div>
                </body>
            </html>
            """,
            status_code=400
        )
        
    cg = db.query(Caregiver).filter(Caregiver.id == verify_rec.caregiver_id).first()
    if not cg:
        return HTMLResponse(content="<h1>Caregiver record not found</h1>", status_code=404)
        
    # Mark verified
    cg.verified = True
    cg.verification_status = "verified"
    cg.verified_at = datetime.utcnow()
    verify_rec.verified = True
    db.commit()
    
    return HTMLResponse(
        content="""
        <html>
            <head>
                <title>SaraCare Alerts Enabled</title>
                <style>
                    body { font-family: 'Outfit', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); border: 1px solid #10b981; }
                    h1 { color: #10b981; margin-top: 0; }
                    p { color: #94a3b8; font-size: 1rem; line-height: 1.5; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Alerts Enabled</h1>
                    <p>Caregiver alerts successfully enabled. You will now receive automated safety notifications via WhatsApp.</p>
                </div>
            </body>
        </html>
        """
    )

@router.post("/api/caregivers/{id}/test-whatsapp")
def test_whatsapp(id: int, db: Session = Depends(get_db)):
    cg = db.query(Caregiver).filter(Caregiver.id == id, Caregiver.active == True).first()
    if not cg:
        raise HTTPException(status_code=404, detail="Caregiver not found")
        
    # Ensure they are verified or we are in mock mode
    is_real = twilio_service.is_configured()
    if is_real and not cg.verified:
        raise HTTPException(
            status_code=400,
            detail="Caregiver must be verified before sending real alerts. Please verify caregiver first."
        )
        
    body = f"SaraCare: This is a test WhatsApp alert for {cg.name}."
    res = twilio_service.send_whatsapp(cg.whatsapp_number, body)
    
    if res["status"] == "failed":
        raise HTTPException(
            status_code=502,
            detail=f"Twilio test failed: {res['error_message']} (Code: {res['error_code']})"
        )
        
    return {
        "success": True,
        "message": f"Test message sent via {res['status']}",
        "twilio_sid": res["sid"]
    }

@router.post("/api/caregivers/{id}/test-call")
def test_call(id: int, db: Session = Depends(get_db)):
    cg = db.query(Caregiver).filter(Caregiver.id == id, Caregiver.active == True).first()
    if not cg:
        raise HTTPException(status_code=404, detail="Caregiver not found")
        
    is_real = twilio_service.is_configured()
    if is_real and not cg.verified:
        raise HTTPException(
            status_code=400,
            detail="Caregiver must be verified before calling."
        )
        
    # Standard dummy alert_id and patient_name
    res = twilio_service.start_voice_call(
        to_number=cg.calling_number,
        alert_id=999,
        caregiver_id=cg.id,
        patient_name="Eleanor Vance",
        message="This is a test call from SaraCare."
    )
    
    if res["status"] == "failed":
        raise HTTPException(
            status_code=502,
            detail=f"Twilio call failed: {res['error_message']} (Code: {res['error_code']})"
        )
        
    return {
        "success": True,
        "message": f"Test voice call initiated via {res['status']}",
        "twilio_sid": res["sid"]
    }
