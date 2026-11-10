import { t, getLang, setLang, applyI18n, FOCUS_KEYS } from "./i18n.js";
import * as store from "./store.js";
import { pdfToSlides, imagesToSlides, loadImage, downscale } from "./deck.js";
import { health, analyzeDeck, rehearsalFeedback, chatReply } from "./api.js";
import { Tracker, loadVision, speechSupported } from "./tracker.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

let session = null;
let currentView = "home";
const videos = {}; // attemptId -> { url, blob, ext } (kept in memory only)

// ============ navigation ============
function show(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + view));
  const order = ["setup", "brief", "rehearse", "feedback"];
  const idx = order.indexOf(view === "processing" ? (session?.brief ? (session.attempts?.length ? "feedback" : "brief") : "setup") : view);
  document.querySelectorAll("#steps span").forEach((s, i) => {
    s.classList.toggle("on", i === idx);
    s.classList.toggle("done", idx > -1 && i < idx);
  });
  if (view !== "rehearse") stopStageLoop();
  // release the camera once we leave the rehearsal (it comes back on automatically next time)
  if (view !== "rehearse" && view !== "processing" && stream && !recording) {
    stream.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }
  window.scrollTo({ top: 0 });
}

function processing(title, sub = "") {
  $("procTitle").textContent = title;
  $("procSub").textContent = sub;
  show("processing");
}

async function save() {
  if (session) await store.saveSession(session);
}

// ============ HOME ============
async function renderHome() {
  show("home");
  const list = await store.listSessions();
  const box = $("sessionList");
  if (!list.length) {
    box.innerHTML = `<div class="empty">${t("no_sessions")}</div>`;
  } else {
    box.innerHTML = list
      .map((s) => {
        const n = (s.attempts || []).filter((a) => a.feedback).length;
        const last = (s.attempts || []).filter((a) => a.feedback).at(-1);
        return `<div class="session" data-id="${s.id}">
          ${s.slides?.[0] ? `<img src="${s.slides[0].image}" alt="">` : `<img alt="">`}
          <button class="del" data-del="${s.id}" title="${t("delete")}">✕</button>
          <div><b>${esc(s.title || s.brief?.title || t("untitled"))}</b><br>
          <small>${s.slides?.length || 0} ${t("slides")} · ${n} ${t("attempts")}${last ? ` · ${t("last_score")} ${last.feedback.overall_score}/10` : ""}</small></div>
        </div>`;
      })
      .join("");
  }
  const learned = store.getLearning();
  $("learningInfo").textContent = learned.length ? t("learning_count").replace("{n}", learned.length) : t("learning_empty");
}

$("sessionList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (confirm(t("confirm_delete"))) {
      await store.deleteSession(del.dataset.del);
      renderHome();
    }
    return;
  }
  const card = e.target.closest(".session");
  if (!card) return;
  session = await store.getSession(card.dataset.id);
  if (!session) return;
  const last = (session.attempts || []).filter((a) => a.feedback).at(-1);
  if (last) renderFeedback(last);
  else if (session.brief) renderBrief();
  else renderSetup();
});

$("resetLearning").onclick = () => {
  if (confirm(t("confirm_reset_learning"))) {
    store.clearLearning();
    renderHome();
  }
};

function newSession() {
  session = {
    id: uid(),
    createdAt: Date.now(),
    title: "",
    context: "",
    slides: [],
    focus: [],
    customFocus: "",
    timeLimitMin: null,
    speechLang: getLang() === "he" ? "he-IL" : "en-US",
    brief: null,
    attempts: [],
    chat: [],
  };
  renderSetup();
}
$("newSession").onclick = newSession;
$("newFromFb").onclick = newSession;
$("brand").onclick = () => {
  if (recording) return;
  renderHome();
};

// ============ SETUP ============
function renderSetup() {
  show("setup");
  $("sTitle").value = session.title || "";
  $("sContext").value = session.context || "";
  $("customFocus").value = session.customFocus || "";
  $("sTime").value = session.timeLimitMin ?? "";
  $("sSpeechLang").value = session.speechLang;
  $("uploadStatus").textContent = session.slides.length ? `${session.slides.length} ${t("slides")}` : "";
  renderSlidesGrid();
  renderFocusChips();
}

function renderSlidesGrid() {
  $("slidesGrid").innerHTML = session.slides
    .map(
      (s) => `<div class="slide-item">
      <img src="${s.image}" alt="">
      <div class="no">${t("slide")} ${s.index + 1}${s.text ? "" : ` · <span>${t("no_text")}</span>`}</div>
      <textarea data-note="${s.index}" placeholder="${esc(t("note_ph"))}">${esc(s.note || "")}</textarea>
    </div>`
    )
    .join("");
}

$("slidesGrid").addEventListener("input", (e) => {
  const i = e.target.dataset.note;
  if (i != null) session.slides[+i].note = e.target.value;
});

function renderFocusChips() {
  $("focusChips").innerHTML = FOCUS_KEYS.map(
    (k) => `<button type="button" class="chip ${session.focus.includes(k) ? "on" : ""}" data-focus="${k}">${t("focus_" + k)}</button>`
  ).join("");
}
$("focusChips").addEventListener("click", (e) => {
  const k = e.target.dataset.focus;
  if (!k) return;
  session.focus = session.focus.includes(k) ? session.focus.filter((x) => x !== k) : [...session.focus, k];
  e.target.classList.toggle("on");
});

async function handleFiles(files) {
  files = [...files];
  if (!files.length) return;
  const pdf = files.find((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  const notes = session.slides.map((s) => s.note);
  $("uploadStatus").textContent = t("reading_deck");
  try {
    const res = pdf
      ? await pdfToSlides(pdf, (i, n) => ($("uploadStatus").textContent = `${t("reading_deck")} ${i}/${n}`))
      : await imagesToSlides(imgs);
    if (!res.slides.length) throw new Error("empty");
    // keep notes if the same number of slides was re-uploaded
    if (notes.length === res.slides.length) res.slides.forEach((s, i) => (s.note = notes[i] || ""));
    session.slides = res.slides;
    session.brief = null;
    if (!session.title && pdf) session.title = pdf.name.replace(/\.pdf$/i, "");
    $("sTitle").value = session.title;
    $("uploadStatus").textContent = `${res.slides.length} ${t("slides")}` + (res.truncated ? ` — ${t("truncated").replace("{n}", res.total)}` : "");
    renderSlidesGrid();
  } catch (e) {
    console.error(e);
    $("uploadStatus").textContent = t("upload_error");
  }
}
$("fileInput").addEventListener("change", (e) => handleFiles(e.target.files));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles(e.dataTransfer.files);
});

function collectSetup() {
  session.title = $("sTitle").value.trim();
  session.context = $("sContext").value.trim();
  session.customFocus = $("customFocus").value.trim();
  const tm = parseFloat($("sTime").value);
  session.timeLimitMin = isNaN(tm) || tm <= 0 ? null : tm;
  session.speechLang = $("sSpeechLang").value;
}

$("analyzeBtn").onclick = async () => {
  collectSetup();
  if (!session.slides.length) {
    alert(t("need_slides"));
    return;
  }
  await save();
  processing(t("proc_deck"), t("proc_deck_sub"));
  try {
    session.brief = await analyzeDeck(session, getLang());
    await save();
    renderBrief();
  } catch (e) {
    console.error(e);
    renderSetup();
    if (confirm(t("analysis_failed") + "\n\n" + e.message + "\n\n" + t("continue_without"))) {
      enterRehearse({ mode: "full" });
    }
  }
};

// ============ BRIEF ============
function renderBrief() {
  show("brief");
  const b = session.brief;
  if (!b) return renderSetup();
  const st = { ok: t("st_ok"), weak: t("st_weak"), missing: t("st_missing") };
  $("briefBody").innerHTML = `
    <div class="brief-top">
      <div class="card">
        <h3>${esc(b.title || session.title)}</h3>
        <p class="story">${esc(b.one_line_story)}</p>
        <p><b>${t("takeaway")}:</b> ${esc(b.audience_takeaway)}</p>
        ${b.suggested_total_minutes ? `<p class="muted">${t("suggested_len")}: ${esc(b.suggested_total_minutes)} ${t("minutes")}</p>` : ""}
      </div>
      <div class="card">
        <h3>${t("structure")}</h3>
        ${(b.structure_check || [])
          .map((c) => `<div class="check"><span class="badge ${esc(c.status)}">${st[c.status] || esc(c.status)}</span><div><b>${esc(c.item)}</b><br><span class="muted">${esc(c.comment)}</span></div></div>`)
          .join("")}
      </div>
    </div>
    ${(b.slides || [])
      .map((s) => {
        const img = session.slides[s.slide - 1]?.image;
        return `<div class="card brief-slide">
          <div>${img ? `<img src="${img}" alt="">` : ""}<div class="muted small">${t("slide")} ${s.slide}${s.suggested_seconds ? ` · ~${s.suggested_seconds}s` : ""}</div></div>
          <div>
            <h3>${esc(s.title)}</h3>
            <p class="muted">${esc(s.purpose || "")}</p>
            ${s.must_say?.length ? `<div class="must"><b>${t("must_say")}:</b> ${s.must_say.map(esc).join(" · ")}</div>` : ""}
            <ul>${(s.key_points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
            ${s.tip ? `<p class="tip">💡 ${esc(s.tip)}</p>` : ""}
          </div>
        </div>`;
      })
      .join("")}
    ${b.questions_to_expect?.length ? `<div class="card"><h3>${t("questions")}</h3><ul>${b.questions_to_expect.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}
  `;
}
$("backToSetup").onclick = () => renderSetup();
$("toRehearse").onclick = () => enterRehearse({ mode: "full" });

// ============ REHEARSE ============
let stream = null;
let camGranted = false;
let tracker = null;
let recorder = null;
let chunks = [];
let recording = false;
let rh = { mode: "full", slideIndex: 0, current: 0, goals: [] };
let stageRaf = null;
let timerInt = null;
let snapInt = null;
let snapshots = [];
let overNotified = false;
let recStart = 0;
const slideImgs = {};

async function slideImg(i) {
  if (!slideImgs[session.id + i]) slideImgs[session.id + i] = await loadImage(session.slides[i].image);
  return slideImgs[session.id + i];
}

function enterRehearse({ mode = "full", slideIndex = 0, goals = [] } = {}) {
  if (!session.slides.length) return renderSetup();
  rh = { mode, slideIndex: Math.max(0, Math.min(slideIndex, session.slides.length - 1)), current: 0, goals };
  rh.current = mode === "slide" ? rh.slideIndex : 0;
  show("rehearse");

  renderRehearseLabels();
  setMode(mode);
  $("toast").classList.add("hidden");

  $("camMsg").classList.toggle("hidden", Boolean(stream));
  $("recBtn").disabled = !stream;
  $("timer").textContent = "00:00";
  $("timer").classList.remove("over");
  $("visionStatus").textContent = speechSupported() ? "" : t("no_speech");
  updateCues();
  startStageLoop();
  if (!stream && camGranted) startCamera();
}

function renderRehearseLabels() {
  $("slidePick").innerHTML = session.slides
    .map((s) => `<option value="${s.index}">${t("slide")} ${s.index + 1}${session.brief?.slides?.[s.index]?.title ? " — " + esc(session.brief.slides[s.index].title) : ""}</option>`)
    .join("");
  $("slidePick").value = rh.slideIndex;
  const goals = rh.goals || [];
  $("goalsBox").classList.toggle("hidden", !goals.length);
  $("goalsBox").innerHTML = goals.length ? `<b>${t("goals_this")}</b><ul>${goals.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : "";
}

function defaultLimitSec() {
  if (rh.mode === "slide") return session.brief?.slides?.[rh.slideIndex]?.suggested_seconds || 60;
  return session.timeLimitMin ? Math.round(session.timeLimitMin * 60) : 0;
}

function setMode(mode) {
  rh.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("slidePick").classList.toggle("hidden", mode !== "slide");
  rh.current = mode === "slide" ? rh.slideIndex : 0;
  const lim = defaultLimitSec();
  $("rMin").value = lim ? Math.floor(lim / 60) : "";
  $("rSec").value = lim ? lim % 60 : "";
  updateNav();
  updateCues();
}
$("modeSeg").addEventListener("click", (e) => {
  if (recording || !e.target.dataset.mode) return;
  setMode(e.target.dataset.mode);
});
$("slidePick").onchange = (e) => {
  rh.slideIndex = +e.target.value;
  setMode("slide");
};

function updateNav() {
  const single = rh.mode === "slide";
  $("prevSlide").disabled = single || rh.current <= 0;
  $("nextSlide").disabled = single || rh.current >= session.slides.length - 1;
}

function goSlide(d) {
  if (rh.mode === "slide") return;
  const n = Math.max(0, Math.min(session.slides.length - 1, rh.current + d));
  if (n === rh.current) return;
  rh.current = n;
  tracker?.setSlide(n);
  updateNav();
  updateCues();
}
$("prevSlide").onclick = () => goSlide(-1);
$("nextSlide").onclick = () => goSlide(1);

document.addEventListener("keydown", (e) => {
  if (currentView !== "rehearse" || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const rtl = document.documentElement.dir === "rtl";
  const next = ["PageDown", " ", rtl ? "ArrowLeft" : "ArrowRight", "ArrowDown"];
  const prev = ["PageUp", rtl ? "ArrowRight" : "ArrowLeft", "ArrowUp"];
  if (next.includes(e.key)) {
    e.preventDefault();
    goSlide(1);
  } else if (prev.includes(e.key)) {
    e.preventDefault();
    goSlide(-1);
  }
});

function updateCues() {
  const i = rh.current;
  $("cueSlideNo").textContent = `${i + 1}/${session.slides.length}`;
  const bs = session.brief?.slides?.find((s) => s.slide === i + 1);
  const showCues = $("showCues").checked;
  const items = [];
  if (showCues && bs) {
    (bs.must_say || []).forEach((m) => items.push(`<li class="must">${esc(m)}</li>`));
    (bs.key_points || []).forEach((m) => items.push(`<li>${esc(m)}</li>`));
  }
  if (showCues && !bs && session.slides[i].note) items.push(`<li>${esc(session.slides[i].note)}</li>`);
  $("cueList").innerHTML = items.join("") || `<li class="muted">${showCues ? t("no_cues") : t("cues_hidden")}</li>`;
}
$("showCues").onchange = updateCues;

// camera
$("camOn").onclick = startCamera;
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    camGranted = true;
    $("cam").srcObject = stream;
    await $("cam").play().catch(() => {});
    $("camMsg").classList.add("hidden");
    $("recBtn").disabled = false;
    $("visionStatus").textContent = t("vision_loading");
    loadVision()
      .then((lm) => {
        const missing = Object.entries(lm).filter(([, v]) => !v).map(([k]) => k);
        $("visionStatus").textContent = (missing.length ? t("vision_partial") + " " + missing.join(", ") : t("vision_ready")) + (speechSupported() ? "" : " · " + t("no_speech"));
      })
      .catch(() => ($("visionStatus").textContent = t("vision_failed")));
  } catch (e) {
    console.error(e);
    alert(t("cam_denied"));
  }
}

// stage = what is recorded: presenter on one side, current slide on the other
function startStageLoop() {
  stopStageLoop();
  const canvas = $("stage");
  const ctx = canvas.getContext("2d");
  const cam = $("cam");
  const W = canvas.width, H = canvas.height, half = W / 2;
  const draw = async () => {
    ctx.fillStyle = "#1d1b19";
    ctx.fillRect(0, 0, W, H);
    // presenter (mirrored, cover-cropped into the left half)
    if (stream && cam.videoWidth) {
      const vw = cam.videoWidth, vh = cam.videoHeight;
      const s = Math.max(half / vw, H / vh);
      const dw = vw * s, dh = vh * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, half, H);
      ctx.clip();
      ctx.translate(half, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(cam, (half - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }
    // slide (contain into the right half)
    const img = slideImgs[session.id + rh.current];
    if (img) {
      const pad = 28;
      const aw = half - pad * 2, ah = H - pad * 2;
      const s = Math.min(aw / img.width, ah / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.fillStyle = "#2a2724";
      ctx.fillRect(half, 0, half, H);
      ctx.drawImage(img, half + (half - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "500 18px Rubik, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${rh.current + 1} / ${session.slides.length}`, W - 20, H - 16);
    } else {
      slideImg(rh.current);
    }
    stageRaf = requestAnimationFrame(draw);
  };
  // preload slides
  session.slides.forEach((_, i) => slideImg(i));
  draw();
  // keep drawing while the tab is in the background during a recording
  timerBg = setInterval(() => {
    if (document.hidden && recording) {
      cancelAnimationFrame(stageRaf);
      draw();
    }
  }, 100);
}
let timerBg = null;
function stopStageLoop() {
  cancelAnimationFrame(stageRaf);
  clearInterval(timerBg);
}

// record
$("recBtn").onclick = () => (recording ? stopRecording() : startRecording());

function pickMime() {
  const opts = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a", "video/mp4"];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording() {
  if (!stream) return;
  const limit = (parseInt($("rMin").value) || 0) * 60 + (parseInt($("rSec").value) || 0);
  rh.limitSec = limit || null;
  rh.startSlide = rh.current;

  const canvasStream = $("stage").captureStream(30);
  stream.getAudioTracks().forEach((tr) => canvasStream.addTrack(tr));
  const mimeType = pickMime();
  try {
    recorder = new MediaRecorder(canvasStream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
  } catch {
    recorder = new MediaRecorder(canvasStream);
  }
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);

  tracker = new Tracker({ video: $("cam"), speechLang: session.speechLang, lang: getLang() });
  tracker.onLive = updateLive;
  tracker.start(stream, rh.current);

  recording = true;
  recStart = performance.now();
  overNotified = false;
  snapshots = [];
  $("recBtn").textContent = t("rec_stop");
  $("recBtn").classList.add("stop");
  $("recDot").classList.remove("hidden");
  document.querySelectorAll("#modeSeg button, #slidePick, #rMin, #rSec").forEach((el) => (el.disabled = true));

  timerInt = setInterval(() => {
    const el = (performance.now() - recStart) / 1000;
    $("timer").textContent = fmt(el) + (rh.limitSec ? " / " + fmt(rh.limitSec) : "");
    if (rh.limitSec && el >= rh.limitSec) {
      $("timer").classList.add("over");
      if (!overNotified) {
        overNotified = true;
        toast(t("time_over"));
      }
    }
  }, 250);

  const snap = () => {
    if (!$("cam").videoWidth) return;
    snapshots.push({ t: Math.round(tracker.now()), slide: rh.current + 1, image: downscale($("cam"), 384, 0.6) });
  };
  setTimeout(snap, 3000);
  snapInt = setInterval(snap, 8000);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 5000);
}

function updateLive(live) {
  $("lvEye").textContent = live.eye == null ? "–" : Math.round(live.eye * 100) + "%";
  $("lvGesture").textContent = live.gesture == null ? "–" : Math.round(live.gesture * 100) + "%";
  $("lvWpm").textContent = live.wpm ?? "–";
  $("lvVol").style.width = Math.round(live.volume * 100) + "%";
  $("faceTouch").classList.toggle("hidden", !live.faceTouch);
  $("caption").textContent = live.caption || "";
}

async function stopRecording() {
  recording = false;
  clearInterval(timerInt);
  clearInterval(snapInt);
  $("recBtn").textContent = t("rec_start");
  $("recBtn").classList.remove("stop");
  $("recDot").classList.add("hidden");
  document.querySelectorAll("#modeSeg button, #slidePick, #rMin, #rSec").forEach((el) => (el.disabled = false));

  const stopped = new Promise((res) => (recorder.onstop = res));
  recorder.stop();
  processing(t("proc_rec"), t("proc_rec_sub"));
  const [metrics] = await Promise.all([tracker.stop(), stopped]);

  const type = recorder.mimeType || "video/webm";
  const blob = new Blob(chunks, { type });
  const attempt = {
    id: uid(),
    at: Date.now(),
    mode: rh.mode,
    slideIndex: rh.mode === "slide" ? rh.slideIndex : null,
    timeLimitSec: rh.limitSec,
    goals: rh.goals || [],
    metrics: { ...metrics, time_limit_s: rh.limitSec, over_time_s: rh.limitSec ? Math.max(0, metrics.duration_s - rh.limitSec) : null },
    snapshots: pickEven(snapshots, 6),
    ratings: {},
  };
  videos[attempt.id] = { url: URL.createObjectURL(blob), blob, ext: type.includes("mp4") ? "mp4" : "webm" };
  session.attempts.push(attempt);
  await save();
  runFeedback(attempt);
}

function pickEven(arr, n) {
  if (arr.length <= n) return arr;
  return Array.from({ length: n }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
}

// ============ FEEDBACK ============
async function runFeedback(attempt) {
  processing(t("proc_fb"), t("proc_fb_sub"));
  try {
    attempt.feedback = await rehearsalFeedback(session, attempt, getLang());
    attempt.error = null;
    const fb = attempt.feedback;
    session.chat.push({
      role: "assistant",
      attemptId: attempt.id,
      content: `${t("chat_intro_a")} ${fb.overall_score}/10 — ${fb.headline}\n${t("chat_intro_b")}`,
    });
  } catch (e) {
    console.error(e);
    attempt.error = e.message;
  }
  await save();
  renderFeedback(attempt);
}

function renderFeedback(attempt) {
  attempt.ratings ||= {};
  show("feedback");
  const idx = session.attempts.indexOf(attempt) + 1;
  $("attemptLabel").textContent = `${t("attempt")} #${idx} · ${attempt.mode === "slide" ? `${t("slide")} ${attempt.slideIndex + 1}` : t("mode_full")}`;

  const v = videos[attempt.id];
  $("playback").classList.toggle("hidden", !v);
  $("downloadVideo").classList.toggle("hidden", !v);
  if (v) {
    $("playback").src = v.url;
    $("downloadVideo").href = v.url;
    $("downloadVideo").download = `kriti-${(session.title || "rehearsal").replace(/[^\w֐-׿-]+/g, "_")}-${idx}.${v.ext}`;
  }
  renderMetrics(attempt, !v);

  const fb = attempt.feedback;
  if (!fb) {
    $("feedbackBody").innerHTML = `<div class="card"><h3>${t("fb_failed")}</h3><p class="muted">${esc(attempt.error || "")}</p>
      <button class="btn primary" id="retryAnalysis">${t("retry_analysis")}</button></div>`;
    $("retryAnalysis").onclick = () => runFeedback(attempt);
  } else {
    $("feedbackBody").innerHTML = feedbackHtml(attempt);
  }
  renderChat();
  renderNextActions(attempt);
}

function renderMetrics(a, noVideo) {
  const m = a.metrics || {};
  const fillers = Object.entries(m.voice?.filler_words || {}).reduce((s, [, n]) => s + n, 0);
  const items = [
    [t("m_duration"), fmt(m.duration_s || 0) + (m.time_limit_s ? ` / ${fmt(m.time_limit_s)}` : "")],
    [t("m_eye"), pctTxt(m.face?.eye_contact_with_camera_pct)],
    [t("m_down"), pctTxt(m.face?.looking_down_pct)],
    [t("m_gesture"), pctTxt(m.hands?.active_gesturing_pct)],
    [t("m_smile"), pctTxt(m.face?.smiling_pct)],
    [t("m_wpm"), m.voice?.words_per_minute_overall ?? "–"],
    [t("m_pitch"), m.voice?.pitch_variation_semitones != null ? m.voice.pitch_variation_semitones + " st" : "–"],
    [t("m_pauses"), m.voice?.long_pauses_over_2s ?? "–"],
    [t("m_fillers"), m.voice?.speech_recognition_available === false ? "–" : fillers],
    [t("m_touch"), m.hands?.face_touch_count ?? "–"],
  ];
  $("metricsCard").innerHTML = `<h3>${t("measured")}</h3>
    ${noVideo ? `<p class="muted small">${t("video_not_kept")}</p>` : ""}
    <div class="metrics">${items.map(([k, v]) => `<div class="metric"><small>${k}</small><b dir="ltr">${v}</b></div>`).join("")}</div>`;
}
const pctTxt = (x) => (x == null ? "–" : x + "%");

function rateHtml(attempt, key, category, text) {
  const r = attempt.ratings?.[key];
  return `<div class="rate" data-key="${esc(key)}" data-cat="${esc(category)}" data-text="${esc(text)}">
    ${r?.rating < 0 ? `<input type="text" placeholder="${esc(t("why_not"))}" value="${esc(r.note || "")}">` : ""}
    <button data-r="1" class="${r?.rating > 0 ? "on-up" : ""}" title="${t("helpful")}">👍</button>
    <button data-r="-1" class="${r?.rating < 0 ? "on-down" : ""}" title="${t("not_helpful")}">👎</button>
  </div>`;
}

function feedbackHtml(a) {
  const fb = a.feedback;
  const focusSet = new Set(session.focus || []);
  const cats = [...(fb.categories || [])].sort((x, y) => focusSet.has(y.key) - focusSet.has(x.key));
  return `
  <div class="card">
    <div class="score"><div class="num">${esc(fb.overall_score)}</div>
      <div><h2>${esc(fb.headline)}</h2><p>${esc(fb.summary)}</p>
      ${fb.compared_to_previous ? `<p class="muted">↗ ${esc(fb.compared_to_previous)}</p>` : ""}</div></div>
  </div>

  ${fb.goals_check?.length ? `<div class="card"><h3>${t("goals_check")}</h3><ul class="list-clean">${fb.goals_check
    .map((g) => `<li>${g.improved ? "✅" : "⏳"} <b>${esc(g.goal)}</b> — ${esc(g.comment)}</li>`).join("")}</ul></div>` : ""}

  ${fb.strengths?.length ? `<div class="card"><h3>${t("strengths")}</h3><ul class="list-clean">${fb.strengths.map((s) => `<li>✓ ${esc(s)}</li>`).join("")}</ul></div>` : ""}

  ${fb.focus_feedback?.length ? `<div class="card"><h3>${t("your_focus")}</h3><div class="cats">${fb.focus_feedback
    .map((f, i) => `<div class="cat focus"><div class="cat-head"><b>${esc(f.focus)}</b></div>
      <p>${esc(f.observation)}</p><p class="do">→ ${esc(f.tip)}</p>${f.drill ? `<p class="tip">🏋 ${esc(f.drill)}</p>` : ""}
      ${rateHtml(a, "focus" + i, "focus:" + f.focus, f.observation + " / " + f.tip)}</div>`).join("")}</div></div>` : ""}

  <div class="card"><h3>${t("by_category")}</h3><div class="cats">${cats
    .map((c) => `<div class="cat ${focusSet.has(c.key) ? "focus" : ""}">
      <div class="cat-head"><b>${esc(c.label || c.key)}</b><span>${esc(c.score)}/10</span></div>
      <div class="bar"><span style="width:${(Number(c.score) || 0) * 10}%"></span></div>
      <p>${esc(c.observation)}</p><p class="do">→ ${esc(c.tip)}</p>
      ${rateHtml(a, "cat:" + c.key, c.key, c.observation + " / " + c.tip)}</div>`).join("")}</div></div>

  ${fb.slides?.length ? `<div class="card"><h3>${t("per_slide")}</h3><ul class="list-clean">${fb.slides
    .map((s) => `<li><b>${t("slide")} ${esc(s.slide)}</b> — ${esc(s.comment)}
      <div class="cover"><ul class="said">${(s.covered || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <ul class="missed">${(s.missed || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      ${rateHtml(a, "slide" + s.slide, "content_coverage", s.comment)}</li>`).join("")}</ul></div>` : ""}

  ${fb.timing?.comment ? `<div class="card"><h3>${t("timing")}</h3><p>${esc(fb.timing.comment)}</p></div>` : ""}

  ${fb.action_plan?.length ? `<div class="card"><h3>${t("action_plan")}</h3><ol class="list-clean">${fb.action_plan
    .map((s, i) => `<li><b>${i + 1}. ${esc(s.step)}</b><br><span class="muted">${esc(s.how)}</span>
      ${rateHtml(a, "plan" + i, "action_plan", s.step + " / " + s.how)}</li>`).join("")}</ol></div>` : ""}
  `;
}

$("feedbackBody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".rate button");
  if (!btn) return;
  const box = btn.closest(".rate");
  const attempt = currentAttempt();
  const key = box.dataset.key;
  const val = +btn.dataset.r;
  const prev = attempt.ratings[key];
  const rating = prev?.rating === val ? null : val; // click again to undo
  attempt.ratings[key] = rating == null ? undefined : { rating, note: prev?.note || "" };
  store.addLearning({ key: attempt.id + ":" + key, kind: "item", category: box.dataset.cat, text: box.dataset.text, rating, note: rating < 0 ? prev?.note : "" });
  await save();
  box.outerHTML = rateHtml(attempt, key, box.dataset.cat, box.dataset.text);
  if (rating < 0) $("feedbackBody").querySelector(`.rate[data-key="${CSS.escape(key)}"] input`)?.focus();
});
$("feedbackBody").addEventListener("change", async (e) => {
  if (!e.target.matches(".rate input")) return;
  const box = e.target.closest(".rate");
  const attempt = currentAttempt();
  const r = attempt.ratings[box.dataset.key];
  if (!r) return;
  r.note = e.target.value;
  store.addLearning({ key: attempt.id + ":" + box.dataset.key, kind: "item", category: box.dataset.cat, text: box.dataset.text, rating: r.rating, note: r.note });
  await save();
});

let shownAttemptId = null;
function currentAttempt() {
  return session.attempts.find((a) => a.id === shownAttemptId) || session.attempts.at(-1);
}

function renderNextActions(attempt) {
  shownAttemptId = attempt.id;
  const next = attempt.feedback?.next_attempt;
  $("retryBtn").textContent =
    next?.type === "slide" && next.slide ? `${t("retry_slide")} ${next.slide}` : t("retry");
  const weak = (attempt.feedback?.slides || []).filter((s) => s.missed?.length).map((s) => s.slide);
  $("slideRetryChips").innerHTML = weak
    .slice(0, 5)
    .map((n) => `<button class="chip" data-slide="${n}">${t("practice_slide")} ${n}</button>`)
    .join("");
}

function retryFromFeedback(attempt = currentAttempt()) {
  const next = attempt?.feedback?.next_attempt || {};
  const goals = next.goals || [];
  if (next.type === "slide" && next.slide) enterRehearse({ mode: "slide", slideIndex: next.slide - 1, goals });
  else enterRehearse({ mode: "full", goals });
}
$("retryBtn").onclick = () => retryFromFeedback();
$("slideRetryChips").addEventListener("click", (e) => {
  const n = e.target.dataset.slide;
  if (!n) return;
  const a = currentAttempt();
  const missed = a.feedback?.slides?.find((s) => String(s.slide) === n)?.missed || [];
  enterRehearse({ mode: "slide", slideIndex: +n - 1, goals: missed.map((m) => t("remember_to_say") + " " + m) });
});

// ============ CHAT ============
function renderChat() {
  $("chatLog").innerHTML = (session.chat || [])
    .map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`)
    .join("");
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

async function sendChat() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  session.chat.push({ role: "user", content: text });
  renderChat();
  $("chatLog").insertAdjacentHTML("beforeend", `<div class="msg assistant typing">${t("typing")}</div>`);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  $("sendBtn").disabled = true;
  try {
    const reply = await chatReply(session, getLang());
    session.chat.push({ role: "assistant", content: reply.trim() });
  } catch (e) {
    session.chat.push({ role: "assistant", content: t("chat_error") + " " + e.message });
  }
  $("sendBtn").disabled = false;
  await save();
  renderChat();
}
$("sendBtn").onclick = sendChat;
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// voice message → text
let dictation = null;
$("micBtn").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert(t("no_speech"));
  if (dictation) {
    dictation.stop();
    return;
  }
  dictation = new SR();
  dictation.lang = session.speechLang;
  dictation.interimResults = true;
  dictation.continuous = true;
  const base = $("chatInput").value ? $("chatInput").value + " " : "";
  dictation.onresult = (ev) => {
    let txt = "";
    for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
    $("chatInput").value = base + txt;
  };
  dictation.onend = () => {
    dictation = null;
    $("micBtn").classList.remove("listening");
  };
  $("micBtn").classList.add("listening");
  dictation.start();
};

// end of dialog → rate the coaching → offer next step
let stars = 0;
$("finishChat").onclick = () => {
  stars = 0;
  $("rateNote").value = "";
  $("stars").innerHTML = [1, 2, 3, 4, 5].map((n) => `<button data-s="${n}">★</button>`).join("");
  $("rateModal").classList.remove("hidden");
};
$("stars").addEventListener("click", (e) => {
  const n = +e.target.dataset.s;
  if (!n) return;
  stars = n;
  [...$("stars").children].forEach((b, i) => b.classList.toggle("on", i < n));
});
$("rateSkip").onclick = () => closeRating(false);
$("rateSave").onclick = () => closeRating(true);
async function closeRating(saveIt) {
  $("rateModal").classList.add("hidden");
  const a = currentAttempt();
  if (saveIt && (stars || $("rateNote").value.trim())) {
    store.addLearning({ key: a.id + ":overall", kind: "overall", rating: stars || null, note: $("rateNote").value.trim(), text: a.feedback?.headline });
  }
  const goals = a.feedback?.next_attempt?.goals || [];
  $("nextGoals").innerHTML = goals.length ? `<p class="muted">${t("next_goals")}</p><ul>${goals.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : "";
  const next = a.feedback?.next_attempt;
  $("nextRetry").textContent = next?.type === "slide" && next.slide ? `${t("retry_slide")} ${next.slide}` : t("retry");
  $("nextModal").classList.remove("hidden");
}
$("nextRetry").onclick = () => {
  $("nextModal").classList.add("hidden");
  retryFromFeedback();
};
$("nextNew").onclick = () => {
  $("nextModal").classList.add("hidden");
  newSession();
};
$("nextHome").onclick = () => {
  $("nextModal").classList.add("hidden");
  renderHome();
};

// ============ language ============
$("langToggle").onclick = () => {
  if (recording) return;
  setLang(getLang() === "he" ? "en" : "he");
  rerender();
};
function rerender() {
  applyI18n();
  if (recording) return;
  if (currentView === "home") renderHome();
  else if (currentView === "setup") {
    collectSetup();
    renderSetup();
  } else if (currentView === "brief") renderBrief();
  else if (currentView === "rehearse") {
    updateCues();
    $("recBtn").textContent = t("rec_start");
  } else if (currentView === "feedback") renderFeedback(currentAttempt());
}

window.addEventListener("beforeunload", (e) => {
  if (recording) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ============ boot ============
applyI18n();
renderHome();
health().then((h) => {
  if (!h.ok || !h.hasKey) $("keyBanner").classList.remove("hidden");
});
