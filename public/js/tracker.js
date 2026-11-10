// Live body-language + voice analysis during a rehearsal.
// Face (expressions, gaze, head pose), hands (gestures, face-touching), body pose (posture, sway,
// crossed arms) via MediaPipe; volume, pitch, pauses via Web Audio; transcript via the
// browser's speech recognition. Everything runs on the user's device; only the summary
// numbers + transcript (+ a few snapshots) are sent for feedback.

const MP_VERSION = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODELS = {
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};

const FILLERS = {
  he: ["אמ", "אממ", "אה", "אהה", "אהמ", "כאילו", "בעצם", "יעני", "כזה", "כזאת", "נגיד", "בקיצור", "סתם"],
  en: ["um", "umm", "uh", "uhh", "er", "like", "you know", "basically", "actually", "literally", "sort of", "kind of", "i mean"],
};

let vision = null; // shared, loaded once
let landmarkers = null;

export async function loadVision(onStatus = () => {}) {
  if (landmarkers) return landmarkers;
  onStatus("loading");
  const mod = await import(MP_URL);
  vision = await mod.FilesetResolver.forVisionTasks(MP_WASM);
  const make = async (Cls, url, extra) => {
    const base = { runningMode: "VIDEO", ...extra };
    try {
      return await Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: url, delegate: "GPU" }, ...base });
    } catch {
      return await Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: url, delegate: "CPU" }, ...base });
    }
  };
  const [face, hand, pose] = await Promise.all([
    make(mod.FaceLandmarker, MODELS.face, { numFaces: 1, outputFaceBlendshapes: true }).catch(() => null),
    make(mod.HandLandmarker, MODELS.hand, { numHands: 2 }).catch(() => null),
    make(mod.PoseLandmarker, MODELS.pose, { numPoses: 1 }).catch(() => null),
  ]);
  landmarkers = { face, hand, pose };
  onStatus("ready");
  return landmarkers;
}

export function speechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// ---------- small stats helpers ----------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const r1 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 100) / 100);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class Tracker {
  constructor({ video, speechLang = "he-IL", lang = "he" }) {
    this.video = video;
    this.speechLang = speechLang;
    this.lang = lang;
    this.running = false;
    this.live = { eye: null, gesture: null, volume: 0, wpm: null, caption: "", faceTouch: false, speaking: false };
    this.onLive = () => {};
  }

  start(stream, slideIndex = 0) {
    this.running = true;
    this.t0 = performance.now();
    this.tick = 0;
    this.lastVideoTime = -1;

    // frame samples
    this.face = []; // {t, ok, eye, down, smile, brow, frown, blink, cx, w}
    this.hands = []; // {t, n, motion, touch}
    this.pose = []; // {t, ok, cx, sw, tilt, crossed}
    this.audio = []; // {t, db, voiced, pitch}
    this.blinks = 0;
    this._blinkOpen = true;
    this.faceTouches = 0;
    this._touching = false;
    this._prevWrists = {};
    this.speech = []; // {t, slide, text}
    this.slideEvents = [{ slide: slideIndex, t: 0 }];
    this.currentSlide = slideIndex;
    this._lastFace = null;

    this._startAudio(stream);
    this._startSpeech();
    this._loop();
  }

  now() {
    return (performance.now() - this.t0) / 1000;
  }

  setSlide(i) {
    if (!this.running || i === this.currentSlide) return;
    this.currentSlide = i;
    this.slideEvents.push({ slide: i, t: this.now() });
  }

  // ---------------- vision loop ----------------
  _loop() {
    if (!this.running) return;
    const v = this.video;
    const step = () => {
      if (!this.running) return;
      const lm = landmarkers;
      if (lm && v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        const ts = performance.now();
        const t = this.now();
        this.tick++;
        try {
          if (lm.face) this._face(lm.face.detectForVideo(v, ts), t);
          if (lm.hand && this.tick % 2 === 0) this._hands(lm.hand.detectForVideo(v, ts), t);
          if (lm.pose && this.tick % 3 === 0) this._pose(lm.pose.detectForVideo(v, ts), t);
        } catch (e) {
          // a dropped frame is fine
        }
        this._updateLive();
      }
      this._timer = setTimeout(() => requestAnimationFrame(step), 66); // ~12-15 fps analysis
    };
    requestAnimationFrame(step);
  }

  _face(res, t) {
    const lm = res?.faceLandmarks?.[0];
    if (!lm) {
      this.face.push({ t, ok: false });
      this._lastFace = null;
      return;
    }
    const bs = {};
    (res.faceBlendshapes?.[0]?.categories || []).forEach((c) => (bs[c.categoryName] = c.score));
    const nose = lm[1], L = lm[234], R = lm[454], top = lm[10], chin = lm[152];
    const yaw = ((nose.x - L.x) / (R.x - L.x || 1e-6) - 0.5) * 2; // -1..1
    const pitch = (nose.y - top.y) / (chin.y - top.y || 1e-6) - 0.58;
    const gazeOff = Math.max(
      bs.eyeLookOutLeft || 0, bs.eyeLookOutRight || 0, bs.eyeLookInLeft || 0, bs.eyeLookInRight || 0,
      bs.eyeLookUpLeft || 0, bs.eyeLookUpRight || 0
    );
    const gazeDown = Math.max(bs.eyeLookDownLeft || 0, bs.eyeLookDownRight || 0);
    const eye = Math.abs(yaw) < 0.35 && Math.abs(pitch) < 0.12 && gazeOff < 0.55 && gazeDown < 0.55;
    const down = pitch > 0.12 || gazeDown > 0.55;
    const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
    const brow = bs.browInnerUp || 0;
    const frown = ((bs.browDownLeft || 0) + (bs.browDownRight || 0)) / 2;
    const blinkScore = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
    if (blinkScore > 0.55 && this._blinkOpen) {
      this.blinks++;
      this._blinkOpen = false;
    } else if (blinkScore < 0.35) this._blinkOpen = true;

    const xs = lm.map((p) => p.x), ys = lm.map((p) => p.y);
    this._lastFace = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    this.face.push({ t, ok: true, eye, down, smile, brow, frown, yaw, pitch, cx: (L.x + R.x) / 2, w: R.x - L.x });
  }

  _hands(res, t) {
    const list = res?.landmarks || [];
    let motion = 0;
    let touch = false;
    const seen = {};
    list.forEach((hand, i) => {
      const key = res.handednesses?.[i]?.[0]?.categoryName || "h" + i;
      seen[key] = true;
      const w = hand[0];
      const prev = this._prevWrists[key];
      if (prev && t > prev.t) motion = Math.max(motion, dist(w, prev) / (t - prev.t));
      this._prevWrists[key] = { x: w.x, y: w.y, t };
      const f = this._lastFace;
      if (f) {
        const padX = (f.maxX - f.minX) * 0.1, padY = (f.maxY - f.minY) * 0.1;
        touch = touch || hand.some((p) => p.x > f.minX - padX && p.x < f.maxX + padX && p.y > f.minY - padY && p.y < f.maxY + padY);
      }
    });
    Object.keys(this._prevWrists).forEach((k) => !seen[k] && delete this._prevWrists[k]);
    if (touch && !this._touching) this.faceTouches++;
    this._touching = touch;
    this.hands.push({ t, n: list.length, motion, touch });
  }

  _pose(res, t) {
    const p = res?.landmarks?.[0];
    if (!p) {
      this.pose.push({ t, ok: false });
      return;
    }
    const ls = p[11], rs = p[12], lw = p[15], rw = p[16];
    const sw = Math.abs(ls.x - rs.x) || 1e-6;
    const tilt = (Math.atan2(ls.y - rs.y, ls.x - rs.x) * 180) / Math.PI;
    const tiltNorm = Math.abs(Math.abs(tilt) > 90 ? 180 - Math.abs(tilt) : tilt);
    const midX = (ls.x + rs.x) / 2, midY = (ls.y + rs.y) / 2;
    // crossed arms: both wrists in front of the torso, each on the opposite side of the body centre
    const crossed =
      (lw.visibility ?? 1) > 0.5 && (rw.visibility ?? 1) > 0.5 &&
      lw.y > midY && rw.y > midY &&
      Math.sign(lw.x - midX) !== Math.sign(ls.x - midX) &&
      Math.sign(rw.x - midX) !== Math.sign(rs.x - midX) &&
      Math.abs(lw.x - midX) < sw && Math.abs(rw.x - midX) < sw;
    this.pose.push({ t, ok: true, cx: midX, sw, tilt: tiltNorm, crossed });
  }

  // ---------------- audio ----------------
  _startAudio(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(stream);
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 2048;
      src.connect(this.analyser);
      const buf = new Float32Array(this.analyser.fftSize);
      this._noise = [];
      this._audioTimer = setInterval(() => {
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms + 1e-8);
        const t = this.now();
        if (t < 1.5) this._noise.push(db);
        const floor = this._noise.length ? Math.min(...this._noise) : -60;
        const thr = Math.max(floor + 12, -52);
        const voiced = db > thr;
        const pitch = voiced ? autoCorrelate(buf, this.ac.sampleRate) : null;
        this.audio.push({ t, db, voiced, pitch });
        this.live.volume = Math.max(0, Math.min(1, (db + 60) / 50));
        this.live.speaking = voiced;
      }, 100);
    } catch (e) {
      this.ac = null;
    }
  }

  // ---------------- speech recognition ----------------
  _startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.speechAvailable = Boolean(SR);
    if (!SR) return;
    const rec = new SR();
    rec.lang = this.speechLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) this.speech.push({ t: this.now(), slide: this.currentSlide, text });
        } else interim += r[0].transcript;
      }
      this.live.caption = interim || (this.speech.at(-1)?.text ?? "");
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.speechAvailable = false;
    };
    rec.onend = () => {
      if (this.running && this.speechAvailable) {
        try { rec.start(); } catch {}
      }
    };
    try { rec.start(); } catch {}
    this.rec = rec;
  }

  // ---------------- live indicators ----------------
  _updateLive() {
    const t = this.now();
    const recentFace = this.face.filter((f) => f.t > t - 5);
    const okFace = recentFace.filter((f) => f.ok);
    this.live.eye = okFace.length ? okFace.filter((f) => f.eye).length / okFace.length : null;
    const recentHands = this.hands.filter((h) => h.t > t - 5);
    this.live.gesture = recentHands.length ? recentHands.filter((h) => h.n > 0 && h.motion > 0.15).length / recentHands.length : null;
    this.live.faceTouch = this._touching;
    const words = this.speech.filter((s) => s.t > t - 30).reduce((n, s) => n + countWords(s.text), 0);
    this.live.wpm = t > 10 ? Math.round(words * (60 / Math.min(30, t))) : null;
    this.onLive(this.live);
  }

  // ---------------- stop + summarise ----------------
  async stop() {
    this.running = false;
    clearTimeout(this._timer);
    clearInterval(this._audioTimer);
    try { this.rec && this.rec.stop(); } catch {}
    // let the last speech result arrive
    await new Promise((r) => setTimeout(r, 900));
    try { this.ac && this.ac.close(); } catch {}
    return this.summary();
  }

  summary() {
    const duration = this.now();
    const fillerList = FILLERS[this.speechLang.startsWith("he") ? "he" : "en"];

    // --- per-slide time + transcript ---
    const slideTime = {};
    this.slideEvents.forEach((e, i) => {
      const end = this.slideEvents[i + 1]?.t ?? duration;
      slideTime[e.slide] = (slideTime[e.slide] || 0) + (end - e.t);
    });
    const order = [...new Set(this.slideEvents.map((e) => e.slide))];
    const slides = order.map((s) => {
      const text = this.speech.filter((x) => x.slide === s).map((x) => x.text).join(" ");
      const secs = slideTime[s] || 0;
      const words = countWords(text);
      return { slide: s + 1, seconds: Math.round(secs), words, wpm: secs > 5 ? Math.round((words * 60) / secs) : null, transcript: text };
    });

    // --- face ---
    const f = this.face, fOk = f.filter((x) => x.ok);
    const faceSummary = {
      face_visible_pct: pct(fOk.length, f.length),
      eye_contact_with_camera_pct: pct(fOk.filter((x) => x.eye).length, fOk.length),
      looking_down_pct: pct(fOk.filter((x) => x.down).length, fOk.length),
      smile_avg_0_1: r2(mean(fOk.map((x) => x.smile))),
      smiling_pct: pct(fOk.filter((x) => x.smile > 0.4).length, fOk.length),
      frowning_pct: pct(fOk.filter((x) => x.frown > 0.45).length, fOk.length),
      expressiveness_0_1: r2(std(fOk.map((x) => x.smile)) + std(fOk.map((x) => x.brow))),
      blinks_per_min: duration > 10 ? Math.round((this.blinks * 60) / duration) : null,
      head_turn_variability: r2(std(fOk.map((x) => x.yaw))),
    };

    // --- hands ---
    const h = this.hands;
    const handsSummary = {
      hands_visible_pct: pct(h.filter((x) => x.n > 0).length, h.length),
      both_hands_visible_pct: pct(h.filter((x) => x.n > 1).length, h.length),
      active_gesturing_pct: pct(h.filter((x) => x.n > 0 && x.motion > 0.15).length, h.length),
      hands_visible_but_still_pct: pct(h.filter((x) => x.n > 0 && x.motion <= 0.05).length, h.length),
      fast_or_fidgety_motion_pct: pct(h.filter((x) => x.motion > 1.2).length, h.length),
      face_touch_count: this.faceTouches,
    };

    // --- body ---
    const p = this.pose.filter((x) => x.ok);
    const sw = mean(p.map((x) => x.sw)) || 1;
    const cxs = p.map((x) => x.cx);
    const bodySummary = {
      body_visible_pct: pct(p.length, this.pose.length),
      sway_relative_to_shoulder_width: r2(std(cxs) / sw),
      horizontal_travel_relative_to_shoulder_width: cxs.length ? r2((Math.max(...cxs) - Math.min(...cxs)) / sw) : null,
      shoulder_tilt_avg_deg: r1(mean(p.map((x) => x.tilt))),
      crossed_arms_pct: pct(p.filter((x) => x.crossed).length, p.length),
      distance_from_camera_hint: fOk.length ? (mean(fOk.map((x) => x.w)) > 0.33 ? "very close" : mean(fOk.map((x) => x.w)) < 0.12 ? "far" : "ok") : null,
    };

    // --- voice ---
    const a = this.audio, voiced = a.filter((x) => x.voiced);
    const pitches = voiced.map((x) => x.pitch).filter((x) => x && x > 70 && x < 450);
    const med = median(pitches);
    const semis = pitches.map((x) => 12 * Math.log2(x / (med || 1)));
    let pauses = [], cur = 0;
    a.forEach((x) => {
      if (!x.voiced) cur += 0.1;
      else {
        if (cur >= 0.6) pauses.push(cur);
        cur = 0;
      }
    });
    const totalWords = this.speech.reduce((n, s) => n + countWords(s.text), 0);
    const speakingSecs = voiced.length * 0.1;
    const allText = " " + this.speech.map((s) => s.text.toLowerCase()).join(" ") + " ";
    const fillers = {};
    fillerList.forEach((w) => {
      const re = new RegExp(`(^|[\\s,.!?])${escapeRe(w)}(?=[\\s,.!?]|$)`, "g");
      const n = (allText.match(re) || []).length;
      if (n) fillers[w] = n;
    });
    const voiceSummary = {
      speaking_time_pct: pct(voiced.length, a.length),
      avg_loudness_db: r1(mean(voiced.map((x) => x.db))),
      loudness_variation_db: r1(std(voiced.map((x) => x.db))),
      median_pitch_hz: med ? Math.round(med) : null,
      pitch_variation_semitones: r1(std(semis)),
      pauses_over_0_6s: pauses.length,
      long_pauses_over_2s: pauses.filter((x) => x >= 2).length,
      longest_pause_s: r1(Math.max(0, ...pauses)),
      words_recognised: totalWords,
      words_per_minute_overall: duration > 10 ? Math.round((totalWords * 60) / duration) : null,
      words_per_minute_while_speaking: speakingSecs > 10 ? Math.round((totalWords * 60) / speakingSecs) : null,
      filler_words: fillers,
      speech_recognition_available: this.speechAvailable,
    };

    // --- timeline (for "where did energy drop") ---
    const bucket = Math.max(5, Math.ceil(duration / 30));
    const timeline = [];
    for (let s = 0; s < duration; s += bucket) {
      const inB = (x) => x.t >= s && x.t < s + bucket;
      const fb = fOk.filter(inB), hb = h.filter(inB), ab = a.filter(inB);
      const slideAt = [...this.slideEvents].reverse().find((e) => e.t <= s + 0.01)?.slide ?? 0;
      timeline.push({
        from_s: Math.round(s),
        slide: slideAt + 1,
        eye_contact_pct: pct(fb.filter((x) => x.eye).length, fb.length),
        gesturing_pct: pct(hb.filter((x) => x.n > 0 && x.motion > 0.15).length, hb.length),
        speaking_pct: pct(ab.filter((x) => x.voiced).length, ab.length),
        smile_avg: r2(mean(fb.map((x) => x.smile))),
      });
    }

    return {
      duration_s: Math.round(duration),
      slides,
      face: faceSummary,
      hands: handsSummary,
      body: bodySummary,
      voice: voiceSummary,
      timeline,
      vision_models: { face: Boolean(landmarkers?.face), hands: Boolean(landmarkers?.hand), pose: Boolean(landmarkers?.pose) },
    };
  }
}

function countWords(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Classic autocorrelation pitch estimate (good enough for intonation range, not for tuning)
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / SIZE) < 0.01) return null;
  const minLag = Math.floor(sampleRate / 450), maxLag = Math.floor(sampleRate / 70);
  let best = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < SIZE - lag; i += 2) {
      c += buf[i] * buf[i + lag];
      n1 += buf[i] * buf[i];
      n2 += buf[i + lag] * buf[i + lag];
    }
    const corr = c / Math.sqrt(n1 * n2 + 1e-12);
    if (corr > bestCorr) {
      bestCorr = corr;
      best = lag;
    }
  }
  return bestCorr > 0.6 && best > 0 ? sampleRate / best : null;
}
