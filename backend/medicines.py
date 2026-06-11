import os
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database import get_db, Medicine, MedicineEvent, Alert, Patient
from backend.twilio_service import twilio_service

router = APIRouter()

# Schemas
class MedicineCreate(BaseModel):
    name: str = Field(..., min_length=1)
    dose_instruction: str = Field(..., min_length=1)
    reminder_times: str = Field(..., description="Comma-separated HH:MM times, e.g. 08:00,20:00")
    frequency: str = Field(..., description="once daily, twice daily, three times daily, custom, etc.")
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    before_after_food: Optional[str] = None
    requires_supervision: bool = False
    notes: Optional[str] = None
    active: bool = True

class MedicineResponse(BaseModel):
    id: int
    name: str
    dose_instruction: str
    reminder_times: str
    frequency: str
    start_date: Optional[str]
    end_date: Optional[str]
    before_after_food: Optional[str]
    requires_supervision: bool
    notes: Optional[str]
    active: bool
    created_at: datetime

    class Config:
        orm_mode = True

class MedicineEventResponse(BaseModel):
    id: int
    medicine_id: int
    medicine_name: str
    dose_instruction: str
    scheduled_time: str
    status: str
    recorded_at: Optional[datetime]
    requires_supervision: bool

@router.get("/api/medicines", response_model=List[MedicineResponse])
def get_medicines(db: Session = Depends(get_db)):
    return db.query(Medicine).all()

@router.post("/api/medicines", response_model=MedicineResponse)
def create_medicine(payload: MedicineCreate, db: Session = Depends(get_db)):
    # Basic time validation
    times = [t.strip() for t in payload.reminder_times.split(",") if t.strip()]
    for t in times:
        try:
            datetime.strptime(t, "%H:%M")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid time format '{t}'. Must be HH:MM.")
            
    med = Medicine(
        name=payload.name,
        dose_instruction=payload.dose_instruction,
        reminder_times=",".join(times),
        frequency=payload.frequency,
        start_date=payload.start_date,
        end_date=payload.end_date,
        before_after_food=payload.before_after_food,
        requires_supervision=payload.requires_supervision,
        notes=payload.notes,
        active=payload.active
    )
    db.add(med)
    db.commit()
    db.refresh(med)
    return med

@router.put("/api/medicines/{id}", response_model=MedicineResponse)
def update_medicine(id: int, payload: MedicineCreate, db: Session = Depends(get_db)):
    med = db.query(Medicine).filter(Medicine.id == id).first()
    if not med:
        raise HTTPException(status_code=404, detail="Medicine not found")
        
    times = [t.strip() for t in payload.reminder_times.split(",") if t.strip()]
    for t in times:
        try:
            datetime.strptime(t, "%H:%M")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid time format '{t}'. Must be HH:MM.")
            
    med.name = payload.name
    med.dose_instruction = payload.dose_instruction
    med.reminder_times = ",".join(times)
    med.frequency = payload.frequency
    med.start_date = payload.start_date
    med.end_date = payload.end_date
    med.before_after_food = payload.before_after_food
    med.requires_supervision = payload.requires_supervision
    med.notes = payload.notes
    med.active = payload.active
    
    db.commit()
    db.refresh(med)
    return med

@router.delete("/api/medicines/{id}")
def delete_medicine(id: int, db: Session = Depends(get_db)):
    med = db.query(Medicine).filter(Medicine.id == id).first()
    if not med:
        raise HTTPException(status_code=404, detail="Medicine not found")
    db.delete(med)
    db.commit()
    return {"success": True, "message": "Medicine deleted successfully"}

# Helper to create medicine alert
def create_medicine_alert(db: Session, med: Medicine) -> int:
    patient = db.query(Patient).first()
    patient_name = patient.name if patient else "Eleanor Vance"
    
    msg_body = f"Supervision Required: Eleanor Vance needs to take {med.name} ({med.dose_instruction})."
    
    alert = Alert(
        patient_name=patient_name,
        alert_type="medicine",
        severity="routine",
        message=msg_body,
        source="manual" if not med.active else "camera_vision", # let's mark it as camera_vision if active scheduler, manual if user clicked trigger now
        status="OPEN",
        routing_mode="broadcast" # Default routing mode for medicine alert
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    
    # Run trigger alert dispatch logic
    from backend.alert_router import dispatch_alert
    dispatch_alert(alert, db)
    
    return alert.id

@router.post("/api/medicines/{id}/trigger")
def trigger_medicine(id: int, db: Session = Depends(get_db)):
    """Triggers a medicine reminder immediately."""
    med = db.query(Medicine).filter(Medicine.id == id).first()
    if not med:
        raise HTTPException(status_code=404, detail="Medicine not found")
        
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    alert_id = None
    if med.requires_supervision:
        alert_id = create_medicine_alert(db, med)
        
    event = MedicineEvent(
        medicine_id=med.id,
        scheduled_time=f"Triggered: {now_str}",
        status="pending",
        caregiver_alert_id=alert_id
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    
    return {"success": True, "event_id": event.id, "alert_id": alert_id}

@router.post("/api/medicine-events/{id}/status")
def update_event_status(id: int, status_val: str = Query(..., pattern="^(taken|skipped|snoozed)$"), snooze_minutes: Optional[int] = Query(None), db: Session = Depends(get_db)):
    event = db.query(MedicineEvent).filter(MedicineEvent.id == id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Medicine event not found")
        
    med = db.query(Medicine).filter(Medicine.id == event.medicine_id).first()
    if not med:
        raise HTTPException(status_code=404, detail="Medicine not found")
        
    event.status = status_val
    event.recorded_at = datetime.utcnow()
    db.commit()
    
    patient = db.query(Patient).first()
    patient_name = patient.name if patient else "Eleanor Vance"
    
    # Log medicine state change into the Safety Incident Log as a routine alert
    log_msg = f"Patient {patient_name} medicine '{med.name}' was marked as {status_val.upper()}."
    if status_val == "snoozed":
        log_msg += f" (Snoozed for {snooze_minutes or 10} minutes)"
        
    log_alert = Alert(
        patient_name=patient_name,
        alert_type="medicine",
        severity="routine",
        message=log_msg,
        source="manual",
        status="RESOLVED",
        resolved_at=datetime.utcnow()
    )
    db.add(log_alert)
    db.commit()
    
    # If the event had a pending caregiver alert, and the caregiver or user resolves it, resolve the original alert
    if event.caregiver_alert_id:
        alert = db.query(Alert).filter(Alert.id == event.caregiver_alert_id).first()
        if alert and alert.status in ["OPEN", "NOTIFYING", "HELP_REQUESTED", "ACCEPTED"]:
            alert.status = "RESOLVED"
            alert.resolved_at = datetime.utcnow()
            db.commit()
            
    # Handle snooze reschedule
    if status_val == "snoozed":
        mins = snooze_minutes or 10
        snooze_time = datetime.now() + timedelta(minutes=mins)
        snooze_time_str = snooze_time.strftime("%Y-%m-%d %H:%M")
        
        # Schedule next reminder event
        snoozed_event = MedicineEvent(
            medicine_id=med.id,
            scheduled_time=snooze_time_str,
            status="pending"
        )
        db.add(snoozed_event)
        db.commit()
        
    return {"success": True, "status": status_val}

@router.get("/api/medicine-events/today", response_model=List[MedicineEventResponse])
def get_today_events(db: Session = Depends(get_db)):
    """Returns all medicine events scheduled for today or currently pending."""
    today_prefix = datetime.now().strftime("%Y-%m-%d")
    
    events = db.query(MedicineEvent).all()
    res = []
    for e in events:
        med = db.query(Medicine).filter(Medicine.id == e.medicine_id).first()
        if not med:
            continue
            
        # Include if scheduled for today, or if it is still pending
        is_today = e.scheduled_time.startswith(today_prefix)
        is_pending = e.status == "pending"
        is_triggered = e.scheduled_time.startswith("Triggered:")
        
        if is_today or is_pending or is_triggered:
            res.append(MedicineEventResponse(
                id=e.id,
                medicine_id=e.medicine_id,
                medicine_name=med.name,
                dose_instruction=med.dose_instruction,
                scheduled_time=e.scheduled_time,
                status=e.status,
                recorded_at=e.recorded_at,
                requires_supervision=med.requires_supervision
            ))
            
    # Sort: pending first, then latest first
    res.sort(key=lambda x: (x.status != "pending", x.scheduled_time), reverse=True)
    return res

# Modular Scheduler checking function
def check_medicine_reminders(db: Session):
    """
    Checks active medicines and schedules events. Can be called periodically by
    a local scheduler thread, or externally from a Cloud Scheduler / CRON job.
    """
    now = datetime.now()
    current_time_str = now.strftime("%H:%M")
    current_date_str = now.strftime("%Y-%m-%d")
    
    active_meds = db.query(Medicine).filter(Medicine.active == True).all()
    for med in active_meds:
        # Check date range if present
        if med.start_date:
            try:
                start = datetime.strptime(med.start_date, "%Y-%m-%d")
                if now.date() < start.date():
                    continue
            except ValueError:
                pass
        if med.end_date:
            try:
                end = datetime.strptime(med.end_date, "%Y-%m-%d")
                if now.date() > end.date():
                    continue
            except ValueError:
                pass
                
        times = [t.strip() for t in med.reminder_times.split(",") if t.strip()]
        for t_str in times:
            if t_str == current_time_str:
                # Found a scheduled match! Check if we already created an event today
                event_key = f"{current_date_str} {t_str}"
                
                existing = db.query(MedicineEvent).filter(
                    MedicineEvent.medicine_id == med.id,
                    MedicineEvent.scheduled_time == event_key
                ).first()
                
                if not existing:
                    # Create the event
                    alert_id = None
                    if med.requires_supervision:
                        alert_id = create_medicine_alert(db, med)
                        
                    event = MedicineEvent(
                        medicine_id=med.id,
                        scheduled_time=event_key,
                        status="pending",
                        caregiver_alert_id=alert_id
                    )
                    db.add(event)
                    db.commit()
