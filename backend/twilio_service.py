import os
from twilio.rest import Client
from twilio.base.exceptions import TwilioRestException

class TwilioService:
    def __init__(self):
        self.account_sid = os.getenv("TWILIO_ACCOUNT_SID")
        self.auth_token = os.getenv("TWILIO_AUTH_TOKEN")
        self.whatsapp_number = os.getenv("TWILIO_WHATSAPP_NUMBER")
        self.voice_number = os.getenv("TWILIO_VOICE_NUMBER")
        self.template_sid = os.getenv("TWILIO_WHATSAPP_TEMPLATE_SID")
        self.public_url = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
        
        # Initialize client if configured
        if self.account_sid and self.auth_token:
            self.client = Client(self.account_sid, self.auth_token)
        else:
            self.client = None

    def is_configured(self) -> bool:
        return bool(self.client and self.whatsapp_number and self.voice_number)

    def get_status(self) -> dict:
        """Returns Twilio status without leaking credentials."""
        return {
            "mode": "real" if self.is_configured() else "mock",
            "account_sid_configured": bool(self.account_sid),
            "auth_token_configured": bool(self.auth_token),
            "whatsapp_sender_configured": bool(self.whatsapp_number),
            "voice_sender_configured": bool(self.voice_number),
            "template_sid_configured": bool(self.template_sid),
            "public_url": self.public_url
        }

    def format_whatsapp(self, num: str) -> str:
        """Normalizes and prefixes a phone number for WhatsApp."""
        clean = "".join(c for c in num if c.isalnum() or c == "+")
        if not clean.startswith("+"):
            # Assume international prefix is needed if missing, but let's keep it as is if they entered with +
            pass
        if not clean.startswith("whatsapp:"):
            return f"whatsapp:{clean}"
        return clean

    def format_voice(self, num: str) -> str:
        """Normalizes a phone number for voice calling."""
        return "".join(c for c in num if c.isalnum() or c == "+")

    def send_whatsapp(self, to_number: str, body: str) -> dict:
        """Sends a standard WhatsApp message or falls back to mock."""
        if not self.is_configured():
            return {
                "status": "mock_whatsapp_sent",
                "sid": f"MOCK_WA_{os.urandom(8).hex()}",
                "error_code": None,
                "error_message": None
            }
        
        to_formatted = self.format_whatsapp(to_number)
        from_formatted = self.format_whatsapp(self.whatsapp_number)
        
        try:
            # Send message via Twilio SDK
            kwargs = {
                "body": body,
                "from_": from_formatted,
                "to": to_formatted
            }
            if self.template_sid:
                # If template SID is specified and a custom template is required:
                # Note: Content SID is passed via content_sid on Newer Twilio API versions
                # kwargs["content_sid"] = self.template_sid
                pass
                
            msg = self.client.messages.create(**kwargs)
            return {
                "status": "whatsapp_sent",
                "sid": msg.sid,
                "error_code": None,
                "error_message": None
            }
        except TwilioRestException as e:
            error_code = str(e.code)
            error_message = e.msg
            # Capture specific Twilio sandbox sandbox opt-in errors
            if error_code == "63030":
                error_message = "Twilio Sandbox requires recipient opt-in. Production WhatsApp sender is required for one-click public onboarding."
            return {
                "status": "failed",
                "sid": None,
                "error_code": error_code,
                "error_message": error_message
            }
        except Exception as e:
            return {
                "status": "failed",
                "sid": None,
                "error_code": "500",
                "error_message": str(e)
            }

    def send_verification(self, to_number: str, patient_name: str, token: str) -> dict:
        """Sends the caregiver one-time verification link via WhatsApp."""
        verify_url = f"{self.public_url}/caregiver/verify?token={token}"
        body = (
            f"SaraCare verification: You have been added as a caregiver for {patient_name}. "
            f"Tap below to confirm that you want to receive patient-safety alerts.\n\n"
            f"{verify_url}"
        )
        return self.send_whatsapp(to_number, body)

    def send_alert(self, to_number: str, patient_name: str, alert_type: str, severity: str, message: str, alert_id: int, delivery_token: str) -> dict:
        """Sends a safety alert with accept link via WhatsApp."""
        accept_url = f"{self.public_url}/caregiver/alerts/{alert_id}/accept?token={delivery_token}"
        body = (
            f"SaraCare Alert — {severity.upper()}\n\n"
            f"Patient: {patient_name}\n"
            f"Request: {message}\n"
            f"Type: {alert_type}\n\n"
            f"Tap below to accept this request:\n"
            f"{accept_url}"
        )
        return self.send_whatsapp(to_number, body)

    def send_status_update(self, to_number: str, alert_message: str, caregiver_name: str, status_msg: str) -> dict:
        """Sends notification to other caregivers about who accepted or update."""
        body = f"SaraCare Update: {status_msg}"
        return self.send_whatsapp(to_number, body)

    def start_voice_call(self, to_number: str, alert_id: int, caregiver_id: int, patient_name: str, message: str) -> dict:
        """Initiates a voice call to escalate urgent/critical alerts."""
        if not self.is_configured():
            return {
                "status": "mock_call_queued",
                "sid": f"MOCK_CALL_{os.urandom(8).hex()}",
                "error_code": None,
                "error_message": None
            }
            
        to_formatted = self.format_voice(to_number)
        from_formatted = self.format_voice(self.voice_number)
        voice_webhook = f"{self.public_url}/api/calls/voice?alert_id={alert_id}&caregiver_id={caregiver_id}"
        
        try:
            call = self.client.calls.create(
                to=to_formatted,
                from_=from_formatted,
                url=voice_webhook,
                method="POST"
            )
            return {
                "status": "calling",
                "sid": call.sid,
                "error_code": None,
                "error_message": None
            }
        except TwilioRestException as e:
            return {
                "status": "failed",
                "sid": None,
                "error_code": str(e.code),
                "error_message": e.msg
            }
        except Exception as e:
            return {
                "status": "failed",
                "sid": None,
                "error_code": "500",
                "error_message": str(e)
            }

# Global service instance
twilio_service = TwilioService()
