// Local persistence: sessions in IndexedDB (slides are images, too big for localStorage),
// small settings + the learning profile in localStorage.

const DB_NAME = "kriti";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("sessions", mode);
    const store = t.objectStore("sessions");
    const result = fn(store);
    t.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  // Recorded videos are Blobs held in memory only (download to keep them).
  const copy = { ...session, attempts: (session.attempts || []).map(({ videoUrl, videoBlob, ...a }) => a) };
  await tx("readwrite", (s) => s.put(copy));
}

export async function getSession(id) {
  return tx("readonly", (s) => s.get(id));
}

export async function listSessions() {
  const all = (await tx("readonly", (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteSession(id) {
  await tx("readwrite", (s) => s.delete(id));
}

// ---- settings ----
export function getSetting(key, fallback) {
  try {
    const v = localStorage.getItem("kriti." + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  try {
    localStorage.setItem("kriti." + key, JSON.stringify(value));
  } catch {}
}

// ---- learning profile: what the user found helpful / not helpful ----
// Each entry: { at, kind: "item"|"overall", category, text, rating (+1/-1 or 1..5), note }
export function getLearning() {
  return getSetting("learning", []);
}

export function addLearning(entry) {
  // entries with a key (e.g. one rated comment) are updated in place, not duplicated
  const list = getLearning().filter((e) => !entry.key || e.key !== entry.key);
  if (entry.rating == null && !entry.note) {
    setSetting("learning", list);
    return;
  }
  list.push({ at: Date.now(), ...entry });
  setSetting("learning", list.slice(-200));
}

export function clearLearning() {
  setSetting("learning", []);
}

// Turn the raw ratings into a compact profile the model can use.
export function learningSummary() {
  const list = getLearning();
  if (!list.length) return "";
  const byCat = {};
  for (const e of list) {
    if (e.kind !== "item") continue;
    const c = e.category || "general";
    byCat[c] = byCat[c] || { up: 0, down: 0 };
    if (e.rating > 0) byCat[c].up++;
    else byCat[c].down++;
  }
  const catLines = Object.entries(byCat).map(
    ([c, v]) => `- ${c}: ${v.up} helpful, ${v.down} not helpful`
  );
  const liked = list.filter((e) => e.kind === "item" && e.rating > 0).slice(-8);
  const disliked = list.filter((e) => e.kind === "item" && e.rating < 0).slice(-8);
  const notes = list.filter((e) => e.note && e.note.trim()).slice(-10);
  const overall = list.filter((e) => e.kind === "overall").slice(-5);

  const out = [];
  out.push("Ratings per feedback category:");
  out.push(...catLines);
  if (liked.length) {
    out.push("Examples of comments the user found HELPFUL (keep this style):");
    liked.forEach((e) => out.push(`  + ${trim(e.text)}`));
  }
  if (disliked.length) {
    out.push("Examples of comments the user found NOT helpful (avoid this style):");
    disliked.forEach((e) => out.push(`  - ${trim(e.text)}`));
  }
  if (notes.length) {
    out.push("User's own notes about the feedback:");
    notes.forEach((e) => out.push(`  * "${trim(e.note)}"${e.text ? ` (about: ${trim(e.text, 60)})` : ""}`));
  }
  if (overall.length) {
    out.push("Overall session ratings (1-5): " + overall.map((e) => e.rating).join(", "));
  }
  return out.join("\n");
}

function trim(s, n = 140) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
