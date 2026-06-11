# SaraCare AI Patient Safety Monitor — Project Context

> **Audience:** Frontend teammate joining the project.  
> **Purpose:** Understand the complete system so you can improve the frontend without breaking existing functionality.  
> **Note:** This file contains no secrets, credentials, real phone numbers, tokens, or database contents.

---

## 1. Project Summary

SaraCare is an AI-assisted patient safety monitoring dashboard designed for elderly, bed-rest, post-surgery, or high-fall-risk patients.

It helps caregivers:
- Monitor patient safety via camera and heuristic vision detection
- Receive and coordinate safety alerts in real time
- Manage medicine reminders and supervision schedules
- Connect patients with an AI companion (TruGen Sara)

**SaraCare is not a medical diagnosis tool.** It is a safety alert and caregiver coordination layer. It does not replace doctors, nurses, or emergency services.

---

## 2. Problem Statement

Elderly and bed-rest patients need continuous attention, but caregivers cannot watch them every second. Risk situations include:

- Falls or fall attempts
- Standing up alone (high fall risk)
- Risky movement patterns
- Leaving the monitored camera frame
- Needing restroom assistance
- Medicine time supervision
- Pain or emergency symptoms
- Voice help requests ("Sara, call caregiver")

---

## 3. Core Solution

SaraCare combines the following capabilities:

| Layer | Description |
|---|---|
| Camera monitoring | Browser camera with heuristic pose/vision detection |
| TruGen AI Companion | Conversational AI companion via iframe/video (Sara) |
| Safety Incident Log | Chronological alert history in the database |
| Medicine scheduler | Time-based reminders with supervision alerts |
| Caregiver coordination | Unlimited caregivers, routing modes, first-accept-wins |
| WhatsApp/Voice alerts | Via Twilio when configured; mock mode when not |
| Backup/HELP flow | Assigned caregiver can escalate to others |

---

## 4. Tech Stack

### Frontend
- Plain HTML, CSS, JavaScript (no framework)
- Browser Camera API (`getUserMedia`)
- Browser `SpeechSynthesis` API for voice fallback announcements
- Vision detection script (`frontend/vision.js`)
- TruGen AI companion embedded as iframe/video

### Backend
- **FastAPI** (Python) — REST API server
- **SQLAlchemy** ORM with:
  - **SQLite** for local development (auto-created as `saracare.db`)
  - **PostgreSQL** for production (via `DATABASE_URL` env var)
- **Twilio SDK** — WhatsApp messages and voice calls (provider-ready; runs in mock mode if credentials are absent)
- **python-dotenv** — `.env` file support
- Background async task loop for medicine scheduler (runs every 30 seconds)

### Deployment
- Currently hosted on **Render**
- Dockerfile is prepared for future **Google Cloud Run** deployment
- `Procfile` included for Render web service

### Key Dependencies (see `backend/requirements.txt`)
```
fastapi
uvicorn
pydantic
twilio
python-dotenv
aiofiles
sqlalchemy
psycopg2-binary
```

---

## 5. Main User Flow

1. Caregiver opens the SaraCare dashboard in a browser.
2. Caregiver fills in or confirms the patient profile.
3. Caregiver clicks **Setup Camera** and grants camera permission.
4. Caregiver positions the camera so the full bed area is visible.
5. Caregiver clicks **Confirm Frame** to lock the monitoring region.
6. Camera monitoring and vision detection become active.
7. **Sara AI Companion** can be opened for patient interaction.
8. If a safety event is detected, SaraCare creates an alert.
9. Alert is dispatched to caregivers via WhatsApp (or mock in demo mode).
10. First caregiver to tap the accept link becomes the assigned responder.
11. Other caregivers receive a stand-down notification.
12. Assigned caregiver can click **Request Backup** if they need help.
13. Alert is resolved once assistance is confirmed.

---

## 6. Important Safety Positioning

Always present SaraCare as:
- ✅ Patient safety support
- ✅ Caregiver alert layer
- ✅ Monitoring assistant

Never claim SaraCare is:
- ❌ A medical diagnosis tool
- ❌ A replacement for doctors, nurses, or emergency services
- ❌ A certified medical device

**Camera pose detection is heuristic.** It may produce false positives or miss detections. The UI must never claim certified medical accuracy.

**Medicine scheduler never recommends dosage.** It only stores and surfaces instructions entered by caregivers or doctors.

---

## 7. Existing Frontend Sections

The following sections exist in `frontend/index.html`, `frontend/app.js`, and `frontend/style.css`. Do not remove or break them.

### 7.1 Patient Profile
Displays patient information:
- Patient name (default: Eleanor Vance)
- Age
- Condition / notes

### 7.2 Camera Setup / Monitoring Panel
Handles the full camera lifecycle:
- Camera permission request
- Setup mode (positioning guidance)
- Frame confirmation click
- Live camera feed
- Vision/pose detection status
- Safety status display

> ⚠️ **Do not break the camera setup flow.** It is the core safety feature.

### 7.3 Sara AI Companion
Embeds TruGen as an iframe or video companion.

Sara is used for:
- Patient conversation and comfort
- Motivation during recovery
- Explaining that a caregiver has been alerted
- Guided patient-facing interaction

> ⚠️ **Sara is not the monitoring engine.** Camera/vision must work even when TruGen is offline or session-limited. Browser `SpeechSynthesis` is the fallback for urgent alerts.

### 7.4 Demo / Test Safety Triggers
Manual simulation buttons for testing without a real event. Triggers include:
- Possible fall
- Risky movement
- Frame exit
- Medicine time
- Voice help request
- Emergency

These call the backend alert API and are essential for demos and local testing.

### 7.5 Caregiver Coordination
Manages the list of caregivers who receive safety alerts. Features:
- Add, edit, delete caregivers
- Masked phone number display (never shows full number in UI)
- Availability status: `available`, `busy`, `off_duty`
- WhatsApp enabled toggle
- Calls enabled toggle
- Verification status: `unverified`, `pending`, `verified`, `failed`
- Send verification link
- Test WhatsApp message
- Test voice call
- Routing mode selector (Broadcast / Smart Duty)

### 7.6 Medicine Routine
Manages patient medicine schedules. Features:
- Add, edit, delete medicines
- Reminder times (comma-separated HH:MM)
- Frequency (once daily, twice daily, custom, etc.)
- Dose / instruction text (no dosage recommendation — caregiver-entered only)
- Before/after food setting
- Caregiver supervision required toggle
- Active/inactive toggle
- Trigger Now button (immediate reminder)
- Today's events panel: `pending`, `taken`, `skipped`, `snoozed`

### 7.7 Active Caregiver Alerts
Shows all open and in-progress alerts. For each alert:
- Alert type and severity badge
- Status: `OPEN`, `NOTIFYING`, `ACCEPTED`, `IN_PROGRESS`, `HELP_REQUESTED`, `RESOLVED`
- Assigned caregiver name
- Backup caregiver name (if applicable)
- Accepted timestamp
- Resolve button
- Request Backup button

### 7.8 Integration / Admin Status
Shows Twilio provider status without exposing secrets:
- `mode`: `real` (Twilio configured) or `mock` (demo mode)
- WhatsApp sender configured: yes/no
- Voice number configured: yes/no
- Template SID configured: yes/no
- Public base URL

> ⚠️ Never show credential values in the UI. Only show boolean presence indicators.

### 7.9 Safety Incident Log
Chronological list of all alert events from the database.
- Loaded from `/alerts` (legacy) or `/api/alerts`
- Shows alert type, severity, message, timestamp, and source
- Must remain compatible with `POST /trugen-alert` alert flow

---

## 8. Backend API Reference

Base URL (local): `http://localhost:8000`  
API docs (Swagger): `http://localhost:8000/docs`

### 8.1 Health & Status

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{"status": "ok"}` |
| `GET` | `/whatsapp-status` | Legacy WhatsApp status endpoint |
| `GET` | `/api/integrations/twilio/status` | Current Twilio provider mode and config presence |

### 8.2 Legacy Alert Endpoints (preserve these — do not remove)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/trugen-alert` | TruGen AI webhook — saves alert and dispatches routing |
| `GET` | `/alerts` | Legacy alert list (sorted newest first) |
| `POST` | `/alert` | Legacy alert creation endpoint |
| `POST` | `/mock-call` | Mock call endpoint (always returns success) |
| `POST` | `/request-stop-monitoring` | Patient requests to stop monitoring |
| `POST` | `/approve-stop-monitoring` | Caregiver approves stop monitoring request |

### 8.3 Caregivers

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/caregivers` | List all active caregivers (phone numbers masked) |
| `POST` | `/api/caregivers` | Add a new caregiver |
| `PUT` | `/api/caregivers/{id}` | Update a caregiver (changing WhatsApp number resets verification) |
| `DELETE` | `/api/caregivers/{id}` | Soft-delete caregiver (sets `active=false`) |
| `POST` | `/api/caregivers/{id}/send-verification` | Send WhatsApp verification link |
| `GET` | `/caregiver/verify?token=...` | Caregiver clicks to confirm verification (HTML response page) |
| `POST` | `/api/caregivers/{id}/test-whatsapp` | Send test WhatsApp to caregiver |
| `POST` | `/api/caregivers/{id}/test-call` | Initiate test voice call to caregiver |

> **Phone masking rule:** The API never returns the full phone number. It returns `whatsapp_number_masked` and `calling_number_masked`. The frontend must display only masked values.

### 8.4 Medicines

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/medicines` | List all medicines |
| `POST` | `/api/medicines` | Create a medicine record |
| `PUT` | `/api/medicines/{id}` | Update a medicine |
| `DELETE` | `/api/medicines/{id}` | Hard-delete a medicine |
| `POST` | `/api/medicines/{id}/trigger` | Trigger immediate reminder for this medicine |
| `GET` | `/api/medicine-events/today` | Get today's medicine events (pending, taken, skipped, snoozed) |
| `POST` | `/api/medicine-events/{id}/status?status_val=taken` | Mark event as taken/skipped/snoozed |

Accepted `status_val` values: `taken`, `skipped`, `snoozed`  
Optional query param for snoozed: `snooze_minutes` (default: 10)

### 8.5 Alerts

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/alerts` | List all alerts (newest first, with caregiver names resolved) |
| `POST` | `/api/alerts` | Create a new alert and dispatch routing |
| `POST` | `/api/alerts/{id}/accept?caregiver_id=N` | API accept (for dashboard use) |
| `POST` | `/api/alerts/{id}/request-backup` | Assigned caregiver requests backup |
| `POST` | `/api/alerts/{id}/resolve` | Resolve alert and decrement caregiver workload |
| `POST` | `/api/alerts/{id}/decline?caregiver_id=N` | Caregiver declines assignment |
| `POST` | `/api/alerts/{id}/start` | Mark alert as IN_PROGRESS |
| `GET` | `/caregiver/alerts/{alert_id}/accept?token=...` | One-click WhatsApp accept link (HTML page) |

**Alert status lifecycle:**
```
OPEN → NOTIFYING → ACCEPTED → IN_PROGRESS → RESOLVED
                             ↘ HELP_REQUESTED → (backup accepted) → RESOLVED
```

**Alert severity values:** `routine`, `urgent`, `critical`  
**Alert type values:** `fall`, `risky_movement`, `frame_exit`, `medicine`, `voice_help`, `emergency`, `stop_monitoring_requested`, `stop_monitoring_approved`

### 8.6 Routing Settings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/settings/routing` | Get current routing mode and critical broadcast setting |
| `POST` | `/api/settings/routing?mode=broadcast&critical_broadcast=true` | Update routing mode |

Routing modes: `broadcast`, `smart`

### 8.7 Calls (Twilio Voice Webhooks)

These are called by Twilio, not by the frontend directly.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/calls/voice` | Twilio voice webhook — announces alert, prompts press-1 to accept |
| `POST` | `/api/calls/accept` | Twilio DTMF gather callback — processes digit 1 = accept |
| `POST` | `/api/calls/status` | Twilio call status callback — keeps DB in sync |

### 8.8 WhatsApp Inbound (Twilio Webhook)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/whatsapp/inbound` | Twilio inbound WhatsApp webhook — parses caregiver reply commands |

Supported caregiver reply commands (sent via WhatsApp):
- `ACCEPT [id]` — Accept an alert
- `HELP [id]` or `BACKUP [id]` — Request backup
- `RESOLVE [id]` — Resolve an alert
- `DECLINE [id]` — Decline assignment

If no alert ID is provided, the system uses the caregiver's most recent assignment.

---

## 9. Caregiver Coordination Logic

### 9.1 Routing Modes

**Broadcast (default):**
- All available, verified caregivers receive the WhatsApp alert simultaneously.
- First caregiver to tap Accept becomes the assigned responder.
- Others receive a stand-down notification automatically.

**Smart Duty Routing:**
- System scores each caregiver by priority, workload, and recent assignment rotation.
- Alerts are dispatched sequentially; next caregiver is tried after a 30-second escalation delay if no acceptance.
- Critical alerts always broadcast to all (overrides smart routing).

### 9.2 Caregiver Eligibility

A caregiver is eligible to receive an alert if:
- `active = true`
- `verified = true`
- `availability = "available"`

Unverified caregivers are skipped. This is enforced on the backend.

---

## 10. First-Accept-Wins Logic

This is a **backend-enforced** atomic operation. Do not implement this logic in the frontend.

How it works:
1. Alert starts in `OPEN` or `NOTIFYING` state.
2. Multiple caregivers may receive the alert simultaneously.
3. First caregiver to call the accept endpoint wins the conditional database update.
4. The alert status changes to `ACCEPTED` and the winning caregiver is assigned.
5. A background task notifies all other notified caregivers to stand down.
6. Any subsequent accept attempt returns: `"This request has already been accepted by [name]."`

The accept page (`/caregiver/alerts/{id}/accept?token=...`) is a full HTML page served by the backend — caregivers tap this link directly from WhatsApp.

---

## 11. Backup / HELP Flow

1. Assigned caregiver clicks **Request Backup** (or sends `HELP` via WhatsApp).
2. Alert status changes to `HELP_REQUESTED`.
3. A `BackupRequest` record is created in the database.
4. All other available, verified caregivers receive a backup WhatsApp notification.
5. First backup caregiver to accept becomes the backup responder.
6. Original assigned caregiver remains assigned.
7. Both primary and backup caregivers are tracked on the alert.

---

## 12. Medicine Scheduler Logic

The backend scheduler loop runs every 30 seconds in the background. It checks all active medicines and creates `MedicineEvent` records when reminder times match the current time.

Important rules:
- Reminder times are stored as comma-separated `HH:MM` strings (e.g. `08:00,20:00`).
- Date ranges (`start_date`, `end_date`) are respected if set.
- If `requires_supervision = true`, a caregiver alert is also created and dispatched when the event fires.
- A `MedicineEvent` with `status = "snoozed"` creates a new pending event N minutes in the future.
- Marking an event as `taken`, `skipped`, or `snoozed` also auto-resolves the linked caregiver alert if one exists.

> ⚠️ **Render Free tier may sleep.** The background scheduler only runs while the server is active. For reliable medicine reminders in production, use an external CRON job or Google Cloud Scheduler to call the trigger endpoint.

---

## 13. Vision / Camera Logic

The vision detection is handled in `frontend/vision.js` and runs entirely in the browser.

Detection types:
- Possible fall (sudden downward pose change)
- Frame exit (patient leaves monitored area)
- Risky movement (lateral or rapid motion)
- Standing attempt detection

**Setup sequence (do not break this flow):**
1. Click **Setup Camera** → requests `getUserMedia`.
2. Camera feed is displayed in setup mode.
3. Caregiver positions camera correctly.
4. Click **Confirm Frame** → monitoring mode becomes active.
5. Vision loop starts running in the browser.

Monitoring must remain active even when the TruGen Sara panel is open. Camera and Sara are two independent systems.

> ⚠️ UI must never claim certified medical accuracy for pose detection.

---

## 14. TruGen AI Companion (Sara)

Sara is integrated as a video/iframe companion using the TruGen platform.

Use cases:
- Talking to the patient
- Comforting and motivating the patient
- Explaining that a caregiver has been alerted
- Guiding the patient to stay still or calm

Important:
- Safety alerts **must not depend on Sara**. Camera/vision monitoring must work if TruGen goes offline.
- Browser `SpeechSynthesis` is the fallback for urgent spoken safety warnings.
- If TruGen session ends, monitoring continues uninterrupted.
- TruGen sends events to the backend via `POST /trugen-alert`.

---

## 15. Twilio Integration Status

> **Current status: Provider-ready with mock/demo fallback.**

The backend automatically detects whether Twilio credentials are present:

| Scenario | Behavior |
|---|---|
| All Twilio env vars present | `mode: "real"` — actual WhatsApp messages and voice calls are made |
| Credentials missing or partial | `mode: "mock"` — mock SIDs are returned, no real messages are sent |

**What is implemented in code:**
- ✅ WhatsApp outbound alerts via Twilio SDK (`send_alert`)
- ✅ WhatsApp verification links (`send_verification`)
- ✅ WhatsApp status update / stand-down notifications (`send_status_update`)
- ✅ Outbound voice calls with press-1 accept (`start_voice_call`)
- ✅ Inbound WhatsApp command parsing (`/api/whatsapp/inbound`)
- ✅ TwiML voice webhook responses (`/api/calls/voice`, `/api/calls/accept`)
- ✅ Mock fallback for all messaging when credentials are absent

**What has NOT been confirmed in live production:**
- Real WhatsApp messages have not been confirmed delivered from a production Twilio account.
- Real voice calls have not been confirmed received on a physical phone.
- Twilio Sandbox WhatsApp requires recipient opt-in (error code 63030 is handled in code).
- Production WhatsApp sender requires a Twilio-approved business sender (not sandbox).

Do not present WhatsApp or voice calling as confirmed production features until tested end-to-end with real credentials.

---

## 16. Environment Variables (Placeholders Only)

Create a `.env` file in the project root with these keys. **Never commit real values.**  
See `.env.example` for the template.

```
DATABASE_URL=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=
TWILIO_VOICE_NUMBER=
TWILIO_WHATSAPP_TEMPLATE_SID=
PUBLIC_BASE_URL=
CAREGIVER_TOKEN_SECRET=
```

- `DATABASE_URL`: PostgreSQL URI for production. If blank, SQLite is used locally.
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`: Twilio credentials. If absent, mock mode is used.
- `TWILIO_WHATSAPP_NUMBER`: Your Twilio WhatsApp sender number (e.g. `whatsapp:+14155238886`).
- `TWILIO_VOICE_NUMBER`: Your Twilio Voice number for outbound calls.
- `TWILIO_WHATSAPP_TEMPLATE_SID`: Optional. Twilio Content SID for approved templates.
- `PUBLIC_BASE_URL`: Full public URL of the deployed app (used in accept/verify links).
- `CAREGIVER_TOKEN_SECRET`: Secret for signing tokens/hashes.

---

## 17. Local Setup

### Step 1: Install dependencies

```bash
pip install -r backend/requirements.txt
```

### Step 2: Create `.env` file

Copy `.env.example` to `.env` and fill in your values (Twilio is optional — mock mode works without it).

### Step 3: Start the server

```bash
python -m uvicorn backend.main:app --reload --port 8000
```

### Step 4: Open in browser

```
http://localhost:8000
```

### Step 5: Interactive API docs

```
http://localhost:8000/docs
```

---

## 18. Testing Checklist

Before submitting frontend changes, verify:

**Page & Navigation**
- [ ] Page loads without console errors
- [ ] No secrets or API keys appear in browser console or page source

**Camera & Vision**
- [ ] Camera setup button works and requests permission
- [ ] Frame setup / confirm frame works correctly
- [ ] Switching between Sara panel and Camera panel works
- [ ] Monitoring remains active when Sara panel is open

**Demo Triggers**
- [ ] Each demo safety button creates an alert (check Safety Incident Log)
- [ ] Alert appears in Active Alerts panel

**Caregivers**
- [ ] Caregiver list loads from API
- [ ] Add caregiver form works (submit creates record)
- [ ] Edit caregiver works
- [ ] Delete caregiver removes from list
- [ ] Phone numbers shown are always masked
- [ ] Verification status displays correctly
- [ ] Integration status panel does not hang on "checking"
- [ ] Mock/Demo mode badge is visible when Twilio is not configured

**Medicines**
- [ ] Medicine list loads
- [ ] Add medicine works (with valid HH:MM times)
- [ ] Edit medicine works
- [ ] Trigger Now creates a medicine event
- [ ] Today's events panel shows pending events
- [ ] Marking taken/skipped/snoozed updates status

**Alerts**
- [ ] Active alerts panel shows OPEN and NOTIFYING alerts
- [ ] Accepted alert shows assigned caregiver name
- [ ] Resolve button resolves the alert
- [ ] Request Backup button changes status to HELP_REQUESTED
- [ ] Resolved alerts move to Safety Incident Log

**Mobile**
- [ ] Layout is usable on narrow screens
- [ ] Forms and buttons are tappable on mobile

---

## 19. Frontend Design Guidance

The existing design is a **dark, premium healthcare-tech UI**. Maintain this direction.

### Design Principles
- Dark background (`#0f172a` base, `#1e293b` cards)
- Clean card-based layout with subtle borders
- Compact but readable forms
- Clear status badges (colored)
- Responsive grid layout
- Easy to use for non-technical caregivers
- Important actions visible without scrolling
- Destructive actions require confirmation

### Typography
- **Outfit** (Google Font) — used throughout the existing UI

### Color System (approximate)
| Token | Use |
|---|---|
| `#0f172a` | Page background |
| `#1e293b` | Cards / panels |
| `#334155` | Borders, dividers |
| `#f8fafc` | Primary text |
| `#94a3b8` | Secondary/muted text |
| `#10b981` | Success / verified / resolved |
| `#ef4444` | Error / critical / danger |
| `#f59e0b` | Warning / urgent / pending |
| `#3b82f6` | Info / accepted / primary action |
| `#8b5cf6` | Sara / AI accent |

### Badge Labels in Use
```
Active        Pending       Verified      Demo Mode
Not Configured   Open       Accepted      Backup Requested
Resolved      Critical      Urgent        Routine
Mock Mode     Unverified    Busy          Off Duty
```

---

## 20. Priority Frontend Improvements

Improve these areas, in order of priority:

1. **Caregiver Coordination section** — make the card layout cleaner, show availability and verification at a glance, improve the add-caregiver form UX
2. **Medicine Routine section** — simplify the add-medicine form, make today's events more readable, make Trigger Now more prominent
3. **Active Alerts panel** — improve empty state, show status lifecycle clearly, make Resolve and Request Backup actions obvious
4. **Empty states** — all list sections should show a helpful empty state when no data is present
5. **Loading and error states** — add spinners during API calls, show inline error messages on failure
6. **Mobile layout** — ensure all panels are usable on a phone screen
7. **Camera and Sara panel** — keep these visually strong; they are the most patient-facing parts
8. **Mock/Demo mode clarity** — make it immediately obvious when the system is in demo mode (no real messages being sent)
9. **Avoid overcrowding** — group settings that are rarely needed, use expandable sections where appropriate
10. **Keep working flows intact** — do not refactor API calls that are currently working

---

## 21. What Must Not Be Broken

> These are critical to preserve. Do not refactor, remove, or bypass:

| Feature | Why |
|---|---|
| `POST /trugen-alert` | TruGen AI sends alerts here — must remain functional |
| `GET /alerts` | Legacy safety incident log fetch |
| Camera setup flow | Core safety monitoring entry point |
| Vision detection script (`vision.js`) | Powers all camera-based alerts |
| TruGen iframe / Sara panel | Patient-facing AI companion |
| Safety incident log rendering | Audit trail of all events |
| Medicine trigger endpoint | Manual and scheduled supervision alerts |
| Caregiver CRUD APIs | Foundation of alert routing |
| Alert coordination APIs | Accept / backup / resolve flows |
| Local run command (`uvicorn backend.main:app`) | Must work for development |
| Render deployment support | `Procfile`, `Dockerfile`, `render.yaml` must remain intact |

---

## 22. Database Schema Summary

For reference, these are the main database tables:

| Table | Purpose |
|---|---|
| `patients` | Patient profile (name, age, condition) |
| `caregivers` | Caregiver records (phone masked in API responses) |
| `caregiver_verifications` | One-time token records for WhatsApp verification |
| `medicines` | Medicine schedule definitions |
| `medicine_events` | Per-event records (pending/taken/skipped/snoozed) |
| `alerts` | All safety alerts (open, active, resolved) |
| `alert_assignments` | Which caregivers were notified for each alert |
| `alert_deliveries` | Twilio delivery logs per caregiver per alert |
| `call_attempts` | Voice call attempt logs |
| `backup_requests` | Backup/HELP request records |

---

## 23. Current Known Limitations

| Limitation | Details |
|---|---|
| Twilio WhatsApp requires real credentials | Mock mode is used when credentials are absent. No real messages are sent in demo mode. |
| Twilio Sandbox requires opt-in | Recipients must opt in to the Twilio WhatsApp sandbox. A production sender avoids this. |
| Render Free tier sleeps | The medicine scheduler background loop stops running during server idle. Use an external cron for reliable production scheduling. |
| SQLite is local only | `saracare.db` is created locally and is gitignored. Set `DATABASE_URL` for PostgreSQL in production. |
| Camera detection is heuristic | Pose detection in `vision.js` uses browser-side heuristics. It may have false positives and misses. It is not clinically validated. |
| TruGen session limits | TruGen AI sessions may expire. Camera monitoring must continue independently. |
| First-accept race condition | The atomic DB update prevents double-assignment, but this only works under normal load. High-concurrency production scenarios should use a proper database row-level lock (handled by PostgreSQL). |
| Voice call accept via phone | The press-1 TwiML flow works when Twilio calls a real number. Not testable in mock mode. |

---

*Last updated: June 2026*  
*Maintained by the SaraCare development team.*
