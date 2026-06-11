import sys
import os
import unittest
from datetime import datetime, timedelta
import hashlib
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Set python path to find backend modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.database import Base, Patient, Caregiver, CaregiverVerification, Medicine, MedicineEvent, Alert, AlertAssignment, CallAttempt, BackupRequest
from backend.alert_router import score_caregiver, get_eligible_caregivers, atomic_accept_alert, score_caregiver
from backend.medicines import check_medicine_reminders
from backend.twilio_service import twilio_service

# Mock Twilio Service during automated testing
class MockTwilioService:
    def __init__(self):
        self.sent_messages = []
        self.initiated_calls = []

    def is_configured(self):
        return True

    def get_status(self):
        return {"mode": "mock", "whatsapp_number_present": True, "voice_number_present": True}

    def send_whatsapp(self, to_number, body):
        self.sent_messages.append({"to": to_number, "body": body})
        return {"status": "whatsapp_sent", "sid": "MOCK_WA_SID", "error_code": None, "error_message": None}

    def send_verification(self, to_number, patient_name, token):
        self.sent_messages.append({"to": to_number, "type": "verify", "token": token})
        return {"status": "whatsapp_sent", "sid": "MOCK_VERIFY_SID", "error_code": None, "error_message": None}

    def send_alert(self, to_number, patient_name, alert_type, severity, message, alert_id, delivery_token):
        self.sent_messages.append({"to": to_number, "type": "alert", "alert_id": alert_id})
        return {"status": "whatsapp_sent", "sid": "MOCK_ALERT_SID", "error_code": None, "error_message": None}

    def start_voice_call(self, to_number, alert_id, caregiver_id, patient_name, message):
        self.initiated_calls.append({"to": to_number, "alert_id": alert_id, "caregiver_id": caregiver_id})
        return {"status": "calling", "sid": "MOCK_CALL_SID", "error_code": None, "error_message": None}

# Swap real Twilio service with mock
twilio_service.send_whatsapp = MockTwilioService().send_whatsapp
twilio_service.send_verification = MockTwilioService().send_verification
twilio_service.send_alert = MockTwilioService().send_alert
twilio_service.start_voice_call = MockTwilioService().start_voice_call

class TestCaregiverCoordination(unittest.TestCase):
    def setUp(self):
        # Create SQLite in-memory database engine for testing
        self.engine = create_engine("sqlite:///:memory:")
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        Base.metadata.create_all(self.engine)

        # Setup default patient
        self.patient = Patient(name="Eleanor Vance", age=82, condition="High fall risk")
        self.db.add(self.patient)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(self.engine)

    def test_caregiver_registration_and_verification(self):
        # 1. Register caregiver
        cg = Caregiver(
            name="Alice",
            whatsapp_number="+919876543210",
            calling_number="+919876543210",
            availability="available",
            verification_status="unverified"
        )
        self.db.add(cg)
        self.db.commit()

        # Verify added
        self.assertEqual(self.db.query(Caregiver).count(), 1)
        self.assertFalse(cg.verified)

        # 2. Simulate sending verification token
        token = "test_token_abc123"
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires = datetime.utcnow() + timedelta(hours=1)
        
        verify_rec = CaregiverVerification(caregiver_id=cg.id, token_hash=token_hash, expires_at=expires)
        self.db.add(verify_rec)
        cg.verification_status = "pending"
        self.db.commit()

        # 3. Confirm token from browser
        verify_db = self.db.query(CaregiverVerification).filter(
            CaregiverVerification.token_hash == token_hash,
            CaregiverVerification.expires_at > datetime.utcnow(),
            CaregiverVerification.verified == False
        ).first()
        
        self.assertIsNotNone(verify_db)
        
        # Mark verified
        cg_to_verify = self.db.query(Caregiver).filter(Caregiver.id == verify_db.caregiver_id).first()
        cg_to_verify.verified = True
        cg_to_verify.verification_status = "verified"
        verify_db.verified = True
        self.db.commit()

        self.assertTrue(cg.verified)
        self.assertEqual(cg.verification_status, "verified")

    def test_routing_modes(self):
        # Setup multiple verified caregivers
        cg1 = Caregiver(name="Nurse Alice", whatsapp_number="+919000000001", calling_number="+919000000001", priority=1, availability="available", verified=True, active=True)
        cg2 = Caregiver(name="Son Bob", whatsapp_number="+919000000002", calling_number="+919000000002", priority=2, availability="available", verified=True, active=True)
        cg3 = Caregiver(name="Off-duty Charlie", whatsapp_number="+919000000003", calling_number="+919000000003", priority=3, availability="off_duty", verified=True, active=True)
        
        self.db.add_all([cg1, cg2, cg3])
        self.db.commit()

        # Check scoring
        self.assertEqual(score_caregiver(cg1, self.db), 100.0) # Base 100
        self.assertEqual(score_caregiver(cg2, self.db), 90.0)  # Priority 2 penalizes by -10

        # Available and verified list
        candidates = get_eligible_caregivers(self.db)
        self.assertEqual(len(candidates), 2) # Off-duty Charlie is excluded
        self.assertEqual(candidates[0].name, "Nurse Alice") # Alice has higher score

    def test_atomic_first_accept_wins(self):
        cg1 = Caregiver(name="Nurse Alice", whatsapp_number="+1", calling_number="+1", verified=True)
        cg2 = Caregiver(name="Son Bob", whatsapp_number="+2", calling_number="+2", verified=True)
        self.db.add_all([cg1, cg2])
        self.db.commit()

        alert = Alert(patient_name="Eleanor Vance", alert_type="fall", severity="critical", message="Fall detected", source="camera_vision", status="OPEN")
        self.db.add(alert)
        self.db.commit()

        # First accepts
        res1 = atomic_accept_alert(alert.id, cg1.id, self.db)
        self.assertTrue(res1["success"])
        self.assertEqual(alert.status, "ACCEPTED")
        self.assertEqual(alert.assigned_caregiver_id, cg1.id)

        # Second caregiver tries to accept
        res2 = atomic_accept_alert(alert.id, cg2.id, self.db)
        self.assertFalse(res2["success"])
        self.assertIn("accepted by Nurse Alice", res2["message"])
        self.assertEqual(alert.assigned_caregiver_id, cg1.id) # Remains assigned to cg1

    def test_caregiver_backup_flow(self):
        cg1 = Caregiver(name="Nurse Alice", whatsapp_number="+1", calling_number="+1", verified=True, availability="available")
        cg2 = Caregiver(name="Son Bob", whatsapp_number="+2", calling_number="+2", verified=True, availability="available")
        self.db.add_all([cg1, cg2])
        self.db.commit()

        alert = Alert(patient_name="Eleanor Vance", alert_type="fall", severity="critical", message="Fall", source="camera_vision", status="ACCEPTED", assigned_caregiver_id=cg1.id)
        self.db.add(alert)
        self.db.commit()

        # Alice requests backup (HELP)
        alert.status = "HELP_REQUESTED"
        req = BackupRequest(alert_id=alert.id, requesting_caregiver_id=cg1.id, status="pending")
        self.db.add(req)
        self.db.commit()

        # Bob accepts backup
        alert.backup_caregiver_id = cg2.id
        alert.status = "ACCEPTED"
        req.status = "resolved"
        self.db.commit()

        self.assertEqual(alert.assigned_caregiver_id, cg1.id) # cg1 remains attached
        self.assertEqual(alert.backup_caregiver_id, cg2.id)   # cg2 is backup

    def test_medicine_schedule_triggers(self):
        med = Medicine(
            name="Aricept",
            dose_instruction="5mg",
            reminder_times="08:00",
            frequency="once daily",
            requires_supervision=True,
            active=True
        )
        self.db.add(med)
        self.db.commit()

        # Simulate checking reminders matching scheduled time
        now = datetime.now().replace(hour=8, minute=0, second=0)
        current_time_str = "08:00"
        current_date_str = now.strftime("%Y-%m-%d")
        event_key = f"{current_date_str} {current_time_str}"

        # Make sure no event exists
        existing = self.db.query(MedicineEvent).filter(
            MedicineEvent.medicine_id == med.id,
            MedicineEvent.scheduled_time == event_key
        ).first()
        self.assertIsNone(existing)

        # Trigger event and supervision alert
        alert = Alert(patient_name="Eleanor Vance", alert_type="medicine", severity="routine", message="Aricept reminder", source="manual", status="OPEN")
        self.db.add(alert)
        self.db.commit()
        
        event = MedicineEvent(
            medicine_id=med.id,
            scheduled_time=event_key,
            status="pending",
            caregiver_alert_id=alert.id
        )
        self.db.add(event)
        self.db.commit()

        # Assert reminders persist in DB
        self.assertEqual(self.db.query(MedicineEvent).count(), 1)
        self.assertEqual(self.db.query(Alert).count(), 1)


# ==============================================================================
# DOCUMENTED MANUAL VERIFICATION FLOWS
# ==============================================================================
#
# Follow these exact steps to verify real WhatsApp and Calling integrations:
#
# 1. ONE-TIME WHATSAPP VERIFICATION FLOW
#    - Configure .env with valid TWILIO_* credentials and PUBLIC_BASE_URL.
#    - Run python main.py and open dashboard at http://localhost:8000.
#    - Under "Caregivers Coordination", click "Add" -> register your name and phone number.
#    - Click "Verify & Enable Alerts".
#    - Verify you receive a real WhatsApp message from the Twilio sender:
#      "SaraCare verification: You have been added as a caregiver... Tap below to confirm..."
#    - Tap the link. Verify the success webpage loads: "Caregiver alerts successfully enabled."
#    - Verify the caregiver card status changes to "verified" (green badge) on reload.
#
# 2. REAL WHATSAPP ALERT & FIRST-ACCEPT FLOW
#    - Register two caregivers (both verified using their own WhatsApp numbers).
#    - Under "Caregiver Coordination", set Alert Mode to "Broadcast to Everyone".
#    - Trigger an urgent alert (e.g., click "Possible Fall" in Demo Safety Triggers).
#    - Verify both caregivers receive WhatsApp messages containing the "Tap below to accept" link.
#    - Caregiver A clicks the link first. Verify they see: "You have accepted this request."
#    - Caregiver B clicks the link. Verify they see: "This request has already been accepted by Nurse Alice."
#    - Verify the dashboard automatically shows Caregiver A assigned to the active alert.
#
# 3. REAL TELEPHONE VOICE ESCALATION & KEYPAD ACCEPT FLOW
#    - Register a caregiver with calls enabled. Set Alert Mode to "Broadcast".
#    - Trigger a critical alert (e.g. click "Emergency").
#    - Verify the Twilio voice line dials the caregiver's calling phone number.
#    - Answer the call. Listen to the text-to-speech Alice message:
#      "This is a SaraCare urgent alert for Eleanor Vance... Press 1 to accept."
#    - Press "1" on the keypad.
#    - Verify you hear confirmation: "Thank you. You have accepted... Goodbye."
#    - Check the dashboard. Verify the alert status has updated to "ACCEPTED" by this caregiver.
# ==============================================================================

if __name__ == "__main__":
    unittest.main()
