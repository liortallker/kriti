// Talking to Claude (through our server) + the prompts the coach uses.
import { learningSummary } from "./store.js";
import { slideForModel } from "./deck.js";

export async function health() {
  try {
    const r = await fetch("/api/health");
    return await r.json();
  } catch {
    return { ok: false };
  }
}

export async function callClaude({ system, messages, max_tokens = 4000 }) {
  const r = await fetch("/api/claude", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system, messages, max_tokens }),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
  return data.text || "";
}

export function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

const imageBlock = (dataUrl) => {
  const [meta, data] = dataUrl.split(",");
  const media_type = meta.match(/data:(.*?);/)?.[1] || "image/jpeg";
  return { type: "image", source: { type: "base64", media_type, data } };
};

const langName = (lang) => (lang === "he" ? "Hebrew" : "English");

const COACH_PERSONA = `You are Kriti, an experienced presentation coach for industrial, product and UX/UI design students and designers.
You know design critiques ("crits"), juries and client pitches: the story arc (context → problem/need → research & insights → concept → process & iterations → final design → validation/next steps), why every design decision must be justified, and how a jury listens.
You are warm but direct and specific. You never invent things you did not observe; when evidence is weak you say so.`;

// ---------- 1. Deck review: learn the presentation, write key points ----------
export async function analyzeDeck(session, lang) {
  const n = session.slides.length;
  const side = n > 30 ? 640 : n > 15 ? 800 : 1024;
  const content = [];
  content.push({
    type: "text",
    text: `Here is a design presentation with ${n} slides. Each slide image is followed by its extractable text and the presenter's own notes (notes may explain slides that have no text).`,
  });
  for (const s of session.slides) {
    content.push({ type: "text", text: `--- Slide ${s.index + 1} ---` });
    content.push(imageBlock(await slideForModel(s.image, side)));
    content.push({
      type: "text",
      text: `Slide ${s.index + 1} text: ${s.text || "(none)"}\nPresenter notes: ${s.note?.trim() || "(none)"}`,
    });
  }
  content.push({ type: "text", text: deckInstructions(session, lang) });

  const text = await callClaude({
    system: COACH_PERSONA,
    messages: [{ role: "user", content }],
    max_tokens: 8000,
  });
  return parseJson(text);
}

function deckInstructions(session, lang) {
  return `Presentation title (from the user): ${session.title || "(untitled)"}
Context the user gave: ${session.context || "(none)"}
Planned length per run: ${session.timeLimitMin ? session.timeLimitMin + " minutes" : "not set"}

Task: study this deck so you can coach the presenter. Understand the project, the story and what each slide is for.
Write the key points the presenter must say out loud for each slide, especially things the slide shows but does not explain (design decisions, reasons, research findings, numbers).
Also check the deck against what a design presentation needs and flag what is weak or missing.

Reply in ${langName(lang)} only, as one JSON object and nothing else, with this shape:
{
  "title": "short project name",
  "one_line_story": "the whole presentation in one sentence",
  "audience_takeaway": "what the jury/audience must remember",
  "structure_check": [ { "item": "e.g. Problem / need", "status": "ok" | "weak" | "missing", "comment": "one short sentence" } ],
  "slides": [ { "slide": 1, "title": "short", "purpose": "why this slide exists", "key_points": ["point to say"], "must_say": ["the one or two things that must not be skipped"], "suggested_seconds": 30, "tip": "delivery tip for this slide" } ],
  "questions_to_expect": ["likely jury questions"],
  "suggested_total_minutes": 8
}
Include every slide. Keep each point short (max ~15 words).`;
}

// ---------- 2. Rehearsal feedback ----------
export async function rehearsalFeedback(session, attempt, lang) {
  const brief = session.brief;
  const prev = [...(session.attempts || [])].filter((a) => a.id !== attempt.id && a.feedback).at(-1);
  const learned = learningSummary();
  const slidesInRun = attempt.mode === "slide" ? [attempt.slideIndex + 1] : null;

  const ctx = {
    mode: attempt.mode === "slide" ? `single slide (slide ${attempt.slideIndex + 1})` : "full presentation",
    time_limit_s: attempt.timeLimitSec || null,
    deck_brief: brief
      ? {
          one_line_story: brief.one_line_story,
          audience_takeaway: brief.audience_takeaway,
          slides: (brief.slides || [])
            .filter((s) => !slidesInRun || slidesInRun.includes(s.slide))
            .map((s) => ({ slide: s.slide, title: s.title, key_points: s.key_points, must_say: s.must_say, suggested_seconds: s.suggested_seconds })),
        }
      : null,
    presenter_notes: session.slides
      .filter((s) => s.note?.trim() && (!slidesInRun || slidesInRun.includes(s.index + 1)))
      .map((s) => ({ slide: s.index + 1, note: s.note })),
    measurements: attempt.metrics,
  };

  const focus = [...(session.focus || []), ...(session.customFocus ? [session.customFocus] : [])];
  const goals = attempt.goals?.length ? attempt.goals : [];

  const content = [];
  if (attempt.snapshots?.length) {
    content.push({ type: "text", text: `Snapshots of the presenter taken during the run (in time order):` });
    attempt.snapshots.forEach((s) => {
      content.push({ type: "text", text: `t=${s.t}s, slide ${s.slide}` });
      content.push(imageBlock(s.image));
    });
  }
  content.push({
    type: "text",
    text: `Rehearsal data (JSON):\n${JSON.stringify(ctx)}

How to read the measurements:
- They come from on-device computer vision and audio analysis of the webcam + mic. They are approximate signals, not ground truth.
- "eye contact with camera" = looking at the audience. Looking down usually means reading notes/screen.
- Hands percentages depend on framing: if hands are rarely visible, the presenter may be too close or hands may be hidden — say which is likely from the snapshots.
- Browser speech recognition often drops "um/uh" sounds, so filler counts are a lower bound. Transcripts may contain recognition errors; don't criticise wording that looks like a recognition error.
- Pitch variation under ~2 semitones tends to sound monotone; 3-6 is lively. Comfortable pace is ~120-160 words/min (Hebrew often counts fewer words per minute because words are longer).
- If speech recognition was not available, say content coverage could not be checked.

The presenter asked to focus especially on: ${focus.length ? focus.join("; ") : "(nothing specific — cover everything)"}
${goals.length ? `Goals the presenter set for THIS attempt (from previous feedback): ${goals.join("; ")}. Say clearly whether each improved.` : ""}
${prev ? `Previous attempt for comparison: score ${prev.feedback.overall_score}/10, headline "${prev.feedback.headline}", key metrics ${JSON.stringify(compactMetrics(prev.metrics))}.` : ""}
${learned ? `\nWhat this user has told us about past feedback (adapt your style to it):\n${learned}` : ""}

Write coaching feedback in ${langName(lang)}. Be specific, cite evidence (numbers, slide numbers, moments, snapshots). Give the requested focus areas extra depth. Order categories so the focus areas come first.
Reply with one JSON object only:
{
  "overall_score": 1-10,
  "headline": "one sentence",
  "summary": "2-3 sentences",
  "strengths": ["specific strength"],
  "categories": [ { "key": "eye_contact|gestures|posture|movement|facial_expression|pace|tone|volume|fluency|diction|filler_words|confidence|enthusiasm|content_coverage|timing|structure", "label": "human label", "score": 1-10, "observation": "what you saw, with evidence", "tip": "one concrete thing to do" } ],
  "focus_feedback": [ { "focus": "the requested focus", "observation": "...", "tip": "...", "drill": "a short exercise" } ],
  "slides": [ { "slide": 1, "covered": ["key points said"], "missed": ["key points not said"], "comment": "short" } ],
  "timing": { "used_s": 0, "limit_s": 0, "comment": "short" },
  "goals_check": [ { "goal": "...", "improved": true, "comment": "..." } ],
  "action_plan": [ { "step": "what to do", "how": "how exactly" } ],
  "next_attempt": { "type": "full" | "slide", "slide": null, "goals": ["max 3 short goals for the next try"] },
  "compared_to_previous": "short sentence or null"
}
Use 6-10 categories. Only include "slides" entries for slides in this run. "goals_check" only if goals were given.`,
  });

  const text = await callClaude({
    system: COACH_PERSONA,
    messages: [{ role: "user", content }],
    max_tokens: 6000,
  });
  return parseJson(text);
}

function compactMetrics(m) {
  if (!m) return null;
  return {
    duration_s: m.duration_s,
    eye: m.face?.eye_contact_with_camera_pct,
    gesturing: m.hands?.active_gesturing_pct,
    wpm: m.voice?.words_per_minute_overall,
    pitch_var: m.voice?.pitch_variation_semitones,
    fillers: m.voice?.filler_words,
  };
}

// ---------- 3. Follow-up dialog ----------
export async function chatReply(session, lang) {
  const latest = [...(session.attempts || [])].filter((a) => a.feedback).at(-1);
  const learned = learningSummary();
  const context = `Context for this coaching conversation (do not repeat it back):
Deck: ${session.brief ? JSON.stringify({ title: session.brief.title, story: session.brief.one_line_story, slides: session.brief.slides?.map((s) => ({ slide: s.slide, title: s.title, must_say: s.must_say })) }) : "(not analysed)"}
Attempts so far: ${(session.attempts || []).filter((a) => a.feedback).map((a, i) => `#${i + 1} ${a.mode === "slide" ? "slide " + (a.slideIndex + 1) : "full"}: ${a.feedback.overall_score}/10`).join(", ")}
Latest feedback: ${latest ? JSON.stringify(latest.feedback) : "(none)"}
Latest measurements: ${latest ? JSON.stringify(latest.metrics) : "(none)"}
User focus requests: ${[...(session.focus || []), session.customFocus].filter(Boolean).join("; ") || "(none)"}
${learned ? `What this user has told us about past feedback:\n${learned}` : ""}`;

  const turns = [{ role: "user", content: context }, { role: "assistant", content: "Understood." }];
  for (const m of session.chat || []) {
    const role = m.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last.role === role) last.content += "\n\n" + m.content;
    else turns.push({ role, content: m.content });
  }
  if (turns[turns.length - 1].role !== "user") throw new Error("Nothing to answer");

  return callClaude({
    system: `${COACH_PERSONA}
You are now in a follow-up conversation after giving rehearsal feedback. Answer in ${langName(lang)}.
Keep answers short and conversational (under ~150 words unless asked for more). Use plain text, at most a short list.
When the user disagrees with a comment, take it seriously: explain the evidence, or accept the correction.
When useful, suggest a concrete next step: re-recording a specific slide, the whole presentation, or a short drill.`,
    messages: turns,
    max_tokens: 1200,
  });
}
