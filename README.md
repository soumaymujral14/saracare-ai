# SaraCare AI Patient Safety Monitor MVP

A hackathon-ready MVP web application that monitors bed-rest/elderly patients using webcam streams, demo safety triggers, alert timelines, and caregiver call simulations. It is fully ready to connect with TruGen AI via an HTTPS webhook.

## Technical Details

* **Backend**: FastAPI (serves both API endpoints and the frontend static assets).
* **Frontend**: HTML5, Vanilla CSS (Premium Dark Theme), Vanilla JavaScript (Web Audio API siren, polling, webcam feed).
* **Storage**: In-memory only (wipes on backend restart).
* **Port**: 8000

---

## Setup & Running the App

### 1. Install Dependencies
Run the following command from the root directory to install the required Python libraries:
```bash
pip install -r backend/requirements.txt
```

### 2. Start the Backend Server
Run the FastAPI backend (which also mounts and serves the static frontend):
```bash
python -m uvicorn backend.main:app --reload --port 8000
```

### 3. Open the Web App
Open your web browser and navigate to:
**[http://localhost:8000](http://localhost:8000)**

---

## Interactive Walkthrough

1. **Start Monitoring**: Click the **Start Monitoring** button. This will request camera permissions (providing a live feed stream) and unlock the browser's audio context (allowing sound alerts to play).
2. **Setup Profile**: Fill out the patient details and mock caregiver contact information, then click **Save Profile** (persists in browser local storage).
3. **Demo Triggers**: Press any button in the *Demo Safety Triggers* panel:
   * **Possible Fall** and **Emergency** (Critical) / **Risky Movement**, **Frame Exit**, and **Voice Help** (Urgent) will sound an audible siren alarm, overlay a bright warning on the webcam, log the event to the history log, and pop up a **Mock Call Simulation** modal to notify the caregiver.
   * **Mute/Dismiss**: Tap the Mute button in the header or in the modal to silence the siren and reset the patient's monitoring status to Safe.
4. **Medicine Reminder**: Set a reminder time, or click **Trigger Now** to see a routine (non-critical) medication alert populate the safety log.

---

## Developer API & TruGen Integration

You can trigger alerts externally (e.g. from TruGen AI tool integrations or sensors) using `curl` or HTTP requests:

### 1. Health Status Check
```bash
curl http://localhost:8000/health
```

### 2. Retrieve Safety Alert Logs
```bash
curl http://localhost:8000/alerts
```

### 3. Trigger General Alert
```bash
curl -X POST http://localhost:8000/alert \
  -H "Content-Type: application/json" \
  -d '{"patient_name": "Eleanor Vance", "alert_type": "fall", "severity": "critical", "message": "Sensor detected sudden height level change"}'
```

### 4. Trigger TruGen Webhook Alert (Real-time Timeline Updates)
If you have the dashboard running at `http://localhost:8000` with monitoring active, running this command will instantly alert the dashboard and sound the siren alarm in the web app:
```bash
curl -X POST http://localhost:8000/trugen-alert \
  -H "Content-Type: application/json" \
  -d '{"patient_name": "Eleanor Vance", "alert_type": "risky_movement", "severity": "urgent", "message": "TruGen Vision AI: Patient is climbing over guardrails"}'
```
