// server.js (ESM)
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const SERVICE_KEY = process.env.PDF_KEY || ""; // reuse the same secret
const URL_ALLOWLIST = (process.env.URL_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.length && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PDF-Key");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Playwright singleton ----
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--font-render-hinting=none"],
    });
  }
  return browserPromise;
}
getBrowser().catch(console.error);

// ---- utils ----
function isAllowedUrl(url) {
  try {
    new URL(url);
    return URL_ALLOWLIST.some((prefix) => url.startsWith(prefix));
  } catch {
    return false;
  }
}
function normalizeSelector(val, fallback = null) {
  if (typeof val === "string" && val.trim()) return val.trim();
  if (Array.isArray(val)) {
    const s = val.find((v) => typeof v === "string" && v.trim());
    if (s) return s.trim();
  }
  if (val && typeof val === "object") {
    if (typeof val.selector === "string" && val.selector.trim()) return val.selector.trim();
    if (typeof val.value === "string" && val.value.trim()) return val.value.trim();
  }
  return fallback; // null = no selector wait
}

// ---- health ----
app.get("/healthz", (_, res) => res.send("ok"));

// ---- grab endpoint ----
// Body:
// {
//   "url": "https://...",
//   "mode": "html" | "screenshot",   // default "html"
//   "media": "screen" | "print",     // default "screen"
//   "waitForSelector": "#resume-root",
//   "extraHeaders": { "ngrok-skip-browser-warning": "1" },
//   "timeoutMs": 45000               // optional
// }
app.post("/grab", async (req, res) => {
  try {
    // Auth
    const key = req.headers["x-pdf-key"];
    if (!SERVICE_KEY || key !== SERVICE_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      url,
      mode = "html",
      media = "screen",
      waitForSelector,
      extraHeaders,
      timeoutMs = 45000,
    } = req.body || {};

    if (!url) return res.status(400).json({ error: "Provide url" });
    if (!isAllowedUrl(url)) return res.status(400).json({ error: "URL not allowed" });

    const browser = await getBrowser();
    const page = await browser.newPage({ deviceScaleFactor: 2 });

    // Forward headers to target (dev: skip ngrok warning)
    const hdrs = { ...(extraHeaders || {}) };
    if (/ngrok-(free\.app|io)/.test(url)) {
      hdrs["ngrok-skip-browser-warning"] = hdrs["ngrok-skip-browser-warning"] || "1";
    }
    if (Object.keys(hdrs).length) await page.setExtraHTTPHeaders(hdrs);

    // Match on-screen styles by default
    await page.emulateMedia({ media: media === "print" ? "print" : "screen" });

    // Go to the page
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

    // Optional waits
    const selector = normalizeSelector(waitForSelector, null);
    if (selector) {
      // element present
      await page.waitForSelector(selector, { state: "attached", timeout: 30000 });
      // basic readiness (best-effort)
      await page.waitForLoadState("networkidle").catch(() => {});
      // fonts
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      });
    }

    // Return
    if (mode === "screenshot") {
      const img = await page.screenshot({ fullPage: true });
      await page.close();
      res.type("image/png").send(img);
      return;
    }

    // default: HTML
    const html = await page.content();
    await page.close();
    res.type("text/html").send(html);
  } catch (e) {
    console.error("GRAB error:", e);
    res.status(500).json({ error: "Grab failed" });
  }
});

app.listen(PORT, () => console.log(`Grab service on :${PORT}`));
