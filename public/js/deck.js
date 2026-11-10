// PDF deck → slide images (rendered in the browser with pdf.js)

const PDFJS_VERSION = "4.4.168";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return pdfjs;
}

export const MAX_SLIDES = 60;

/**
 * Renders every page of a PDF to a JPEG data URL.
 * Returns [{ index, image, text }] — text is whatever selectable text the page holds.
 */
export async function pdfToSlides(file, onProgress = () => {}) {
  const lib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const count = Math.min(doc.numPages, MAX_SLIDES);
  const slides = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = 1280 / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    let text = "";
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    } catch {}
    slides.push({ index: i - 1, image: canvas.toDataURL("image/jpeg", 0.82), text, note: "" });
    onProgress(i, count);
  }
  return { slides, truncated: doc.numPages > MAX_SLIDES, total: doc.numPages };
}

/** Image files (png/jpg) can be uploaded as slides too. */
export async function imagesToSlides(files) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const slides = [];
  for (const f of sorted.slice(0, MAX_SLIDES)) {
    const url = await fileToDataUrl(f);
    const img = await loadImage(url);
    slides.push({ index: slides.length, image: downscale(img, 1280, 0.82), text: "", note: "" });
  }
  return { slides, truncated: sorted.length > MAX_SLIDES, total: sorted.length };
}

export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/** Downscale an image/canvas/video to a JPEG data URL whose longest side is maxSide. */
export function downscale(source, maxSide, quality = 0.75) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

/** Smaller copy of a slide image for sending to the model. */
export async function slideForModel(dataUrl, maxSide) {
  const img = await loadImage(dataUrl);
  return downscale(img, maxSide, 0.7);
}
