// Determine backend URL based on current host
const BACKEND_URL = window.location.port === '8080' ? 'http://localhost:8000' : '';

let isMonitoring = false;
let webcamStream = null;
let lastSeenTimestamp = null;
let audioCtx = null;
let alarmInterval = null;
let lastMedTriggerMinute = "";
let pollingInterval = null;

// Initialize Profile Info and Event Listeners on Load
window.addEventListener('DOMContentLoaded', () => {
    loadProfile();
    
    // Save profile handler
    document.getElementById('profile-form').addEventListener('submit', saveProfile);
    
    // Trigger medicine now handler
    document.getElementById('trigger-med-now-btn').addEventListener('click', () => {
        triggerMedicineAlert();
    });
    
    // Dismiss alarm handlers
    document.getElementById('global-mute-btn').addEventListener('click', dismissAlarm);
    document.getElementById('close-modal-btn').addEventListener('click', dismissAlarm);
    
    // Double-bind the start monitoring button click handler for robustness
    const startBtn = document.getElementById('startMonitoringBtn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            if (window.startMonitoring) window.startMonitoring();
        });
    }

    // Bind medicine reminder time changes
    const timeInput = document.getElementById('reminder-time');
    if (timeInput) {
        timeInput.addEventListener('input', updateReminderTimeDisplay);
        timeInput.addEventListener('change', updateReminderTimeDisplay);
    }
});

// Helper to convert 24h format to 12h AM/PM format
function convertTo12HourFormat(time24) {
    if (!time24) return "";
    const parts = time24.split(":");
    if (parts.length < 2) return time24;
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    return `${hours}:${minutes} ${ampm}`;
}

// Helper to update the UI 12-hour display next to 24-hour time input
function updateReminderTimeDisplay() {
    const timeInput = document.getElementById('reminder-time').value;
    const display = document.getElementById('reminder-time-display');
    if (display) {
        display.innerText = timeInput ? `(${convertTo12HourFormat(timeInput)})` : "";
    }
}

// LOAD & SAVE PATIENT PROFILE FROM LOCAL STORAGE
function loadProfile() {
    const profile = JSON.parse(localStorage.getItem('saracare_profile'));
    if (profile) {
        document.getElementById('patient-name').value = profile.patientName || 'Eleanor Vance';
        document.getElementById('patient-age').value = profile.patientAge || '82';
        document.getElementById('patient-condition').value = profile.patientCondition || 'Recovering from hip surgery, high fall risk';
        document.getElementById('caregiver-name').value = profile.caregiverName || 'David Vance';
        document.getElementById('caregiver-phone').value = profile.caregiverPhone || '+1 (555) 019-2834';
        document.getElementById('reminder-time').value = profile.reminderTime || '08:00';
    }
    updateReminderTimeDisplay();
}

function saveProfile(e) {
    if (e) e.preventDefault();
    const profile = {
        patientName: document.getElementById('patient-name').value,
        patientAge: document.getElementById('patient-age').value,
        patientCondition: document.getElementById('patient-condition').value,
        caregiverName: document.getElementById('caregiver-name').value,
        caregiverPhone: document.getElementById('caregiver-phone').value,
        reminderTime: document.getElementById('reminder-time').value
    };
    localStorage.setItem('saracare_profile', JSON.stringify(profile));
    
    // Show saved visual indicator
    const btn = document.querySelector('#profile-form button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Profile Saved!`;
    setTimeout(() => { btn.innerHTML = originalText; }, 1500);
}

// WEB AUDIO ALARM ENGINE (UNLOCK & PLAY)
function unlockAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Play an immediate tiny silence to satisfy Chrome/Safari audio requirements
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(0);
    osc.stop(0.1);
}

function playAlarmSound() {
    if (!audioCtx) return;
    if (alarmInterval) return; // Prevent duplicate alarms
    
    alarmInterval = setInterval(() => {
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        // Alternating siren pitch
        const freq = (Math.floor(Date.now() / 600) % 2 === 0) ? 880 : 660;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    }, 600);
}

function stopAlarmSound() {
    if (alarmInterval) {
        clearInterval(alarmInterval);
        alarmInterval = null;
    }
}

// WEBCAM STREAM & DEMO MODE CONTROLLER
let webcamTimeout = null;
let cameraInitCompleted = false;

window.startMonitoring = async function startMonitoring() {
    if (isMonitoring) return; // Prevent double execution
    
    const startBtn = document.getElementById('startMonitoringBtn');
    const statusDot = document.getElementById('status-dot');
    const statusLabel = document.getElementById('status-label');
    const safetyBadge = document.getElementById('safety-badge');
    const placeholder = document.getElementById('video-placeholder');
    const video = document.getElementById('webcam');
    
    // 1. Create or reference diagnostic debugger overlay panel inside video card
    let debugConsole = document.getElementById('camera-debug-log');
    if (!debugConsole) {
        debugConsole = document.createElement('div');
        debugConsole.id = 'camera-debug-log';
        debugConsole.setAttribute('style', 'position: absolute; top: 3.5rem; left: 1rem; font-family: monospace; font-size: 0.75rem; background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(255,255,255,0.15); padding: 0.5rem; border-radius: 6px; z-index: 15; color: var(--accent); text-align: left; display: flex; flex-direction: column; gap: 0.25rem; pointer-events: none;');
        const videoContainer = document.querySelector('.video-container');
        if (videoContainer) videoContainer.appendChild(debugConsole);
    }
    
    debugConsole.innerHTML = '<div style="font-weight:700;margin-bottom:0.125rem;">Diagnostics log:</div>';
    
    function logDebug(msg) {
        console.log("[Camera Debug]", msg);
        const logItem = document.createElement('div');
        logItem.innerText = `> ${msg}`;
        debugConsole.appendChild(logItem);
    }

    // 2. Immediately show text on UI: "Starting camera..."
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Starting camera...`;
    }
    
    logDebug("Camera request started");
    unlockAudio();
    
    cameraInitCompleted = false;
    
    // 3. Set a 3-second timeout to fall back to Demo Mode if permission isn't granted quickly
    webcamTimeout = setTimeout(() => {
        if (!cameraInitCompleted) {
            logDebug("Camera failed: Permission request timed out after 3s");
            activateDemoMode("Camera permission request timed out after 3 seconds.");
        }
    }, 3000);

    // 4. Try starting webcam
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("navigator.mediaDevices.getUserMedia is undefined");
        }
        
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        
        // If timeout triggered before we resolved, discard the stream and exit
        if (cameraInitCompleted) {
            if (webcamStream) {
                webcamStream.getTracks().forEach(track => track.stop());
            }
            return;
        }
        
        // Success
        cameraInitCompleted = true;
        clearTimeout(webcamTimeout);
        
        video.srcObject = webcamStream;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.autoplay = true;
        video.classList.remove('hidden');
        placeholder.classList.add('hidden');
        
        await video.play();
        
        logDebug("Camera stream received");
        
        isMonitoring = true;
        
        // Update UI states
        statusDot.className = 'status-indicator-dot active';
        statusLabel.innerText = 'Monitoring Active';
        safetyBadge.className = 'safety-badge safe';
        safetyBadge.innerText = 'STATUS: SAFE';
        
        if (startBtn) {
            startBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Monitoring Active`;
            startBtn.classList.remove('btn-glow');
        }
        
        // Reveal Request Stop Monitoring button
        const requestStopBtn = document.getElementById('requestStopMonitoringBtn');
        if (requestStopBtn) {
            requestStopBtn.classList.remove('hidden');
            requestStopBtn.disabled = false;
            requestStopBtn.innerHTML = `<i class="fa-solid fa-hand"></i> Request Stop Monitoring`;
        }
        
        startPolling();
        setInterval(checkMedicineReminder, 5000);
        
    } catch (err) {
        if (cameraInitCompleted) return; // Already handled by timeout
        
        cameraInitCompleted = true;
        clearTimeout(webcamTimeout);
        
        let errorMsg = "Unknown webcam error";
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            errorMsg = "Permission denied.";
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            errorMsg = "Camera not found.";
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            errorMsg = "Camera already in use.";
        } else {
            errorMsg = err.message || err;
        }
        
        logDebug(`Camera failed: ${errorMsg}`);
        activateDemoMode(errorMsg);
    }
    
    function activateDemoMode(errorDetails) {
        cameraInitCompleted = true;
        isMonitoring = true;
        
        logDebug("Demo mode active");
        
        // Show fallback demo scanner placeholder
        placeholder.classList.remove('hidden');
        video.classList.add('hidden');
        
        placeholder.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; padding: 1.5rem;">
                <div class="demo-scanner-ring" style="width: 70px; height: 70px; border-radius: 50%; border: 3px dashed var(--accent); display: flex; align-items: center; justify-content: center; animation: rotateRing 4s linear infinite; margin-bottom: 0.5rem;">
                    <i class="fa-solid fa-expand text-accent" style="font-size: 1.5rem; animation: pulse 1.5s infinite;"></i>
                </div>
                <p style="font-size: 1.125rem; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">Demo Monitoring Mode Active</p>
                <p class="sub-placeholder-text" style="color: var(--text-secondary); max-width: 380px; margin-bottom: 0.75rem; font-size: 0.825rem; line-height: 1.4;">
                    Webcam fallback activated due to:<br>
                    <strong style="color: var(--severity-urgent);">${errorDetails}</strong>
                </p>
                <p class="sub-placeholder-text" style="font-size: 0.725rem; color: var(--text-muted); line-height: 1.3;">
                    Interactive triggers, local alarm sound synthesizer, profile configs, and remote webhook listeners remain fully functional.
                </p>
            </div>
        `;
        
        // Set pill state to Demo Monitoring Active
        statusDot.className = 'status-indicator-dot active';
        statusLabel.innerText = 'Demo Monitoring Active';
        safetyBadge.className = 'safety-badge safe';
        safetyBadge.innerText = 'STATUS: SAFE';
        
        if (startBtn) {
            startBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Monitoring Active (Demo)`;
            startBtn.classList.remove('btn-glow');
        }
        
        // Reveal Request Stop Monitoring button
        const requestStopBtn = document.getElementById('requestStopMonitoringBtn');
        if (requestStopBtn) {
            requestStopBtn.classList.remove('hidden');
            requestStopBtn.disabled = false;
            requestStopBtn.innerHTML = `<i class="fa-solid fa-hand"></i> Request Stop Monitoring`;
        }
        
        startPolling();
        setInterval(checkMedicineReminder, 5000);
    }
};

// DISMISS / MUTE ALARM ACTIONS
function dismissAlarm() {
    stopAlarmSound();
    
    // Hide modal
    document.getElementById('call-modal').classList.add('hidden');
    
    // Hide warning overlay
    document.getElementById('live-alert-banner').classList.add('hidden');
    
    // Hide mute button
    document.getElementById('global-mute-btn').classList.add('hidden');
    
    // Reset UI Status
    if (isMonitoring) {
        const isDemo = document.getElementById('webcam').classList.contains('hidden');
        document.getElementById('status-dot').className = 'status-indicator-dot active';
        document.getElementById('status-label').innerText = isDemo ? 'Demo Monitoring Active' : 'Monitoring Active';
        document.getElementById('safety-badge').className = 'safety-badge safe';
        document.getElementById('safety-badge').innerText = 'STATUS: SAFE';
    }
}

// LOCAL INCIDENT ALERT ENGINE SIDE-EFFECTS
function triggerLocalAlarm(payload, whatsappStatus) {
    if (!isMonitoring) return; // Only alarm if monitoring has started
    
    // A. Visual Alerts
    const statusDot = document.getElementById('status-dot');
    const statusLabel = document.getElementById('status-label');
    const safetyBadge = document.getElementById('safety-badge');
    const liveAlertBanner = document.getElementById('live-alert-banner');
    const liveAlertText = document.getElementById('live-alert-text');
    const globalMuteBtn = document.getElementById('global-mute-btn');
    
    // Diagnostics log helper
    let debugConsole = document.getElementById('camera-debug-log');
    function logDebug(msg) {
        console.log("[Camera Debug]", msg);
        if (debugConsole) {
            const logItem = document.createElement('div');
            logItem.innerText = `> ${msg}`;
            debugConsole.appendChild(logItem);
        }
    }
    
    if (payload.severity === 'critical') {
        statusDot.className = 'status-indicator-dot alert';
        statusLabel.innerText = 'CRITICAL DANGER';
        safetyBadge.className = 'safety-badge emergency';
        safetyBadge.innerText = 'STATUS: EMERGENCY';
        liveAlertBanner.className = 'live-alert-banner';
        liveAlertText.innerText = payload.message.toUpperCase();
        
        // Audio alarm
        playAlarmSound();
    } else if (payload.severity === 'urgent') {
        statusDot.className = 'status-indicator-dot alert';
        statusLabel.innerText = 'ATTENTION REQUIRED';
        safetyBadge.className = 'safety-badge attention';
        safetyBadge.innerText = 'STATUS: ATTENTION';
        liveAlertBanner.className = 'live-alert-banner';
        liveAlertText.innerText = payload.message.toUpperCase();
        
        // Audio alarm
        playAlarmSound();
    }
    
    // Update UI status text with WhatsApp delivery details
    const statusVal = whatsappStatus || payload.whatsapp_status;
    if (statusVal) {
        const textMsg = statusVal === 'real_whatsapp_sent' ? 'Real WhatsApp alert sent' : 'Mock WhatsApp alert sent';
        statusLabel.innerText += ` (${textMsg})`;
        logDebug(textMsg);
    }
    
    // Unhide manual dismiss button
    globalMuteBtn.classList.remove('hidden');
    
    // B. Trigger Mock Call (urgent/critical only)
    if (payload.severity === 'critical' || payload.severity === 'urgent') {
        const caregiverName = document.getElementById('caregiver-name').value;
        const caregiverPhone = document.getElementById('caregiver-phone').value;
        
        // Fill and show modal
        document.getElementById('modal-caregiver-name').innerText = caregiverName;
        document.getElementById('modal-caregiver-phone').innerText = caregiverPhone;
        document.getElementById('modal-alert-msg').innerText = `"${payload.message}"`;
        document.getElementById('call-modal').classList.remove('hidden');
        
        // Trigger mock-call endpoint
        sendMockCall(caregiverName, caregiverPhone, payload.message);
    }
}

// POST REQUESTS TO BACKEND
async function sendAlert(payload) {
    try {
        const response = await fetch(`${BACKEND_URL}/alert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error("Backend response error");
        const result = await response.json();
        
        // Synchronize seen alert timestamp to block double alarms
        if (result.alert && result.alert.timestamp) {
            lastSeenTimestamp = new Date(result.alert.timestamp).getTime();
        }
        
        // Initiate alarms/modals directly if critical or urgent
        if (payload.severity === 'urgent' || payload.severity === 'critical') {
            triggerLocalAlarm(payload, result.whatsapp_status);
        }
        
        // Instantly sync timeline without waiting for poll
        fetchAlerts();
    } catch (err) {
        console.error("Failed to post alert to backend:", err);
    }
}

async function sendMockCall(name, phone, message) {
    try {
        await fetch(`${BACKEND_URL}/mock-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                caregiver_name: name,
                caregiver_phone: phone,
                message: message
            })
        });
    } catch (err) {
        console.error("Mock call API execution failure:", err);
    }
}

// DEMO TRIGGERS (WEB PANEL BUTTONS)
window.triggerAlert = function(type) {
    const patientName = document.getElementById('patient-name').value;
    let severity = "routine";
    let message = "";
    
    switch(type) {
        case 'fall':
            severity = 'critical';
            message = `Possible fall detected for ${patientName}. Device detected sharp acceleration and impact.`;
            break;
        case 'risky_movement':
            severity = 'urgent';
            message = `Risky movement alert: ${patientName} is attempting bed exit without support.`;
            break;
        case 'frame_exit':
            severity = 'urgent';
            message = `Frame exit warning: ${patientName} is no longer visible in safety monitoring zone.`;
            break;
        case 'medicine':
            severity = 'routine';
            const reminderTimeVal = document.getElementById('reminder-time').value;
            const time12Val = convertTo12HourFormat(reminderTimeVal);
            message = `Medicine reminder: It is time for ${patientName}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${time12Val})`;
            break;
        case 'voice_help':
            severity = 'urgent';
            message = `Acoustic voice safety alert: ${patientName} called out for help.`;
            break;
        case 'emergency':
            severity = 'critical';
            message = `CRITICAL WARNING: Manual emergency button activated by patient ${patientName}.`;
            break;
    }
    
    sendAlert({
        patient_name: patientName,
        alert_type: type,
        severity: severity,
        message: message
    });
};

// SCHEDULER MEDICINE TIMER (FRONTEND ONLY)
// SCHEDULER MEDICINE TIMER (FRONTEND ONLY)
let lastTriggeredMedTimeStr = ""; // tracks "YYYY-MM-DD HH:MM" to avoid repeats

function triggerMedicineAlert(customMsg) {
    const patientName = document.getElementById('patient-name').value;
    const reminderTime = document.getElementById('reminder-time').value;
    const time12 = convertTo12HourFormat(reminderTime);
    
    const msg = customMsg || `Medicine reminder: It is time for ${patientName}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${time12})`;
    sendAlert({
        patient_name: patientName,
        alert_type: "medicine",
        severity: "routine",
        message: msg
    });
}

function checkMedicineReminder() {
    const reminderTime = document.getElementById('reminder-time').value;
    if (!reminderTime) return;
    
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // e.g. "2026-06-05"
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${hrs}:${mins}`;
    
    const currentTriggerId = `${dateStr} ${reminderTime}`; // e.g. "2026-06-05 08:00"
    
    if (currentTimeStr === reminderTime && lastTriggeredMedTimeStr !== currentTriggerId) {
        lastTriggeredMedTimeStr = currentTriggerId;
        const patientName = document.getElementById('patient-name').value;
        const time12 = convertTo12HourFormat(reminderTime);
        const alertMsg = `Medicine reminder: It is time for ${patientName}'s scheduled medicine. Caregiver should assist. (Scheduled time: ${time12})`;
        triggerMedicineAlert(alertMsg);
    }
}

// POLLING & TIMELINE SYNC
function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    fetchAlerts();
    pollingInterval = setInterval(fetchAlerts, 2000);
}

async function fetchAlerts() {
    try {
        const response = await fetch(`${BACKEND_URL}/alerts`);
        if (!response.ok) throw new Error("Failed fetching alert data");
        const alerts = await response.json();
        
        updateTimelineUI(alerts);
        
        // Handle webhook/external alerts from backend (e.g. TruGen alerts)
        if (alerts.length > 0) {
            const latest = alerts[0];
            const latestTime = new Date(latest.timestamp).getTime();
            
            if (!lastSeenTimestamp) {
                lastSeenTimestamp = latestTime;
            } else if (latestTime > lastSeenTimestamp) {
                // External trigger caught via polling (e.g. TruGen POST endpoint)
                lastSeenTimestamp = latestTime;
                
                // If it is a stop approval, run the stop sequence!
                if (latest.alert_type === 'stop_monitoring_approved') {
                    executeStopMonitoringSequence();
                } else {
                    triggerLocalAlarm(latest, latest.whatsapp_status);
                }
            }
        }
    } catch (err) {
        console.error("Alert logs synchronization error:", err);
    }
}

// REQUEST STOP MONITORING FLOW
window.requestStopMonitoring = async function requestStopMonitoring() {
    const patientName = document.getElementById('patient-name').value;
    const caregiverName = document.getElementById('caregiver-name').value;
    const caregiverPhone = document.getElementById('caregiver-phone').value;
    const requestStopBtn = document.getElementById('requestStopMonitoringBtn');
    const simulateApprovalBtn = document.getElementById('simulateApprovalBtn');
    const statusLabel = document.getElementById('status-label');
    
    // Reference diagnostics logger console if exists
    let debugConsole = document.getElementById('camera-debug-log');
    function logDebug(msg) {
        console.log("[Camera Debug]", msg);
        if (debugConsole) {
            const logItem = document.createElement('div');
            logItem.innerText = `> ${msg}`;
            debugConsole.appendChild(logItem);
        }
    }
    
    if (requestStopBtn) {
        requestStopBtn.disabled = true;
        requestStopBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Requesting...`;
    }
    
    try {
        const response = await fetch(`${BACKEND_URL}/request-stop-monitoring`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                patient_name: patientName,
                caregiver_name: caregiverName,
                caregiver_whatsapp: caregiverPhone
            })
        });
        
        if (!response.ok) throw new Error("Backend response error");
        const result = await response.json();
        
        // Show simulation approval button
        if (simulateApprovalBtn) {
            simulateApprovalBtn.classList.remove('hidden');
        }
        
        // Update UI status pill message
        const statusMsg = result.whatsapp_status === 'real_whatsapp_sent' ? 'Real WhatsApp alert sent' : 'Mock WhatsApp alert sent';
        statusLabel.innerText = `WhatsApp approval pending (${statusMsg})`;
        logDebug(`Stop request sent (${statusMsg})`);
        
        if (requestStopBtn) {
            requestStopBtn.innerHTML = `<i class="fa-solid fa-clock"></i> Approval Pending`;
        }
        
        // Sync timeline logs immediately
        fetchAlerts();
    } catch (err) {
        console.error("Stop monitoring request failed:", err);
        statusLabel.innerText = "Mock WhatsApp approval request sent.";
        logDebug("Mock WhatsApp request sent (fallback)");
        if (simulateApprovalBtn) {
            simulateApprovalBtn.classList.remove('hidden');
        }
        if (requestStopBtn) {
            requestStopBtn.innerHTML = `<i class="fa-solid fa-clock"></i> Approval Pending`;
        }
    }
};

window.simulateApproval = async function simulateApproval() {
    const patientName = document.getElementById('patient-name').value;
    const simulateApprovalBtn = document.getElementById('simulateApprovalBtn');
    
    if (simulateApprovalBtn) {
        simulateApprovalBtn.disabled = true;
        simulateApprovalBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Approving...`;
    }
    
    try {
        const response = await fetch(`${BACKEND_URL}/approve-stop-monitoring`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                patient_name: patientName,
                approved_by: "caregiver"
            })
        });
        
        if (!response.ok) throw new Error("Approval response error");
        
        // Success: Trigger the stop sequence!
        executeStopMonitoringSequence();
    } catch (err) {
        console.error("Simulation approval endpoint failed, triggering fallback stop sequence:", err);
        executeStopMonitoringSequence();
    }
};

function executeStopMonitoringSequence() {
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
    }
    const video = document.getElementById('webcam');
    if (video) {
        video.srcObject = null;
        video.classList.add('hidden');
    }
    
    const placeholder = document.getElementById('video-placeholder');
    if (placeholder) {
        placeholder.classList.remove('hidden');
        placeholder.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; color: var(--text-secondary); text-align: center; padding: 2rem;">
                <i class="fa-solid fa-circle-pause text-accent" style="font-size: 3rem; animation: pulse 2s infinite;"></i>
                <p style="font-size: 1.125rem; font-weight: 700; color: var(--text-primary);">Monitoring Paused</p>
                <p class="sub-placeholder-text">Caregiver has approved the request to stop monitoring. The patient stream is currently offline.</p>
            </div>
        `;
    }
    
    const statusDot = document.getElementById('status-dot');
    const statusLabel = document.getElementById('status-label');
    const safetyBadge = document.getElementById('safety-badge');
    
    if (statusDot) statusDot.className = 'status-indicator-dot inactive';
    if (statusLabel) statusLabel.innerText = 'Monitoring Paused by caregiver approval';
    if (safetyBadge) {
        safetyBadge.className = 'safety-badge safe';
        safetyBadge.innerText = 'STATUS: PAUSED';
    }
    
    isMonitoring = false;
    cameraInitCompleted = false; // Reset camera active flag
    
    // Stop alarm and alert polling
    stopAlarmSound();
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    
    // Remove diagnostic overlay console if any
    const debugConsole = document.getElementById('camera-debug-log');
    if (debugConsole) {
        debugConsole.remove();
    }
    
    // Hide stop controls
    const requestStopBtn = document.getElementById('requestStopMonitoringBtn');
    if (requestStopBtn) requestStopBtn.classList.add('hidden');
    
    const simulateApprovalBtn = document.getElementById('simulateApprovalBtn');
    if (simulateApprovalBtn) {
        simulateApprovalBtn.classList.add('hidden');
        simulateApprovalBtn.disabled = false;
        simulateApprovalBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Simulate Caregiver Approval`;
    }
    
    // Reset start button
    const startBtn = document.getElementById('startMonitoringBtn');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = `<i class="fa-solid fa-play"></i> Start Monitoring`;
        startBtn.classList.add('btn-glow');
    }
}

function updateTimelineUI(alerts) {
    const timeline = document.getElementById('timeline');
    const placeholder = document.getElementById('timeline-placeholder');
    const countBadge = document.getElementById('timeline-count');
    
    countBadge.innerText = `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`;
    
    if (alerts.length === 0) {
        timeline.innerHTML = '';
        placeholder.classList.remove('hidden');
        return;
    }
    
    placeholder.classList.add('hidden');
    
    let html = '';
    alerts.forEach(alert => {
        const time = new Date(alert.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        let iconClass = 'fa-bell';
        if (alert.alert_type === 'fall') iconClass = 'fa-user-ninja';
        else if (alert.alert_type === 'risky_movement') iconClass = 'fa-person-walking-arrow-loop-left';
        else if (alert.alert_type === 'frame_exit') iconClass = 'fa-door-open';
        else if (alert.alert_type === 'medicine') iconClass = 'fa-pills';
        else if (alert.alert_type === 'voice_help') iconClass = 'fa-microphone-lines';
        else if (alert.alert_type === 'emergency') iconClass = 'fa-circle-exclamation';
        
        html += `
            <div class="timeline-item ${alert.severity}">
                <div class="timeline-marker"></div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <span class="timeline-title">
                            <i class="fa-solid ${iconClass}"></i> ${capitalizeFirst(alert.alert_type.replace('_', ' '))}
                        </span>
                        <span class="timeline-time">${timeStr}</span>
                    </div>
                    <div class="timeline-body">
                        ${alert.message}
                    </div>
                    <div style="margin-top: 5px;">
                        <span class="severity-pill">${alert.severity}</span>
                    </div>
                </div>
            </div>
        `;
    });
    
    timeline.innerHTML = html;
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
