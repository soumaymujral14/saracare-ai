// ============================================================
// VISION.JS — SaraCare Patient Safety Monitor
// Camera-based pose detection layer.
// Runs independently from TruGen session.
// Uses MediaPipe Pose Landmarker (Tasks-Vision WASM).
// ============================================================

// ---- Public API used by app.js ----
// window.VisionMonitor.start(videoEl)  — begin detection loop
// window.VisionMonitor.stop()          — stop detection, release resources
// window.VisionMonitor.isReady()       — returns bool
// window.VisionMonitor.setMuted(bool)  — mute/unmute safety voice
// window.VisionMonitor.onEvent(cb)     — register event callback

(function() {
    'use strict';

    // ---- Configuration ----
    const CFG = {
        ANALYSIS_INTERVAL_MS: 400,          // analyse one frame every N ms
        CANVAS_WIDTH: 320,                  // downscaled for performance
        CANVAS_HEIGHT: 240,

        // Frame-exit detection
        FRAME_EXIT_CONSECUTIVE: 6,          // # consecutive missing-person frames (~2.4 s)
        FRAME_EXIT_COOLDOWN_MS: 20000,      // 20 s between frame-exit alerts

        // Fall detection
        FALL_CONSECUTIVE: 4,                // # consecutive fall-condition frames
        FALL_COOLDOWN_MS: 30000,

        // Standing-attempt detection
        STAND_CONSECUTIVE: 5,               // # consecutive standing frames
        STAND_COOLDOWN_MS: 25000,

        // Prolonged no-person
        NO_PERSON_ALERT_MS: 10000,          // alert if absent > 10 s
        NO_PERSON_COOLDOWN_MS: 60000,

        // Fall heuristics
        FALL_HIP_DROP_THRESHOLD: 0.12,      // normalised Y drop between frames
        FALL_TORSO_ANGLE_MIN: 65,           // degrees from vertical = horizontal

        // Standing-attempt heuristics
        STAND_HIP_RISE_THRESHOLD: 0.10,     // normalised Y rise vs calibrated
    };

    // ---- State ----
    let poseLandmarker = null;
    let analysisTimer = null;
    let videoEl = null;
    let offCanvas = null;
    let offCtx = null;
    let isMuted = false;
    let eventCallback = null;
    let modelReady = false;
    let modelLoadFailed = false;

    // Detection counters
    let noPersonConsecutive = 0;
    let fallConsecutive = 0;
    let standConsecutive = 0;

    // Cooldown timestamps
    let lastFrameExitAlert = 0;
    let lastFallAlert = 0;
    let lastStandAlert = 0;
    let lastNoPersonAlert = 0;

    // History
    let prevHipY = null;
    let calibratedHipY = null;          // hip Y at frame-confirm time
    let personWasPresent = false;
    let personAbsentSince = null;
    let lastSpeechText = '';

    // Speech queue
    let speechQueue = [];
    let isSpeaking = false;

    // ---- Status element ----
    function setVisionStatus(statusKey, text) {
        const el = document.getElementById('vision-status-text');
        const dot = document.getElementById('vision-status-dot');
        if (el) el.innerText = text;
        if (dot) {
            dot.className = 'status-indicator-dot';
            if (statusKey === 'active') dot.classList.add('active');
            else if (statusKey === 'alert') dot.classList.add('alert');
            else dot.classList.add('inactive');
        }
    }

    // ---- Speech Synthesis ----
    function speakSafetyMessage(text) {
        if (isMuted) return;
        if (!window.speechSynthesis) return;

        // Don't repeat same message within 15 s
        if (text === lastSpeechText && Date.now() - (window._lastSpeechTime || 0) < 15000) return;
        lastSpeechText = text;
        window._lastSpeechTime = Date.now();

        // Cancel any currently playing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'hi-IN';
        utterance.volume = 0.9;
        utterance.rate = 0.92;

        // Try to find a Hindi-compatible voice
        const voices = window.speechSynthesis.getVoices();
        const hindiVoice = voices.find(v => v.lang.startsWith('hi'));
        if (hindiVoice) utterance.voice = hindiVoice;

        window.speechSynthesis.speak(utterance);
        console.log('[Vision] Speaking:', text);
    }

    // Expose globally for app.js
    window.speakSafetyMessage = speakSafetyMessage;

    // ---- Event dispatch ----
    function emitEvent(alertType, severity, message, confidence) {
        console.log(`[Vision] Event: ${alertType} | ${severity} | conf=${confidence}`);
        if (typeof eventCallback === 'function') {
            eventCallback({ alertType, severity, message, confidence, source: 'camera_vision', timestamp: new Date().toISOString() });
        }
    }

    // ---- MediaPipe model loader ----
    async function loadModel() {
        setVisionStatus('inactive', 'Loading pose model…');
        try {
            // MediaPipe Tasks-Vision — use CDN bundle
            const { PoseLandmarker, FilesetResolver } = await import(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
            );

            const vision = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
            );

            poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
                    delegate: 'GPU'
                },
                runningMode: 'VIDEO',
                numPoses: 1,
                minPoseDetectionConfidence: 0.45,
                minPosePresenceConfidence: 0.45,
                minTrackingConfidence: 0.45
            });

            modelReady = true;
            console.log('[Vision] MediaPipe Pose Landmarker ready.');
            setVisionStatus('active', 'Pose Detection Active');
            return true;
        } catch (err) {
            modelLoadFailed = true;
            console.error('[Vision] Pose model load failed:', err);
            setVisionStatus('inactive', 'Automatic vision detection unavailable');
            return false;
        }
    }

    // ---- Off-screen canvas for frame extraction ----
    function ensureCanvas() {
        if (!offCanvas) {
            offCanvas = document.createElement('canvas');
            offCanvas.width = CFG.CANVAS_WIDTH;
            offCanvas.height = CFG.CANVAS_HEIGHT;
            offCtx = offCanvas.getContext('2d');
        }
    }

    // ---- Single frame analysis ----
    function analyseFrame() {
        if (!poseLandmarker || !videoEl || videoEl.readyState < 2 || !modelReady) return;

        ensureCanvas();
        offCtx.drawImage(videoEl, 0, 0, CFG.CANVAS_WIDTH, CFG.CANVAS_HEIGHT);

        let results;
        try {
            results = poseLandmarker.detectForVideo(offCanvas, performance.now());
        } catch (e) {
            console.warn('[Vision] detectForVideo error:', e);
            return;
        }

        const landmarks = results && results.landmarks && results.landmarks[0];
        const personDetected = !!(landmarks && landmarks.length > 0);

        processDetection(personDetected, landmarks);
    }

    // ---- Core detection logic ----
    function processDetection(personDetected, landmarks) {
        const now = Date.now();

        // ── FRAME EXIT / NO PERSON ──
        if (!personDetected) {
            noPersonConsecutive++;
            fallConsecutive = 0;
            standConsecutive = 0;
            prevHipY = null;

            if (personWasPresent) {
                if (!personAbsentSince) personAbsentSince = now;
            }

            // Consecutive-frame frame-exit alert
            if (noPersonConsecutive >= CFG.FRAME_EXIT_CONSECUTIVE && personWasPresent) {
                if (now - lastFrameExitAlert > CFG.FRAME_EXIT_COOLDOWN_MS) {
                    lastFrameExitAlert = now;
                    const patientName = getPatientName();
                    const msg = `Frame exit warning: ${patientName} is no longer visible in the safety monitoring zone.`;
                    speakSafetyMessage('Please monitored area mein wapas aaiye aur caregiver ka wait kijiye.');
                    emitEvent('frame_exit', 'urgent', msg, 0.75);
                    setVisionStatus('alert', 'Patient Left Frame!');
                }
            }

            // Prolonged no-person alert
            if (personAbsentSince && (now - personAbsentSince) > CFG.NO_PERSON_ALERT_MS) {
                if (now - lastNoPersonAlert > CFG.NO_PERSON_COOLDOWN_MS) {
                    lastNoPersonAlert = now;
                    const patientName = getPatientName();
                    const msg = `${patientName} has not been visible in the monitoring frame for over ${Math.round(CFG.NO_PERSON_ALERT_MS / 1000)} seconds.`;
                    emitEvent('no_person_detected', 'urgent', msg, 0.80);
                }
            }

            personWasPresent = false;
            return;
        }

        // Person is present
        noPersonConsecutive = 0;
        personAbsentSince = null;
        personWasPresent = true;
        setVisionStatus('active', 'Pose Detection Active — Person Visible');

        // Extract key landmarks (indices per MediaPipe Pose)
        // 11 = left shoulder, 12 = right shoulder
        // 23 = left hip, 24 = right hip
        // 27 = left ankle, 28 = right ankle
        // 0 = nose
        const lShoulder = landmarks[11];
        const rShoulder = landmarks[12];
        const lHip = landmarks[23];
        const rHip = landmarks[24];
        const nose = landmarks[0];
        const lAnkle = landmarks[27];
        const rAnkle = landmarks[28];

        if (!lShoulder || !rShoulder || !lHip || !rHip) return;

        const hipY = (lHip.y + rHip.y) / 2;
        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const hipX = (lHip.x + rHip.x) / 2;
        const shoulderX = (lShoulder.x + rShoulder.x) / 2;

        // Torso angle from vertical (0 = upright, 90 = horizontal/lying)
        const dx = Math.abs(hipX - shoulderX);
        const dy = Math.abs(hipY - shoulderY);
        const torsoAngleFromVertical = (Math.atan2(dx, dy) * 180) / Math.PI;

        // ── FALL DETECTION ──
        // Heuristics:
        // 1. Rapid downward drop of hip between consecutive frames
        // 2. Torso angle mostly horizontal (> threshold)
        // 3. Multiple conditions met for FALL_CONSECUTIVE frames

        let fallCondition = false;

        if (prevHipY !== null) {
            const hipDropRate = hipY - prevHipY; // positive = moving down in normalised coords
            const rapidDrop = hipDropRate > CFG.FALL_HIP_DROP_THRESHOLD;
            const mostlyHorizontal = torsoAngleFromVertical > CFG.FALL_TORSO_ANGLE_MIN;
            const bodyLow = hipY > 0.65; // hip in lower 35% of frame

            if ((rapidDrop || mostlyHorizontal) && bodyLow) {
                fallConsecutive++;
            } else {
                fallConsecutive = Math.max(0, fallConsecutive - 1);
            }

            if (fallConsecutive >= CFG.FALL_CONSECUTIVE) {
                if (now - lastFallAlert > CFG.FALL_COOLDOWN_MS) {
                    lastFallAlert = now;
                    fallConsecutive = 0;
                    const patientName = getPatientName();
                    const msg = `Possible fall detected for ${patientName}. Rapid downward movement and horizontal body posture detected by camera vision. Caregiver response needed.`;
                    speakSafetyMessage('Please uthne ki koshish mat kijiye. Wahi rukiye; caregiver ko alert kiya ja raha hai.');
                    emitEvent('fall', 'critical', msg, 0.68);
                    setVisionStatus('alert', 'POSSIBLE FALL DETECTED');
                }
            }
        }

        prevHipY = hipY;

        // ── STANDING ATTEMPT DETECTION ──
        // Detect when patient goes from lying/sitting to more vertical posture
        // vs calibrated lying hip Y position

        if (calibratedHipY !== null) {
            // Rising hip = standing (lower Y value in normalised coords = higher on screen)
            const hipRiseFromCalibrated = calibratedHipY - hipY; // positive = rising
            const moreUpright = torsoAngleFromVertical < 30; // fairly vertical

            if (hipRiseFromCalibrated > CFG.STAND_HIP_RISE_THRESHOLD && moreUpright) {
                standConsecutive++;
            } else {
                standConsecutive = Math.max(0, standConsecutive - 1);
            }

            if (standConsecutive >= CFG.STAND_CONSECUTIVE) {
                if (now - lastStandAlert > CFG.STAND_COOLDOWN_MS) {
                    lastStandAlert = now;
                    standConsecutive = 0;
                    const patientName = getPatientName();
                    const msg = `Standing attempt detected for ${patientName}. Patient appears to be rising from lying position without assistance.`;
                    speakSafetyMessage('Please akela ya akeli khade mat hoiye. Caregiver ka wait kijiye.');
                    emitEvent('standing_attempt', 'urgent', msg, 0.65);
                    setVisionStatus('alert', 'STANDING ATTEMPT DETECTED');
                }
            }
        } else {
            // Calibrate on first valid detection after frame confirmation
            calibratedHipY = hipY;
            console.log('[Vision] Calibrated hip Y (lying reference):', calibratedHipY);
        }
    }

    function getPatientName() {
        const el = document.getElementById('patient-name');
        return el ? (el.value || 'Patient') : 'Patient';
    }

    // ---- Public API ----
    window.VisionMonitor = {
        async start(videoElement) {
            videoEl = videoElement;
            modelReady = false;
            modelLoadFailed = false;
            noPersonConsecutive = 0;
            fallConsecutive = 0;
            standConsecutive = 0;
            prevHipY = null;
            calibratedHipY = null;
            personWasPresent = false;
            personAbsentSince = null;
            lastFrameExitAlert = 0;
            lastFallAlert = 0;
            lastStandAlert = 0;
            lastNoPersonAlert = 0;
            lastSpeechText = '';

            const ok = await loadModel();

            if (!ok) {
                setVisionStatus('inactive', 'Automatic vision detection unavailable');
                return;
            }

            // Start analysis loop
            if (analysisTimer) clearInterval(analysisTimer);
            analysisTimer = setInterval(analyseFrame, CFG.ANALYSIS_INTERVAL_MS);
            console.log('[Vision] Analysis loop started at', CFG.ANALYSIS_INTERVAL_MS, 'ms interval.');
        },

        stop() {
            if (analysisTimer) {
                clearInterval(analysisTimer);
                analysisTimer = null;
            }
            if (poseLandmarker) {
                try { poseLandmarker.close(); } catch(e) {}
                poseLandmarker = null;
            }
            modelReady = false;
            videoEl = null;
            offCanvas = null;
            offCtx = null;
            calibratedHipY = null;
            if (window.speechSynthesis) window.speechSynthesis.cancel();
            setVisionStatus('inactive', 'Vision Detection Stopped');
            console.log('[Vision] Stopped.');
        },

        isReady() {
            return modelReady && !modelLoadFailed;
        },

        setMuted(muted) {
            isMuted = muted;
            if (muted && window.speechSynthesis) window.speechSynthesis.cancel();
        },

        onEvent(cb) {
            eventCallback = cb;
        },

        // Reset calibration baseline (call again after reconfigure frame)
        resetCalibration() {
            calibratedHipY = null;
            noPersonConsecutive = 0;
            fallConsecutive = 0;
            standConsecutive = 0;
            personWasPresent = false;
            personAbsentSince = null;
            lastSpeechText = '';
            console.log('[Vision] Calibration reset.');
        }
    };

})();
