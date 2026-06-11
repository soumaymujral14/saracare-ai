// ============================================================
// app.js — SaraCare AI Patient Safety Monitor
//
// ARCHITECTURE:
//   Layer A: Continuous Patient Safety Monitor
//     - Camera stream (webcamStream)
//     - MediaPipe Pose detection (vision.js / VisionMonitor)
//     - Alert polling from backend
//     - Medicine reminders
//     - Caregiver alerts (WhatsApp/mock)
//
//   Layer B: TruGen Sara Conversation (optional, independent)
//     - iframe-based AI companion
//     - Can start, end, reconnect without affecting Layer A
//     - Sara ending does NOT stop monitoring
// ============================================================

// ── Backend URL ──────────────────────────────────────────────
const BACKEND_URL = window.location.port === '8080' ? 'http://localhost:8000' : '';

// ── State ────────────────────────────────────────────────────
let isMonitoring = false;          // camera stream is live
let isCalibrated = false;          // monitoring frame confirmed by caregiver
let activeView = 'camera';         // 'sara' | 'camera'
let trugenSessionActive = false;   // Sara iframe is loaded
let voiceMuted = false;            // safety speech muted

let webcamStream = null;
let lastSeenTimestamp = null;
let audioCtx = null;
let alarmInterval = null;
let pollingInterval = null;
let medicineIntervalId = null;
let lastTriggeredMedTimeStr = '';

const TRUGEN_AGENT_ID = 'e5957c79-9dff-47d2-ba2f-577fc9a0f3b2';
const TRUGEN_EMBED_BASE = 'https://app.trugen.ai/embed/';

// ── DOM Ready ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    loadProfile();

    document.getElementById('profile-form').addEventListener('submit', saveProfile);
    document.getElementById('trigger-med-now-btn').addEventListener('click', () => triggerMedicineAlert());
    document.getElementById('global-mute-btn').addEventListener('click', dismissAlarm);
    document.getElementById('close-modal-btn').addEventListener('click', dismissAlarm);

    const timeInput = document.getElementById('reminder-time');
    if (timeInput) {
        timeInput.addEventListener('input', updateReminderTimeDisplay);
        timeInput.addEventListener('change', updateReminderTimeDisplay);
    }

    // Register vision event handler
    if (window.VisionMonitor) {
        window.VisionMonitor.onEvent(onVisionEvent);
    }

    // Initial safety badge
    setSafetyBadge('safe', 'STATUS: SETUP');
    setStatus('inactive', 'Camera Setup Required');
    updateDualStatus();

    // Initial fetch of caregiver coordination panels
    fetchCaregivers();
    fetchMedicines();
    fetchMedicineEventsToday();
    fetchRoutingSettings();
    fetchActiveAlerts();
    fetchIntegrationStatus();
});

// ── 12-hour Format Helpers ────────────────────────────────────
function convertTo12HourFormat(time24) {
    if (!time24) return '';
    const parts = time24.split(':');
    if (parts.length < 2) return time24;
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
}

function updateReminderTimeDisplay() {
    const val = document.getElementById('reminder-time').value;
    const el = document.getElementById('reminder-time-display');
    if (el) el.innerText = val ? `(${convertTo12HourFormat(val)})` : '';
}

// ── Profile ───────────────────────────────────────────────────
function loadProfile() {
    const p = JSON.parse(localStorage.getItem('saracare_profile') || 'null');
    if (p) {
        document.getElementById('patient-name').value = p.patientName || 'Eleanor Vance';
        document.getElementById('patient-age').value = p.patientAge || '82';
        document.getElementById('patient-condition').value = p.patientCondition || 'Recovering from hip surgery, high fall risk';
        document.getElementById('caregiver-name').value = p.caregiverName || 'David Vance';
        document.getElementById('caregiver-phone').value = p.caregiverPhone || '+1 (555) 019-2834';
        document.getElementById('reminder-time').value = p.reminderTime || '08:00';
    }
    updateReminderTimeDisplay();
}

function saveProfile(e) {
    if (e) e.preventDefault();
    const p = {
        patientName: document.getElementById('patient-name').value,
        patientAge: document.getElementById('patient-age').value,
        patientCondition: document.getElementById('patient-condition').value,
        caregiverName: document.getElementById('caregiver-name').value,
        caregiverPhone: document.getElementById('caregiver-phone').value,
        reminderTime: document.getElementById('reminder-time').value
    };
    localStorage.setItem('saracare_profile', JSON.stringify(p));
    const btn = document.querySelector('#profile-form button[type="submit"]');
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Profile Saved!`;
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
}

// ── Audio Engine ──────────────────────────────────────────────
function unlockAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(0);
    osc.stop(0.1);
}

function playAlarmSound() {
    if (!audioCtx || alarmInterval) return;
    alarmInterval = setInterval(() => {
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime((Math.floor(Date.now() / 600) % 2) ? 660 : 880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    }, 600);
}

function stopAlarmSound() {
    if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
}

// ── Voice Mute Toggle ─────────────────────────────────────────
window.toggleVoiceMute = function() {
    voiceMuted = !voiceMuted;
    if (window.VisionMonitor) window.VisionMonitor.setMuted(voiceMuted);
    if (voiceMuted && window.speechSynthesis) window.speechSynthesis.cancel();
    const icon = document.getElementById('voice-mute-icon');
    if (icon) {
        icon.className = voiceMuted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
    }
    const btn = document.getElementById('voiceMuteBtn');
    if (btn) {
        btn.title = voiceMuted ? 'Safety voice muted — click to unmute' : 'Mute/unmute safety voice';
        btn.style.borderColor = voiceMuted ? 'rgba(239,68,68,0.5)' : '';
        btn.style.color = voiceMuted ? '#fca5a5' : '';
    }
    console.log('[SaraCare] Safety voice', voiceMuted ? 'MUTED' : 'UNMUTED');
};

// ── Dual Status Bar ───────────────────────────────────────────
function updateDualStatus() {
    // Camera chip
    setChip('chip-camera-dot', 'chip-camera-text',
        isMonitoring ? 'active' : 'inactive',
        isMonitoring ? 'Camera Active' : 'Camera Offline');

    // Frame chip
    setChip('chip-frame-dot', 'chip-frame-text',
        isCalibrated ? 'active' : 'inactive',
        isCalibrated ? 'Frame Configured' : 'Frame Not Set');

    // Sara chip
    setChip('chip-sara-dot', 'chip-sara-text',
        trugenSessionActive ? 'active' : 'inactive',
        trugenSessionActive ? 'Sara Active' : 'Sara Offline');

    // Companion metrics
    const guardEl = document.getElementById('guard-status');
    const poseEl = document.getElementById('pose-status');
    const saraMet = document.getElementById('sara-metric-status');
    if (guardEl) guardEl.innerText = isMonitoring ? 'Active' : 'Offline';
    if (poseEl) {
        const ready = window.VisionMonitor && window.VisionMonitor.isReady();
        poseEl.innerText = !isCalibrated ? 'Not Started' : (ready ? 'Active' : 'Unavailable');
    }
    if (saraMet) saraMet.innerText = trugenSessionActive ? 'Active' : 'Offline';
}

function setChip(dotId, textId, statusClass, text) {
    const dot = document.getElementById(dotId);
    const textEl = document.getElementById(textId);
    if (dot) dot.className = `status-indicator-dot ${statusClass}`;
    if (textEl) textEl.innerText = text;
}

// ── LAYER A: Camera Setup ──────────────────────────────────────
window.startCameraSetup = async function() {
    if (isMonitoring) {
        // Stream already live — re-show checklist
        enterSetupChecklistUI();
        return;
    }

    const setupBtn = document.getElementById('startCameraSetupBtn');
    if (setupBtn) { setupBtn.disabled = true; setupBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Starting camera…`; }

    setStatus('inactive', 'Requesting camera…');
    unlockAudio();

    const errEl = document.getElementById('camera-error-msg');
    if (errEl) errEl.classList.add('hidden');

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Camera API not available in this browser.');
        }

        webcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        isMonitoring = true;

        const video = document.getElementById('webcam');
        video.srcObject = webcamStream;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.autoplay = true;
        video.classList.remove('hidden');
        try { await video.play(); } catch(e) { console.warn('[SaraCare] video.play():', e); }

        console.log('[SaraCare] Camera stream started.');
        enterSetupChecklistUI();

        if (setupBtn) { setupBtn.disabled = false; setupBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Start Camera Setup`; }
        showEl('requestStopMonitoringBtn');
        showEl('voiceMuteBtn');

        // Medicine reminder
        if (!medicineIntervalId) medicineIntervalId = setInterval(checkMedicineReminder, 5000);

    } catch (err) {
        let msg = 'Unknown camera error.';
        if (err.name === 'NotAllowedError') msg = 'Camera permission denied. Please allow access and retry.';
        else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
        else if (err.name === 'NotReadableError') msg = 'Camera already in use by another application.';
        else msg = err.message || String(err);

        console.error('[SaraCare] Camera error:', msg);
        if (setupBtn) { setupBtn.disabled = false; setupBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Start Camera Setup`; }
        showCameraError(msg);
        setStatus('inactive', 'Camera Setup Required');
    }

    updateDualStatus();
};

function enterSetupChecklistUI() {
    hideEl('camera-setup-panel');
    hideEl('sara-companion-container');
    hideEl('view-switch-container');

    const video = document.getElementById('webcam');
    if (webcamStream && video) video.classList.remove('hidden');

    const checkbox = document.getElementById('frame-confirm-check');
    if (checkbox) checkbox.checked = false;
    const setFrameBtn = document.getElementById('setFrameBtn');
    if (setFrameBtn) setFrameBtn.disabled = true;

    showEl('camera-setup-checklist');
    setStatus('active', 'Camera Setup Mode — Adjust frame then confirm');
    setSafetyBadge('safe', 'SETUP MODE');

    document.getElementById('sara-companion-status-text').innerText = '"Complete camera setup to activate Sara."';
    updateDualStatus();
}

function showCameraError(msg) {
    const el = document.getElementById('camera-error-msg');
    if (el) {
        el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${msg} <button class="btn btn-secondary btn-small" style="margin-left:0.5rem;" onclick="window.startCameraSetup()">Retry Camera</button>`;
        el.classList.remove('hidden');
        showEl('camera-setup-checklist');
        hideEl('camera-setup-panel');
    }
}

// ── Frame confirm checkbox ────────────────────────────────────
window.onFrameCheckboxChange = function() {
    const cb = document.getElementById('frame-confirm-check');
    const btn = document.getElementById('setFrameBtn');
    if (btn) btn.disabled = !cb.checked;
};

// ── Confirm Monitoring Frame (starts vision layer) ────────────
window.confirmMonitoringFrame = async function() {
    if (!webcamStream) { showCameraError('No camera stream. Restart camera setup.'); return; }

    isCalibrated = true;
    localStorage.setItem('saracare_calibration_state', JSON.stringify({ calibrated: true, timestamp: new Date().toISOString() }));

    hideEl('camera-setup-checklist');
    hideEl('camera-setup-panel');

    setStatus('active', 'Camera Monitoring Active — Frame Configured');
    setSafetyBadge('safe', 'STATUS: SAFE');

    showEl('reconfigureFrameBtn');

    const setupBtn = document.getElementById('startCameraSetupBtn');
    if (setupBtn) { setupBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Frame Configured`; setupBtn.disabled = true; setupBtn.classList.remove('btn-glow'); }

    document.getElementById('sara-companion-status-text').innerText = '"Camera monitoring active. Talk to Sara anytime."';

    showEl('view-switch-container');

    // ── Start polling backend
    startPolling();

    // ── Start pose detection (Layer A — independent from Sara)
    const video = document.getElementById('webcam');
    if (window.VisionMonitor && video) {
        console.log('[SaraCare] Starting VisionMonitor...');
        window.VisionMonitor.start(video); // async, non-blocking
    }

    updateDualStatus();

    // ── Auto-switch to Sara view
    switchView('sara', true);
};

// ── VIEW SWITCH ───────────────────────────────────────────────
window.switchView = function(view, isAutoLaunch) {
    activeView = view;

    const sara = document.getElementById('sara-companion-container');
    const video = document.getElementById('webcam');
    const btnSara = document.getElementById('view-btn-sara');
    const btnCam = document.getElementById('view-btn-camera');

    if (view === 'sara') {
        if (sara) {
            sara.classList.remove('hidden');
            if (isAutoLaunch) { sara.classList.add('animate-in'); setTimeout(() => sara.classList.remove('animate-in'), 400); }
        }
        if (btnSara) btnSara.classList.add('active');
        if (btnCam) btnCam.classList.remove('active');

        if (!trugenSessionActive) initSaraIframe();

        // Don't label overall status as monitoring status — Sara is a separate layer
        setStatus('active', 'Camera Monitoring Active');

    } else {
        if (sara) sara.classList.add('hidden');
        if (btnSara) btnSara.classList.remove('active');
        if (btnCam) btnCam.classList.add('active');
        if (video) video.classList.remove('hidden');
        setStatus('active', 'Live Camera View — Monitoring Active');
    }
};

// ── LAYER B: TruGen Sara Iframe ───────────────────────────────
function buildSaraIframeSrc() {
    const name = document.getElementById('patient-name').value || 'Patient';
    const age = document.getElementById('patient-age').value || '';
    const cond = document.getElementById('patient-condition').value || '';
    const carer = document.getElementById('caregiver-name').value || 'Caregiver';

    const sessionId = btoa(`sc-${name}-${new Date().toISOString().slice(0,10)}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const ctx = encodeURIComponent(`Patient: ${name}${age ? ', Age: ' + age : ''}. Condition: ${cond}. Caregiver: ${carer}. SaraCare safety monitoring is active.`.slice(0, 400));
    return `${TRUGEN_EMBED_BASE}${TRUGEN_AGENT_ID}?username=${encodeURIComponent(name)}&id=${sessionId}&context=${ctx}`;
}

function initSaraIframe() {
    showSaraState('connecting');
    setSaraChip('inactive', 'Connecting…');

    const wrapper = document.getElementById('sara-iframe-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';

    const src = buildSaraIframeSrc();
    console.log('[SaraCare] TruGen iframe src:', src);

    const iframe = document.createElement('iframe');
    iframe.id = 'trugenAgentFrame';
    iframe.src = src;
    iframe.allow = 'camera; microphone; fullscreen; display-capture';
    iframe.title = 'SaraCare Sara AI Companion';

    iframe.onload = () => {
        console.log('[SaraCare] TruGen iframe loaded.');
        trugenSessionActive = true;
        showSaraState('active');
        showEl('sara-active-controls');
        setSaraChip('active', 'Sara Active');
        updateDualStatus();

        // Non-blocking camera conflict heads-up (disappears after 8 s)
        setTimeout(() => {
            const notice = document.getElementById('cam-conflict-notice');
            if (notice) { notice.classList.remove('hidden'); setTimeout(() => notice.classList.add('hidden'), 8000); }
        }, 2500);
    };

    iframe.onerror = () => {
        console.error('[SaraCare] TruGen iframe failed.');
        trugenSessionActive = false;
        showSaraState('error');
        setSaraChip('inactive', 'Sara Offline');
        updateDualStatus();
    };

    wrapper.appendChild(iframe);
    showEl('sara-iframe-wrapper');
}

function showSaraState(state) {
    hideEl('sara-state-unavailable');
    hideEl('sara-state-connecting');
    hideEl('sara-state-ended');
    hideEl('sara-state-error');
    if (state !== 'active') showEl(`sara-state-${state}`);
}

function setSaraChip(statusClass, text) {
    setChip('chip-sara-dot', 'chip-sara-text', statusClass, text);
    const saraMet = document.getElementById('sara-metric-status');
    if (saraMet) saraMet.innerText = text;
}

window.retrySara = function() {
    trugenSessionActive = false;
    hideEl('sara-active-controls');
    const w = document.getElementById('sara-iframe-wrapper');
    if (w) { w.innerHTML = ''; hideEl('sara-iframe-wrapper'); }
    initSaraIframe();
};

window.endSaraSession = function() {
    const w = document.getElementById('sara-iframe-wrapper');
    if (w) { w.innerHTML = ''; hideEl('sara-iframe-wrapper'); }
    trugenSessionActive = false;
    hideEl('sara-active-controls');
    showSaraState('ended');
    setSaraChip('inactive', 'Session Ended');
    updateDualStatus();

    // NOTE: Camera monitoring (Layer A) continues uninterrupted
    console.log('[SaraCare] Sara session ended. Camera monitoring and pose detection remain active.');
    if (window.VisionMonitor && window.VisionMonitor.isReady()) {
        console.log('[SaraCare] Vision monitor: still running.');
    }
};

// ── Reconfigure Frame ─────────────────────────────────────────
window.reconfigureFrame = function() {
    isCalibrated = false;
    localStorage.removeItem('saracare_calibration_state');
    trugenSessionActive = false;

    hideEl('sara-companion-container');
    hideEl('view-switch-container');
    hideEl('sara-active-controls');

    const w = document.getElementById('sara-iframe-wrapper');
    if (w) { w.innerHTML = ''; hideEl('sara-iframe-wrapper'); }

    const setupBtn = document.getElementById('startCameraSetupBtn');
    if (setupBtn) { setupBtn.disabled = false; setupBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Start Camera Setup`; setupBtn.classList.add('btn-glow'); }
    hideEl('reconfigureFrameBtn');

    // Reset vision calibration — keep detection loop running
    if (window.VisionMonitor) window.VisionMonitor.resetCalibration();

    if (webcamStream) {
        enterSetupChecklistUI();
    } else {
        showEl('camera-setup-panel');
        setStatus('inactive', 'Camera Setup Required');
        setSafetyBadge('safe', 'STATUS: SETUP');
    }

    document.getElementById('sara-companion-status-text').innerText = '"Complete camera setup to activate Sara."';
    updateDualStatus();
    console.log('[SaraCare] Reconfigure frame. Camera stream preserved:', !!webcamStream);
};

// ── Vision Event Handler ──────────────────────────────────────
// Called by VisionMonitor when a pose event is detected
function onVisionEvent(evt) {
    const patientName = document.getElementById('patient-name').value;
    console.log('[SaraCare] Vision event received:', evt);

    sendAlert({
        patient_name: patientName,
        alert_type: evt.alertType,
        severity: evt.severity,
        message: evt.message,
        source: 'camera_vision',
        confidence: evt.confidence || null
    });

    // Update dual status after vision event
    updateDualStatus();
}

// ── Alarm / Dismiss ───────────────────────────────────────────
function dismissAlarm() {
    stopAlarmSound();
    hideEl('call-modal');
    document.getElementById('live-alert-banner').classList.add('hidden');
    document.getElementById('global-mute-btn').classList.add('hidden');

    if (isMonitoring) {
        setStatus('active', isCalibrated ? 'Camera Monitoring Active' : 'Camera Setup Mode');
        setSafetyBadge('safe', 'STATUS: SAFE');
    }
}

// ── Local Alarm Engine ────────────────────────────────────────
function triggerLocalAlarm(payload, whatsappStatus) {
    if (!isMonitoring) return;

    const banner = document.getElementById('live-alert-banner');
    const bannerText = document.getElementById('live-alert-text');

    if (payload.severity === 'critical') {
        setStatus('alert', 'CRITICAL DANGER');
        setSafetyBadge('emergency', 'STATUS: EMERGENCY');
        if (banner) banner.className = 'live-alert-banner';
        if (bannerText) bannerText.innerText = payload.message.toUpperCase().slice(0, 80);
        playAlarmSound();
    } else if (payload.severity === 'urgent') {
        setStatus('alert', 'ATTENTION REQUIRED');
        setSafetyBadge('attention', 'STATUS: ATTENTION');
        if (banner) banner.className = 'live-alert-banner';
        if (bannerText) bannerText.innerText = payload.message.toUpperCase().slice(0, 80);
        playAlarmSound();
    }

    const statusVal = whatsappStatus || payload.whatsapp_status;
    if (statusVal) {
        const lbl = document.getElementById('status-label');
        if (lbl) lbl.innerText += ` (${statusVal === 'real_whatsapp_sent' ? 'Real WhatsApp' : 'Mock WhatsApp'} sent)`;
    }

    showEl('global-mute-btn');

    if (payload.severity === 'critical' || payload.severity === 'urgent') {
        const cName = document.getElementById('caregiver-name').value;
        const cPhone = document.getElementById('caregiver-phone').value;
        document.getElementById('modal-caregiver-name').innerText = cName;
        document.getElementById('modal-caregiver-phone').innerText = cPhone;
        document.getElementById('modal-alert-msg').innerText = `"${payload.message}"`;
        showEl('call-modal');
        sendMockCall(cName, cPhone, payload.message);
    }
}

// ── Backend API ───────────────────────────────────────────────
async function sendAlert(payload) {
    try {
        const resp = await fetch(`${BACKEND_URL}/alert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error('Backend error');
        const result = await resp.json();

        if (result.alert && result.alert.timestamp) {
            lastSeenTimestamp = new Date(result.alert.timestamp).getTime();
        }
        if (payload.severity === 'urgent' || payload.severity === 'critical') {
            triggerLocalAlarm(payload, result.whatsapp_status);
        }
        fetchAlerts();
    } catch (err) {
        console.error('[SaraCare] sendAlert failed:', err);
    }
}

async function sendMockCall(name, phone, message) {
    try {
        await fetch(`${BACKEND_URL}/mock-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caregiver_name: name, caregiver_phone: phone, message })
        });
    } catch (e) { console.error('[SaraCare] Mock call error:', e); }
}

// ── Demo Triggers ─────────────────────────────────────────────
window.triggerAlert = function(type) {
    const name = document.getElementById('patient-name').value;
    let severity = 'routine', message = '';
    switch(type) {
        case 'fall':      severity = 'critical'; message = `Possible fall detected for ${name}. Rapid movement and impact detected.`; break;
        case 'risky_movement': severity = 'urgent'; message = `Risky movement alert: ${name} is attempting bed exit without support.`; break;
        case 'frame_exit': severity = 'urgent'; message = `Frame exit warning: ${name} is no longer visible in safety monitoring zone.`; break;
        case 'medicine':   severity = 'routine';
            const t = convertTo12HourFormat(document.getElementById('reminder-time').value);
            message = `Medicine reminder: It is time for ${name}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${t})`; break;
        case 'voice_help': severity = 'urgent'; message = `Acoustic voice safety alert: ${name} called out for help.`; break;
        case 'emergency':  severity = 'critical'; message = `CRITICAL WARNING: Manual emergency button activated by patient ${name}.`; break;
    }
    sendAlert({ patient_name: name, alert_type: type, severity, message });
};

// ── Medicine Reminder ─────────────────────────────────────────
function triggerMedicineAlert(customMsg) {
    const name = document.getElementById('patient-name').value;
    const t = convertTo12HourFormat(document.getElementById('reminder-time').value);
    const msg = customMsg || `Medicine reminder: It is time for ${name}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${t})`;
    sendAlert({ patient_name: name, alert_type: 'medicine', severity: 'routine', message: msg });
}

function checkMedicineReminder() {
    const rt = document.getElementById('reminder-time').value;
    if (!rt) return;
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const id = `${date} ${rt}`;
    if (`${hh}:${mm}` === rt && lastTriggeredMedTimeStr !== id) {
        lastTriggeredMedTimeStr = id;
        const name = document.getElementById('patient-name').value;
        const t = convertTo12HourFormat(rt);
        triggerMedicineAlert(`Medicine reminder: It is time for ${name}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${t})`);
    }
}

// ── Polling ───────────────────────────────────────────────────
function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    fetchAlerts();
    pollingInterval = setInterval(fetchAlerts, 2000);
}

async function fetchAlerts() {
    try {
        const resp = await fetch(`${BACKEND_URL}/alerts`);
        if (!resp.ok) throw new Error('Fetch failed');
        const alerts = await resp.json();
        updateTimelineUI(alerts);

        if (alerts.length > 0) {
            const latest = alerts[0];
            const latestTime = new Date(latest.timestamp).getTime();
            if (!lastSeenTimestamp) {
                lastSeenTimestamp = latestTime;
            } else if (latestTime > lastSeenTimestamp) {
                lastSeenTimestamp = latestTime;
                if (latest.alert_type === 'stop_monitoring_approved') {
                    executeStopMonitoringSequence();
                } else {
                    triggerLocalAlarm(latest, latest.whatsapp_status);
                }
            }
        }
        
        // Dynamic dashboard refresh
        fetchActiveAlerts();
        fetchMedicineEventsToday();
        fetchCaregivers();
        fetchIntegrationStatus();
    } catch (e) { console.error('[SaraCare] Poll error:', e); }
}

// ── Stop Monitoring (caregiver approval flow) ─────────────────
window.requestStopMonitoring = async function() {
    const name = document.getElementById('patient-name').value;
    const cName = document.getElementById('caregiver-name').value;
    const cPhone = document.getElementById('caregiver-phone').value;
    const btn = document.getElementById('requestStopMonitoringBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Requesting…`; }

    try {
        const resp = await fetch(`${BACKEND_URL}/request-stop-monitoring`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_name: name, caregiver_name: cName, caregiver_whatsapp: cPhone })
        });
        if (!resp.ok) throw new Error('Backend error');
        const result = await resp.json();
        showEl('simulateApprovalBtn');
        const lbl = result.whatsapp_status === 'real_whatsapp_sent' ? 'Real WhatsApp sent' : 'Mock WhatsApp sent';
        setStatus('active', `Approval pending (${lbl})`);
        if (btn) btn.innerHTML = `<i class="fa-solid fa-clock"></i> Approval Pending`;
        fetchAlerts();
    } catch (e) {
        console.error('[SaraCare] Stop request error:', e);
        showEl('simulateApprovalBtn');
        if (btn) btn.innerHTML = `<i class="fa-solid fa-clock"></i> Approval Pending`;
        setStatus('active', 'Mock WhatsApp approval request sent.');
    }
};

window.simulateApproval = async function() {
    const name = document.getElementById('patient-name').value;
    const btn = document.getElementById('simulateApprovalBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Approving…`; }
    try {
        const resp = await fetch(`${BACKEND_URL}/approve-stop-monitoring`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_name: name, approved_by: 'caregiver' })
        });
        if (!resp.ok) throw new Error();
        executeStopMonitoringSequence();
    } catch(e) { executeStopMonitoringSequence(); }
};

function executeStopMonitoringSequence() {
    // Stop vision detection first
    if (window.VisionMonitor) window.VisionMonitor.stop();

    // Stop camera tracks
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
    const video = document.getElementById('webcam');
    if (video) { video.srcObject = null; video.classList.add('hidden'); }

    // Destroy Sara iframe
    const w = document.getElementById('sara-iframe-wrapper');
    if (w) w.innerHTML = '';
    trugenSessionActive = false;
    hideEl('sara-companion-container');
    hideEl('view-switch-container');
    hideEl('sara-active-controls');
    hideEl('reconfigureFrameBtn');
    hideEl('voiceMuteBtn');

    // Show stopped state
    const panel = document.getElementById('camera-setup-panel');
    if (panel) {
        panel.classList.remove('hidden');
        const init = document.getElementById('setup-initial-state');
        if (init) init.innerHTML = `
            <i class="fa-solid fa-circle-pause" style="font-size:3rem;color:var(--accent);animation:pulse 2s infinite;"></i>
            <p class="setup-title">Monitoring Stopped</p>
            <p class="setup-desc">Caregiver has approved the request to stop monitoring. The patient camera is offline.</p>
        `;
    }

    setStatus('inactive', 'Monitoring Stopped');
    setSafetyBadge('safe', 'STATUS: STOPPED');

    isMonitoring = false;
    isCalibrated = false;
    localStorage.removeItem('saracare_calibration_state');

    stopAlarmSound();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
    if (medicineIntervalId) { clearInterval(medicineIntervalId); medicineIntervalId = null; }

    hideEl('requestStopMonitoringBtn');
    const simBtn = document.getElementById('simulateApprovalBtn');
    if (simBtn) { simBtn.classList.add('hidden'); simBtn.disabled = false; simBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Simulate Caregiver Approval`; }

    const setupBtn = document.getElementById('startCameraSetupBtn');
    if (setupBtn) { setupBtn.disabled = false; setupBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Start Camera Setup`; setupBtn.classList.add('btn-glow'); }

    document.getElementById('sara-companion-status-text').innerText = '"Monitoring stopped. Start a new session to reactivate."';
    updateDualStatus();
    console.log('[SaraCare] All monitoring stopped. Camera tracks halted. Vision stopped.');
}

// ── Timeline UI ───────────────────────────────────────────────
function updateTimelineUI(alerts) {
    const timeline = document.getElementById('timeline');
    const placeholder = document.getElementById('timeline-placeholder');
    const badge = document.getElementById('timeline-count');

    badge.innerText = `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`;

    if (alerts.length === 0) { timeline.innerHTML = ''; placeholder.classList.remove('hidden'); return; }
    placeholder.classList.add('hidden');

    const iconMap = {
        fall: 'fa-user-ninja', risky_movement: 'fa-person-walking-arrow-loop-left',
        frame_exit: 'fa-door-open', medicine: 'fa-pills', voice_help: 'fa-microphone-lines',
        emergency: 'fa-circle-exclamation', stop_monitoring_requested: 'fa-hand',
        stop_monitoring_approved: 'fa-check-double', no_person_detected: 'fa-eye-slash',
        standing_attempt: 'fa-person-walking', patient_leaving_frame: 'fa-person-running'
    };

    timeline.innerHTML = alerts.map(a => {
        const t = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const icon = iconMap[a.alert_type] || 'fa-bell';
        const sourceTag = a.source === 'camera_vision' ? `<span class="source-tag vision-tag"><i class="fa-solid fa-eye"></i> Vision</span>` : '';
        return `
        <div class="timeline-item ${a.severity}">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
                <div class="timeline-header">
                    <span class="timeline-title"><i class="fa-solid ${icon}"></i> ${capitalizeFirst(a.alert_type.replace(/_/g, ' '))} ${sourceTag}</span>
                    <span class="timeline-time">${t}</span>
                </div>
                <div class="timeline-body">${a.message}</div>
                <div style="margin-top:5px;"><span class="severity-pill">${a.severity}</span></div>
            </div>
        </div>`;
    }).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function capitalizeFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function showEl(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hideEl(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

function setStatus(type, text) {
    const dot = document.getElementById('status-dot');
    const lbl = document.getElementById('status-label');
    if (dot) dot.className = `status-indicator-dot ${type}`;
    if (lbl) lbl.innerText = text;
}

function setSafetyBadge(cls, text) {
    const badge = document.getElementById('safety-badge');
    if (badge) { badge.className = `safety-badge ${cls}`; badge.innerText = text; }
}

// ============================================================
// CAREGIVER COORDINATION & MEDICINE ROUTINE DASHBOARD HANDLERS
// ============================================================

// --- CAREGIVER FUNCTIONS ---
async function fetchCaregivers() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/caregivers`);
        if (!resp.ok) throw new Error('Failed to load caregivers');
        const caregivers = await resp.json();
        renderCaregivers(caregivers);
    } catch (e) {
        console.error('[SaraCare] fetchCaregivers error:', e);
    }
}

function renderCaregivers(caregivers) {
    const list = document.getElementById('caregivers-list');
    if (!list) return;
    
    if (caregivers.length === 0) {
        list.innerHTML = `<p class="placeholder-text">No caregivers registered yet.</p>`;
        return;
    }
    
    list.innerHTML = caregivers.map(c => {
        const statusBadgeClass = c.availability === 'available' ? 'badge-green' : (c.availability === 'busy' ? 'badge-orange' : 'badge-gray');
        const verifyBadgeClass = c.verification_status === 'verified' ? 'badge-green' : (c.verification_status === 'pending' ? 'badge-orange' : 'badge-red');
        
        return `
        <div class="caregiver-card-item" id="cg-card-${c.id}">
            <div class="caregiver-header">
                <div class="caregiver-info">
                    <h3>${c.name}</h3>
                    <span class="role-tag">${c.role || 'Caregiver'} (Priority: ${c.priority})</span>
                </div>
                <div class="caregiver-status-chips">
                    <span class="badge ${statusBadgeClass}">${c.availability.replace('_', ' ')}</span>
                    <span class="badge ${verifyBadgeClass}">${c.verification_status}</span>
                </div>
            </div>
            
            <div class="caregiver-meta">
                <span><i class="fa-brands fa-whatsapp"></i> WhatsApp: ${c.whatsapp_number_masked}</span>
                <span><i class="fa-solid fa-phone"></i> Calls: ${c.calling_number_masked}</span>
                <span style="font-size:0.75rem; color: var(--text-muted);">
                    Active Assignments: ${c.current_assignments}
                </span>
            </div>
            
            <div class="caregiver-actions-bar">
                <div class="caregiver-status-toggles">
                    <label class="checkbox-container" style="font-size:0.75rem;">
                        <input type="checkbox" ${c.whatsapp_enabled ? 'checked' : ''} onchange="toggleCaregiverAlertChannels(${c.id}, 'whatsapp', this.checked)">
                        <span>WhatsApp</span>
                    </label>
                    <label class="checkbox-container mt-0.25" style="font-size:0.75rem;">
                        <input type="checkbox" ${c.calls_enabled ? 'checked' : ''} onchange="toggleCaregiverAlertChannels(${c.id}, 'calls', this.checked)">
                        <span>Calls</span>
                    </label>
                </div>
                
                <div class="caregiver-buttons">
                    ${c.verification_status !== 'verified' ? `
                    <button class="btn btn-secondary btn-small" onclick="sendCaregiverVerification(${c.id}, this)" title="Send verification WhatsApp">
                        <i class="fa-solid fa-paper-plane"></i> Verify
                    </button>` : `
                    <button class="btn btn-secondary btn-small" onclick="sendTestWhatsApp(${c.id})" title="Send Test WhatsApp">
                        <i class="fa-brands fa-whatsapp"></i> Test WA
                    </button>
                    <button class="btn btn-secondary btn-small" onclick="sendTestCall(${c.id})" title="Send Test Call">
                        <i class="fa-solid fa-phone"></i> Test Call
                    </button>`}
                    
                    <button class="btn btn-secondary btn-small" onclick="openEditCaregiverModal(${JSON.stringify(c).replace(/"/g, '&quot;')})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn btn-danger btn-small" onclick="deleteCaregiver(${c.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>`;
    }).join('');
}

window.openAddCaregiverModal = function() {
    document.getElementById('caregiver-modal-title').innerText = "Add Caregiver";
    document.getElementById('caregiver-form-id').value = "";
    document.getElementById('cg-name').value = "";
    document.getElementById('cg-whatsapp').value = "";
    document.getElementById('cg-phone').value = "";
    document.getElementById('cg-role').value = "";
    document.getElementById('cg-priority').value = "1";
    document.getElementById('cg-availability').value = "available";
    document.getElementById('cg-whatsapp-enabled').checked = true;
    document.getElementById('cg-calls-enabled').checked = true;
    showEl('caregiver-modal');
};

window.openEditCaregiverModal = function(c) {
    document.getElementById('caregiver-modal-title').innerText = "Edit Caregiver";
    document.getElementById('caregiver-form-id').value = c.id;
    document.getElementById('cg-name').value = c.name;
    document.getElementById('cg-whatsapp').value = c.whatsapp_number_masked;
    document.getElementById('cg-phone').value = c.calling_number_masked === c.whatsapp_number_masked ? "" : c.calling_number_masked;
    document.getElementById('cg-role').value = c.role || "";
    document.getElementById('cg-priority').value = c.priority || "1";
    document.getElementById('cg-availability').value = c.availability || "available";
    document.getElementById('cg-whatsapp-enabled').checked = c.whatsapp_enabled;
    document.getElementById('cg-calls-enabled').checked = c.calls_enabled;
    showEl('caregiver-modal');
};

window.closeCaregiverModal = function() {
    hideEl('caregiver-modal');
};

window.saveCaregiverSubmit = async function(e) {
    e.preventDefault();
    const id = document.getElementById('caregiver-form-id').value;
    const name = document.getElementById('cg-name').value;
    const whatsapp = document.getElementById('cg-whatsapp').value;
    const phone = document.getElementById('cg-phone').value;
    const role = document.getElementById('cg-role').value;
    const priority = parseInt(document.getElementById('cg-priority').value) || 1;
    const availability = document.getElementById('cg-availability').value;
    const whatsapp_enabled = document.getElementById('cg-whatsapp-enabled').checked;
    const calls_enabled = document.getElementById('cg-calls-enabled').checked;
    
    const payload = { name, whatsapp_number: whatsapp, calling_number: phone || whatsapp, role, priority, availability, whatsapp_enabled, calls_enabled };
    
    try {
        let resp;
        if (id) {
            resp = await fetch(`${BACKEND_URL}/api/caregivers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            resp = await fetch(`${BACKEND_URL}/api/caregivers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        
        if (!resp.ok) {
            const err = await resp.json();
            alert(`Error: ${err.detail}`);
            return;
        }
        
        closeCaregiverModal();
        fetchCaregivers();
    } catch (e) {
        console.error(e);
        alert('Server error saving caregiver.');
    }
};

window.deleteCaregiver = async function(id) {
    if (!confirm('Are you sure you want to delete this caregiver?')) return;
    try {
        const resp = await fetch(`${BACKEND_URL}/api/caregivers/${id}`, { method: 'DELETE' });
        if (resp.ok) fetchCaregivers();
    } catch (e) { console.error(e); }
};

window.toggleCaregiverAlertChannels = async function(id, channel, checked) {
    try {
        const respList = await fetch(`${BACKEND_URL}/api/caregivers`);
        const list = await respList.json();
        const cg = list.find(c => c.id === id);
        if (!cg) return;
        
        const payload = {
            name: cg.name,
            whatsapp_number: cg.whatsapp_number_masked,
            calling_number: cg.calling_number_masked,
            role: cg.role,
            priority: cg.priority,
            availability: cg.availability,
            whatsapp_enabled: channel === 'whatsapp' ? checked : cg.whatsapp_enabled,
            calls_enabled: channel === 'calls' ? checked : cg.calls_enabled
        };
        
        await fetch(`${BACKEND_URL}/api/caregivers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        fetchCaregivers();
    } catch (e) { console.error(e); }
};

window.sendCaregiverVerification = async function(id, btn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending`;
    
    try {
        const resp = await fetch(`${BACKEND_URL}/api/caregivers/${id}/send-verification`, { method: 'POST' });
        if (resp.ok) {
            btn.innerHTML = `<i class="fa-solid fa-check"></i> Sent`;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
            fetchCaregivers();
        } else {
            const err = await resp.json();
            alert(`Verification failed: ${err.detail}`);
            btn.innerHTML = `<i class="fa-solid fa-xmark"></i> Failed`;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
        }
    } catch (e) {
        console.error(e);
        btn.innerHTML = `<i class="fa-solid fa-xmark"></i> Error`;
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
    }
};

window.sendTestWhatsApp = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/caregivers/${id}/test-whatsapp`, { method: 'POST' });
        if (resp.ok) {
            alert('Test WhatsApp message triggered successfully!');
        } else {
            const err = await resp.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) { console.error(e); }
};

window.sendTestCall = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/caregivers/${id}/test-call`, { method: 'POST' });
        if (resp.ok) {
            alert('Test Voice Call triggered successfully!');
        } else {
            const err = await resp.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) { console.error(e); }
};

// --- ROUTING SETTINGS ---
async function fetchRoutingSettings() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/settings/routing`);
        if (resp.ok) {
            const settings = await resp.json();
            document.getElementById('routing-mode-select').value = settings.mode;
            document.getElementById('critical-broadcast-check').checked = settings.critical_broadcast;
        }
    } catch (e) { console.error(e); }
}

window.updateRoutingSettings = async function() {
    const mode = document.getElementById('routing-mode-select').value;
    const critical = document.getElementById('critical-broadcast-check').checked;
    try {
        await fetch(`${BACKEND_URL}/api/settings/routing?mode=${mode}&critical_broadcast=${critical}`, { method: 'POST' });
    } catch (e) { console.error(e); }
};

// --- INTEGRATION STATUS ---
async function fetchIntegrationStatus() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/integrations/twilio/status`);
        if (resp.ok) {
            const status = await resp.json();
            
            const modeBadge = document.getElementById('twilio-mode-badge');
            const waBadge = document.getElementById('whatsapp-config-badge');
            const voiceBadge = document.getElementById('voice-config-badge');
            
            if (modeBadge) {
                modeBadge.innerText = status.mode === 'real' ? 'Real Mode' : 'Demo Mode';
                modeBadge.className = `badge ${status.mode === 'real' ? 'badge-green' : 'badge-orange'}`;
            }
            if (waBadge) {
                waBadge.innerText = status.whatsapp_number_present ? 'Ready' : 'Missing Number';
                waBadge.className = `badge ${status.whatsapp_number_present ? 'badge-green' : 'badge-red'}`;
            }
            if (voiceBadge) {
                voiceBadge.innerText = status.voice_number_present ? 'Ready' : 'Missing Number';
                voiceBadge.className = `badge ${status.voice_number_present ? 'badge-green' : 'badge-red'}`;
            }
        }
    } catch (e) { console.error(e); }
}

// --- MEDICINE FUNCTIONS ---
async function fetchMedicines() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/medicines`);
        if (resp.ok) {
            const medicines = await resp.json();
            renderMedicineSchedules(medicines);
        }
    } catch (e) { console.error(e); }
}

function renderMedicineSchedules(meds) {
    const list = document.getElementById('med-schedules-list');
    if (!list) return;
    
    if (meds.length === 0) {
        list.innerHTML = `<p class="placeholder-text">No medicine schedules setup.</p>`;
        return;
    }
    
    list.innerHTML = meds.map(m => {
        const timeChips = m.reminder_times.split(',').map(t => `<span class="med-time-chip">${convertTo12HourFormat(t.trim())}</span>`).join('');
        return `
        <div class="medicine-schedule-item">
            <div class="med-schedule-info">
                <h4>${m.name} (${m.dose_instruction})</h4>
                <p>Frequency: ${m.frequency} | Supervision: ${m.requires_supervision ? 'YES' : 'NO'}</p>
                <div class="med-schedule-times">${timeChips}</div>
            </div>
            <div class="med-schedule-actions">
                <button class="btn btn-secondary btn-small" onclick="triggerMedicineNow(${m.id})" title="Trigger Reminder Event Now">
                    <i class="fa-solid fa-play"></i> Trigger
                </button>
                <button class="btn btn-secondary btn-small" onclick="openEditMedicineModal(${JSON.stringify(m).replace(/"/g, '&quot;')})">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="btn btn-danger btn-small" onclick="deleteMedicine(${m.id})">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

async function fetchMedicineEventsToday() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/medicine-events/today`);
        if (resp.ok) {
            const events = await resp.json();
            renderMedicineEvents(events);
        }
    } catch (e) { console.error(e); }
}

function renderMedicineEvents(events) {
    const list = document.getElementById('med-events-list');
    if (!list) return;
    
    if (events.length === 0) {
        list.innerHTML = `<p class="placeholder-text">No reminders triggered today.</p>`;
        return;
    }
    
    list.innerHTML = events.map(e => {
        const statusBadgeClass = e.status === 'taken' ? 'badge-green' : (e.status === 'skipped' ? 'badge-gray' : (e.status === 'snoozed' ? 'badge-orange' : 'badge-red'));
        
        return `
        <div class="medicine-event-item ${e.status}">
            <div class="med-event-header">
                <div class="med-event-title">
                    <h4>${e.medicine_name} (${e.dose_instruction})</h4>
                    <span>Scheduled: ${e.scheduled_time}</span>
                </div>
                <span class="badge ${statusBadgeClass}">${e.status}</span>
            </div>
            ${e.status === 'pending' ? `
            <div class="med-event-actions">
                <button class="btn btn-primary btn-small" style="background:#10b981; border-color:#059669;" onclick="updateMedicineEventStatus(${e.id}, 'taken')">
                    <i class="fa-solid fa-check"></i> Taken
                </button>
                <button class="btn btn-secondary btn-small" style="border-color:#64748b;" onclick="updateMedicineEventStatus(${e.id}, 'skipped')">
                    <i class="fa-solid fa-xmark"></i> Skip
                </button>
                <div class="snooze-options">
                    <button class="btn btn-secondary btn-small">
                        <i class="fa-solid fa-bell"></i> Snooze
                    </button>
                    <div class="snooze-dropdown">
                        <button onclick="updateMedicineEventStatus(${e.id}, 'snoozed', 5)">5 min</button>
                        <button onclick="updateMedicineEventStatus(${e.id}, 'snoozed', 10)">10 min</button>
                        <button onclick="updateMedicineEventStatus(${e.id}, 'snoozed', 15)">15 min</button>
                    </div>
                </div>
            </div>` : ''}
        </div>`;
    }).join('');
}

window.openAddMedicineModal = function() {
    document.getElementById('medicine-modal-title').innerText = "Add Medicine";
    document.getElementById('medicine-form-id').value = "";
    document.getElementById('med-name').value = "";
    document.getElementById('med-dose').value = "";
    document.getElementById('med-times').value = "";
    document.getElementById('med-frequency').value = "once daily";
    document.getElementById('med-food').value = "";
    document.getElementById('med-notes').value = "";
    document.getElementById('med-supervision').checked = true;
    document.getElementById('med-active').checked = true;
    showEl('medicine-modal');
};

window.openEditMedicineModal = function(m) {
    document.getElementById('medicine-modal-title').innerText = "Edit Medicine";
    document.getElementById('medicine-form-id').value = m.id;
    document.getElementById('med-name').value = m.name;
    document.getElementById('med-dose').value = m.dose_instruction;
    document.getElementById('med-times').value = m.reminder_times;
    document.getElementById('med-frequency').value = m.frequency;
    document.getElementById('med-food').value = m.before_after_food || "";
    document.getElementById('med-notes').value = m.notes || "";
    document.getElementById('med-supervision').checked = m.requires_supervision;
    document.getElementById('med-active').checked = m.active;
    showEl('medicine-modal');
};

window.closeMedicineModal = function() {
    hideEl('medicine-modal');
};

window.saveMedicineSubmit = async function(e) {
    e.preventDefault();
    const id = document.getElementById('medicine-form-id').value;
    const name = document.getElementById('med-name').value;
    const dose = document.getElementById('med-dose').value;
    const times = document.getElementById('med-times').value;
    const frequency = document.getElementById('med-frequency').value;
    const food = document.getElementById('med-food').value;
    const notes = document.getElementById('med-notes').value;
    const supervision = document.getElementById('med-supervision').checked;
    const active = document.getElementById('med-active').checked;
    
    const payload = { name, dose_instruction: dose, reminder_times: times, frequency, before_after_food: food || null, notes: notes || null, requires_supervision: supervision, active };
    
    try {
        let resp;
        if (id) {
            resp = await fetch(`${BACKEND_URL}/api/medicines/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            resp = await fetch(`${BACKEND_URL}/api/medicines`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        
        if (!resp.ok) {
            const err = await resp.json();
            alert(`Error: ${err.detail}`);
            return;
        }
        
        closeMedicineModal();
        fetchMedicines();
        fetchMedicineEventsToday();
    } catch (e) {
        console.error(e);
        alert('Server error saving medicine.');
    }
};

window.deleteMedicine = async function(id) {
    if (!confirm('Are you sure you want to delete this medicine schedule?')) return;
    try {
        const resp = await fetch(`${BACKEND_URL}/api/medicines/${id}`, { method: 'DELETE' });
        if (resp.ok) {
            fetchMedicines();
            fetchMedicineEventsToday();
        }
    } catch (e) { console.error(e); }
};

window.triggerMedicineNow = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/medicines/${id}/trigger`, { method: 'POST' });
        if (resp.ok) {
            fetchMedicineEventsToday();
        }
    } catch (e) { console.error(e); }
};

window.updateMedicineEventStatus = async function(id, statusVal, snoozeMins = null) {
    let url = `${BACKEND_URL}/api/medicine-events/${id}/status?status_val=${statusVal}`;
    if (snoozeMins) url += `&snooze_minutes=${snoozeMins}`;
    
    try {
        const resp = await fetch(url, { method: 'POST' });
        if (resp.ok) {
            fetchMedicineEventsToday();
            fetchAlerts();
        }
    } catch (e) { console.error(e); }
};

// --- ACTIVE ALERTS LIFE CYCLE ---
async function fetchActiveAlerts() {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/alerts`);
        if (!resp.ok) return;
        const alerts = await resp.json();
        
        const activeAlerts = alerts.filter(a => ['OPEN', 'NOTIFYING', 'HELP_REQUESTED', 'ACCEPTED', 'IN_PROGRESS'].includes(a.status));
        renderActiveAlerts(activeAlerts);
    } catch (e) { console.error(e); }
}

function renderActiveAlerts(activeAlerts) {
    const countEl = document.getElementById('active-alerts-count');
    if (countEl) countEl.innerText = `${activeAlerts.length} active`;
    
    const list = document.getElementById('active-alerts-list');
    if (!list) return;
    
    if (activeAlerts.length === 0) {
        list.innerHTML = `<p class="placeholder-text"><i class="fa-solid fa-circle-check" style="color:var(--accent);"></i> All patients safe. No active caregiver alerts.</p>`;
        return;
    }
    
    list.innerHTML = activeAlerts.map(a => {
        const severityClass = a.severity;
        const statusBadgeClass = a.status === 'ACCEPTED' ? 'badge-green' : (a.status === 'IN_PROGRESS' ? 'badge-blue' : (a.status === 'HELP_REQUESTED' ? 'badge-red' : 'badge-orange'));
        
        return `
        <div class="active-alert-item ${severityClass}" id="active-alert-card-${a.id}">
            <div class="active-alert-header">
                <div class="active-alert-title">
                    <h4>${capitalizeFirst(a.alert_type.replace(/_/g, ' '))} [${a.severity.toUpperCase()}]</h4>
                    <span class="active-alert-time">${new Date(a.timestamp).toLocaleTimeString()} (${a.routing_mode} mode)</span>
                </div>
                <span class="badge ${statusBadgeClass}">${a.status}</span>
            </div>
            
            <p class="active-alert-msg">${a.message}</p>
            
            <div class="active-alert-assignments">
                <div>Primary Caregiver: <strong>${a.assigned_caregiver_name || 'Not assigned yet'}</strong></div>
                ${a.backup_caregiver_id ? `<div>Backup Caregiver: <strong>${a.backup_caregiver_name || 'Assigned'}</strong></div>` : ''}
            </div>
            
            <div class="active-alert-actions">
                ${['OPEN', 'NOTIFYING', 'HELP_REQUESTED'].includes(a.status) ? `
                <button class="btn btn-primary btn-small" style="background:#10b981; border-color:#059669;" onclick="acceptActiveAlert(${a.id})">
                    <i class="fa-solid fa-check"></i> Accept Alert
                </button>` : ''}
                
                ${a.status === 'ACCEPTED' ? `
                <button class="btn btn-secondary btn-small" onclick="startActiveAlertAssistance(${a.id})">
                    <i class="fa-solid fa-person-walking"></i> Start Assistance
                </button>` : ''}
                
                ${['ACCEPTED', 'IN_PROGRESS'].includes(a.status) ? `
                <button class="btn btn-secondary btn-small" style="border-color:#fbbf24; color:#fbbf24;" onclick="requestActiveAlertBackup(${a.id})">
                    <i class="fa-solid fa-handshake-angle"></i> Request Backup (HELP)
                </button>` : ''}
                
                ${['ACCEPTED', 'IN_PROGRESS', 'HELP_REQUESTED'].includes(a.status) ? `
                <button class="btn btn-secondary btn-small" style="background:#1e293b; border-color:var(--accent); color:var(--accent);" onclick="resolveActiveAlert(${a.id})">
                    <i class="fa-solid fa-circle-check"></i> Mark Resolved
                </button>` : ''}
            </div>
        </div>`;
    }).join('');
}

window.acceptActiveAlert = async function(id) {
    try {
        const respList = await fetch(`${BACKEND_URL}/api/caregivers`);
        const caregivers = await respList.json();
        if (caregivers.length === 0) {
            alert('Please register at least one caregiver first.');
            return;
        }
        
        const names = caregivers.map((c, idx) => `${idx + 1}. ${c.name}`).join('\n');
        const selection = prompt(`Which caregiver is accepting this request?\n\n${names}\n\nEnter number:`);
        if (!selection) return;
        
        const idx = parseInt(selection) - 1;
        if (isNaN(idx) || idx < 0 || idx >= caregivers.length) {
            alert('Invalid selection.');
            return;
        }
        
        const cg = caregivers[idx];
        const resp = await fetch(`${BACKEND_URL}/api/alerts/${id}/accept?caregiver_id=${cg.id}`, { method: 'POST' });
        
        if (resp.ok) {
            fetchActiveAlerts();
            fetchAlerts();
        } else {
            const err = await resp.json();
            alert(`Acceptance failed: ${err.detail}`);
        }
    } catch (e) { console.error(e); }
};

window.startActiveAlertAssistance = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/alerts/${id}/start`, { method: 'POST' });
        if (resp.ok) {
            fetchActiveAlerts();
        }
    } catch (e) { console.error(e); }
};

window.requestActiveAlertBackup = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/alerts/${id}/request-backup`, { method: 'POST' });
        if (resp.ok) {
            alert('Backup request dispatched to all other eligible caregivers.');
            fetchActiveAlerts();
        }
    } catch (e) { console.error(e); }
};

window.resolveActiveAlert = async function(id) {
    try {
        const resp = await fetch(`${BACKEND_URL}/api/alerts/${id}/resolve`, { method: 'POST' });
        if (resp.ok) {
            fetchActiveAlerts();
            fetchAlerts();
        }
    } catch (e) { console.error(e); }
};

