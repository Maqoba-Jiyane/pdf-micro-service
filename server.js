// server.js (ESM)
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const PDF_KEY = process.env.PDF_KEY || ""; // required shared secret
const URL_ALLOWLIST = (process.env.URL_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Optional CORS: set allowed origins if you'll call this directly from the browser
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));

// Minimal CORS (server-to-server recommended; expose only if needed)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PDF-Key");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Playwright singleton (warm)
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
getBrowser().catch(console.error); // warm on boot

// Utils
function sanitizeFileName(name = "resume.pdf") {
  let n = String(name).replace(/[^a-z0-9._-]+/gi, "_");
  if (!n.toLowerCase().endsWith(".pdf")) n += ".pdf";
  return n.slice(0, 128);
}
function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return URL_ALLOWLIST.some((prefix) => url.startsWith(prefix));
  } catch {
    return false;
  }
}

// Healthcheck
app.get("/healthz", (_, res) => res.send("ok"));

// Main endpoint
app.post("/pdf", async (req, res) => {
  try {
    // Auth
    const key = req.headers["x-pdf-key"];
    if (!PDF_KEY || key !== PDF_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { url, html, baseUrl, fileName, media, waitForSelector } = req.body || {};
    if (!url && !html) return res.status(400).json({ error: "Provide url or html" });

    if (url && !isAllowedUrl(url)) {
      return res.status(400).json({ error: "URL not allowed" });
    }

    const browser = await getBrowser();
    const page = await browser.newPage({ deviceScaleFactor: 2 });

    if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 10000 });
    }
    // "screen" keeps the page looking exactly like the app.
    await page.emulateMedia({ media: media === "print" ? "print" : "screen" });

    if (url) {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    } else {
      const content = baseUrl
        ? String(html).replace(/<head>/i, `<head><base href="${baseUrl}">`)
        : String(html);
      await page.setContent(content, { waitUntil: "load", timeout: 20000 });
    }

    // ensure web fonts are ready
    await page.evaluate(async () => { /* @ts-ignore */
      await (document && document.fonts && document.fonts.ready) || null;
    });

    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true, // use @page if you set it (A4, margins, etc.)
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      timeout: 20000,
    });

    await page.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(fileName || "resume.pdf")}"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (e) {
    console.error("PDF error:", e);
    res.status(500).json({ error: "PDF failed" });
  }
});

app.listen(PORT, () => console.log(`PDF service on :${PORT}`));
