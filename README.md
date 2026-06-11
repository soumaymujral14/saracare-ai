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

---

## Persistent Database Storage
By default, the application uses **SQLite** for local development, creating a `saracare.db` file automatically on start.
For production hosting on platforms like Render or Google Cloud Run, configure the `DATABASE_URL` environment variable pointing to a PostgreSQL instance. The application automatically handles connection string compatibility (replacing `postgres://` with `postgresql://`).

---

## Environment Configuration
Create a `.env` file in the root directory and configure the following variables:
- `TWILIO_ACCOUNT_SID`: Twilio account identifier.
- `TWILIO_AUTH_TOKEN`: Twilio API authorization token.
- `TWILIO_WHATSAPP_NUMBER`: The Twilio sandbox number (e.g. `whatsapp:+14155238886`).
- `TWILIO_VOICE_NUMBER`: Your Twilio verified voice caller ID number.
- `TWILIO_WHATSAPP_TEMPLATE_SID`: (Optional) Approved template SID if using production WhatsApp templates.
- `PUBLIC_BASE_URL`: The fully qualified public domain URL of your deployment (e.g. `https://saracare-ai.onrender.com`).
- `CAREGIVER_TOKEN_SECRET`: Random secret string used for verification hashes.
- `DATABASE_URL`: PostgreSQL connection string (in production).

---

## Render Deployment Setup
1. Create a Web Service on Render.
2. Link your GitHub repository: `https://github.com/soumaymujral14/saracare-ai.git`.
3. Configure the following settings:
   - **Environment**: `Python`
   - **Build Command**: `pip install -r backend/requirements.txt`
   - **Start Command**: `python -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
4. Add your Environment Variables in the Render dashboard.

---

## Google Cloud Run Deployment (Future Preparation)
To build and deploy the containerized application to Google Cloud Run, follow these steps:

### 1. Build and Push the Container
Using Google Cloud Build to create and store the image in Artifact Registry:
```bash
gcloud builds submit --tag gcr.io/[PROJECT_ID]/saracare-app
```

### 2. Deploy to Cloud Run
Deploy the service using the following command:
```bash
gcloud run deploy saracare-service \
  --image gcr.io/[PROJECT_ID]/saracare-app \
  --platform managed \
  --port 8000 \
  --allow-unauthenticated \
  --set-env-vars="PUBLIC_BASE_URL=https://[YOUR-CLOUD-RUN-URL],TWILIO_ACCOUNT_SID=...,DATABASE_URL=..."
```
*Note: Make sure to map all Twilio and Database credentials. Cloud Run automatically binds to the host's specified PORT.*

