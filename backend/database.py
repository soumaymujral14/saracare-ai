import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

# Fetch DATABASE_URL from env, fallback to local SQLite db
database_url = os.getenv("DATABASE_URL", "sqlite:///./saracare.db")

# Render sometimes uses postgres://, SQLAlchemy requires postgresql://
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

# SQLite concurrency setup
connect_args = {}
if database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Patient(Base):
    __tablename__ = "patients"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    age = Column(Integer, nullable=False)
    condition = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Caregiver(Base):
    __tablename__ = "caregivers"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    whatsapp_number = Column(String(30), nullable=False, unique=True)
    calling_number = Column(String(30), nullable=False)
    role = Column(String(100), nullable=True)
    priority = Column(Integer, default=1)
    availability = Column(String(30), default="available") # available, busy, off_duty
    whatsapp_enabled = Column(Boolean, default=True)
    calls_enabled = Column(Boolean, default=True)
    verified = Column(Boolean, default=False)
    verification_status = Column(String(30), default="unverified") # unverified, pending, verified, failed
    active = Column(Boolean, default=True)
    current_assignments = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    verified_at = Column(DateTime, nullable=True)

class CaregiverVerification(Base):
    __tablename__ = "caregiver_verifications"
    
    id = Column(Integer, primary_key=True, index=True)
    caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    verified = Column(Boolean, default=False)

class Medicine(Base):
    __tablename__ = "medicines"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    dose_instruction = Column(String(255), nullable=False)
    reminder_times = Column(String(255), nullable=False) # Comma-separated (e.g. "08:00,20:00")
    frequency = Column(String(50), nullable=False) # once daily, twice daily, three times daily, custom, etc.
    start_date = Column(String(20), nullable=True)
    end_date = Column(String(20), nullable=True)
    before_after_food = Column(String(50), nullable=True)
    requires_supervision = Column(Boolean, default=False)
    notes = Column(Text, nullable=True)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class MedicineEvent(Base):
    __tablename__ = "medicine_events"
    
    id = Column(Integer, primary_key=True, index=True)
    medicine_id = Column(Integer, ForeignKey("medicines.id", ondelete="CASCADE"), nullable=False)
    scheduled_time = Column(String(50), nullable=False) # "YYYY-MM-DD HH:MM"
    status = Column(String(30), default="pending") # pending, taken, skipped, snoozed
    recorded_at = Column(DateTime, nullable=True)
    caregiver_alert_id = Column(Integer, nullable=True) # ID of alert created if supervision needed

class Alert(Base):
    __tablename__ = "alerts"
    
    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(Integer, nullable=True)
    patient_name = Column(String(100), nullable=False)
    alert_type = Column(String(50), nullable=False) # fall, risky_movement, frame_exit, medicine, etc.
    severity = Column(String(20), nullable=False) # routine, urgent, critical
    message = Column(Text, nullable=False)
    source = Column(String(50), nullable=False) # camera_vision, trugen, manual
    status = Column(String(30), default="OPEN") # OPEN, NOTIFYING, ACCEPTED, IN_PROGRESS, HELP_REQUESTED, RESOLVED, CANCELLED, EXPIRED
    assigned_caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="SET NULL"), nullable=True)
    backup_caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="SET NULL"), nullable=True)
    accepted_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    escalation_attempt = Column(Integer, default=0)
    routing_mode = Column(String(20), default="broadcast") # broadcast, smart
    created_at = Column(DateTime, default=datetime.utcnow)

class AlertAssignment(Base):
    __tablename__ = "alert_assignments"
    
    id = Column(Integer, primary_key=True, index=True)
    alert_id = Column(Integer, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(30), default="pending") # pending, notified, accepted, declined
    assigned_at = Column(DateTime, default=datetime.utcnow)

class AlertDelivery(Base):
    __tablename__ = "alert_deliveries"
    
    id = Column(Integer, primary_key=True, index=True)
    alert_id = Column(Integer, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="CASCADE"), nullable=False)
    channel = Column(String(20), nullable=False) # whatsapp, voice
    sid = Column(String(100), nullable=True)
    status = Column(String(30), default="sent")
    error_code = Column(String(20), nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class CallAttempt(Base):
    __tablename__ = "call_attempts"
    
    id = Column(Integer, primary_key=True, index=True)
    alert_id = Column(Integer, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="CASCADE"), nullable=False)
    call_sid = Column(String(100), nullable=True)
    status = Column(String(50), default="queued") # queued, calling, ringing, answered, no_answer, failed, cancelled
    initiated_at = Column(DateTime, default=datetime.utcnow)
    answered_at = Column(DateTime, nullable=True)
    accepted_from_call = Column(Boolean, default=False)
    failure_reason = Column(Text, nullable=True)

class BackupRequest(Base):
    __tablename__ = "backup_requests"
    
    id = Column(Integer, primary_key=True, index=True)
    alert_id = Column(Integer, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    requesting_caregiver_id = Column(Integer, ForeignKey("caregivers.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(30), default="pending") # pending, accepted, resolved
    created_at = Column(DateTime, default=datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)

# Helper to automatically construct database tables
def init_db():
    Base.metadata.create_all(bind=engine)
    
    # Initialize a default patient if none exists
    db = SessionLocal()
    try:
        if db.query(Patient).count() == 0:
            default_patient = Patient(
                name="Eleanor Vance",
                age=82,
                condition="Recovering from hip surgery, high fall risk"
            )
            db.add(default_patient)
            db.commit()
    finally:
        db.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
