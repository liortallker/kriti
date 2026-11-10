// Kriti — presentation coach for designers
// Zero-dependency Node server: serves the web app and proxies requests to the Claude API
// so the API key never reaches the browser.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 40 * 1024 * 1024; // slides + snapshots as base64 images

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleClaude(req, res) {
  if (!API_KEY) {
    return sendJson(res, 500, { error: "ANTHROPIC_API_KEY is not set on the server" });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.message || "Bad JSON" });
  }
  const { system, messages, max_tokens } = payload || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, { error: "messages[] is required" });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(Number(max_tokens) || 4000, 16000),
        system: typeof system === "string" ? system : undefined,
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return sendJson(res, r.status, { error: data?.error?.message || "Claude API error" });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return sendJson(res, 200, { text, usage: data.usage });
  } catch (e) {
    return sendJson(res, 502, { error: "Could not reach Claude API: " + e.message });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    return sendJson(res, 200, { ok: true, hasKey: Boolean(API_KEY), model: MODEL });
  }
  if (req.method === "POST" && req.url === "/api/claude") {
    return handleClaude(req, res);
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Kriti running on http://localhost:${PORT} (model: ${MODEL}, key: ${API_KEY ? "set" : "MISSING"})`);
});
