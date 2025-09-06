// server.js (ESM)
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const PDF_KEY = process.env.PDF_KEY || "";                 // required shared secret
const URL_ALLOWLIST = (process.env.URL_ALLOWLIST || "")    // comma-separated origins
  .split(",").map(s => s.trim()).filter(Boolean);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: "3mb" }));

// Only needed if you’ll ever call directly from a browser; server-to-server is better.
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
function sanitizeFileName(name = "file.pdf") {
  let n = String(name).replace(/[^a-z0-9._-]+/gi, "_");
  if (!n.toLowerCase().endsWith(".pdf")) n += ".pdf";
  return n.slice(0, 128);
}
function isAllowedUrl(url) {
  try {
    new URL(url);
    return URL_ALLOWLIST.some(prefix => url.startsWith(prefix));
  } catch { return false; }
}
function normalizeSelector(val, fallback = null) {
  if (typeof val === "string" && val.trim()) return val.trim();
  if (Array.isArray(val)) {
    const s = val.find(v => typeof v === "string" && v.trim());
    if (s) return s.trim();
  }
  if (val && typeof val === "object") {
    if (typeof val.selector === "string" && val.selector.trim()) return val.selector.trim();
    if (typeof val.value === "string" && val.value.trim()) return val.value.trim();
  }
  return fallback; // null = skip selector wait
}

// ---- health ----
app.get("/healthz", (_, res) => res.send("ok"));

// ---- PDF endpoint ----
// Body (examples):
// { "url": "https://.../preview/print?token=...", "fileName": "resume.pdf", "waitForSelector": "#resume-root", "media": "screen", "extraHeaders": {"ngrok-skip-browser-warning":"1"} }
// or
// { "html": "<!doctype html>...", "baseUrl": "https://site/", "fileName": "resume.pdf" }
app.post("/pdf", async (req, res) => {
  try {
    // Auth
    const key = req.headers["x-pdf-key"];
    if (!PDF_KEY || key !== PDF_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      url,
      html,
      baseUrl,
      fileName,
      media = "screen",
      waitForSelector,          // optional, e.g. "#resume-root"
      extraHeaders,             // optional headers to target page
      timeoutMs = 45000,        // nav/content timeout
      delay = 300               // small settle delay before PDF
    } = req.body || {};

    if (!url && !html) return res.status(400).json({ error: "Provide url or html" });
    if (url && !isAllowedUrl(url)) return res.status(400).json({ error: "URL not allowed" });

    const browser = await getBrowser();
    const page = await browser.newPage({ deviceScaleFactor: 2 });

    // Forward headers to target (dev: skip ngrok warning)
    const hdrs = { ...(extraHeaders || {}) };
    if (url && /ngrok-(free\.app|io)/.test(url)) {
      hdrs["ngrok-skip-browser-warning"] = hdrs["ngrok-skip-browser-warning"] || "1";
    }
    if (Object.keys(hdrs).length) await page.setExtraHTTPHeaders(hdrs);

    // Match on-screen styles by default
    await page.emulateMedia({ media: media === "print" ? "print" : "screen" });

    // Navigate / Set content
    if (url) {
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    } else {
      const content = baseUrl
        ? String(html).replace(/<head>/i, `<head><base href="${baseUrl}">`)
        : String(html);
      await page.setContent(content, { waitUntil: "load", timeout: timeoutMs });
    }

    // Readiness (optional but recommended if your page hydrates/loads assets)
    const selector = normalizeSelector(waitForSelector, null);
    if (selector) {
      // element in DOM
      await page.waitForSelector(selector, { state: "attached", timeout: 30000 });
    }
    // page mostly idle; ignore if SPA keeps sockets open
    await page.waitForLoadState("networkidle").catch(() => {});
    // web fonts ready
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    // images loaded
    await page.waitForFunction(
      () => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0),
      { timeout: 15000 }
    ).catch(() => {});
    // container has size (if selector provided)
    if (selector) {
      await page.waitForFunction(
        sel => {
          if (typeof sel !== "string") return false;
          const el = document.querySelector(sel);
          return !!el && el.getBoundingClientRect().height > 200;
        },
        { timeout: 20000 },
        selector
      );
    }
    // settle a bit
    await page.waitForTimeout(typeof delay === "number" ? delay : 300);

    // Create PDF
    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      timeout: 60000
    });

    await page.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(fileName || "file.pdf")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(pdfBuffer));
  } catch (e) {
    console.error("PDF error:", e);
    res.status(500).json({ error: "PDF failed" });
  }
});

app.listen(PORT, () => console.log(`PDF service listening on :${PORT}`));
