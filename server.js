// server.js (ESM)
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const PDF_KEY = process.env.PDF_KEY || ""; // required shared secret
const URL_ALLOWLIST = (process.env.URL_ALLOWLIST || "")
  .split(",").map(s => s.trim()).filter(Boolean); // list of allowed ORIGINS (e.g., https://app.example.com)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: "3mb" }));

// CORS (only if calling directly from browsers; server-to-server preferred)
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

// Allow by ORIGIN (protocol + host + port), not by raw string prefix
function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    const origin = u.origin;
    return URL_ALLOWLIST.some(allowed => {
      try { return new URL(allowed).origin === origin; } catch { return false; }
    });
  } catch { return false; }
}

// If running PDF service in Docker and target is on host, rewrite localhost → host.docker.internal when FORCE_HOST_INTERNAL=1
function maybeRewriteLocalhost(raw) {
  try {
    const u = new URL(raw);
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
    if (isLocal && process.env.FORCE_HOST_INTERNAL === "1") {
      u.hostname = "host.docker.internal";
      return u.toString();
    }
    return raw;
  } catch { return raw; }
}

// Normalize selector input
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

// Optional: capture a quick screenshot + html size for debugging (stored in /tmp inside container)
async function snapshot(page, tag = "debug") {
  try {
    const ts = Date.now();
    const shotPath = `/tmp/${tag}-${ts}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    const html = await page.content();
    return { shotPath, htmlLen: html.length };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- health ----
app.get("/healthz", (_, res) => res.send("ok"));

// Simple no-network test (generates a 1-page PDF)
app.get("/pdf/simple", async (req, res) => {
  try {
    req.headers["x-pdf-key"] = PDF_KEY;
    req.body = {
      html: "<!doctype html><html><head><meta charset=utf-8><style>@page{size:A4;margin:10mm}body{font-family:system-ui}</style></head><body><h1>OK</h1></body></html>",
      fileName: "test.pdf"
    };
    app._router.handle({ ...req, method: "POST", url: "/pdf" }, res, () => null);
  } catch (e) {
    res.status(500).json({ error: "simple route failed", details: String(e) });
  }
});

// ---- PDF endpoint ----
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
      waitForSelector,           // optional, e.g. "#resume-root"
      extraHeaders,              // optional headers to target page
      timeoutMs = 45000,         // nav/content timeout
      delay = 300,               // small settle delay before PDF
      readyStrategy = "normal"   // "strict" | "normal" | "eager"
    } = req.body || {};

    if (!url && !html) return res.status(400).json({ error: "Provide url or html" });

    let targetUrl = url ? maybeRewriteLocalhost(url) : null;
    if (targetUrl && !isAllowedUrl(targetUrl)) {
      return res.status(400).json({ error: "URL not allowed", targetUrl });
    }

    const browser = await getBrowser();
    const page = await browser.newPage({ deviceScaleFactor: 2 });

    // Diagnostics (console logs, failed requests, bad responses)
    page.on("console", msg => console.log("[page console]", msg.type(), msg.text()));
    page.on("requestfailed", req_ => console.warn("[request failed]", req_.url(), req_.failure()?.errorText));
    page.on("response", resp => {
      if (!resp.ok()) console.warn("[bad response]", resp.status(), resp.url());
    });

    // Forward headers to target (dev: skip ngrok warning)
    const hdrs = { ...(extraHeaders || {}) };
    if (targetUrl && /ngrok-(free\.app|io)/.test(targetUrl)) {
      hdrs["ngrok-skip-browser-warning"] = hdrs["ngrok-skip-browser-warning"] || "1";
    }
    if (Object.keys(hdrs).length) await page.setExtraHTTPHeaders(hdrs);

    // Stable viewport & media
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ media: media === "print" ? "print" : "screen" });

    // Navigate / Set content (single block with checks)
    let navResponse = null;
    try {
      if (targetUrl) {
        navResponse = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        const status = navResponse?.status();
        const finalUrl = page.url();

        if (!navResponse) {
          return res.status(502).json({ error: "No response from target", targetUrl });
        }
        if (!navResponse.ok()) {
          return res.status(502).json({
            error: "Target returned non-OK status",
            status, finalUrl, targetUrl
          });
        }
        if (finalUrl.includes("/login") || finalUrl.includes("/auth")) {
          return res.status(401).json({ error: "Auth redirect detected", finalUrl });
        }
      } else {
        const content = baseUrl
          ? String(html).replace(/<head>/i, `<head><base href="${baseUrl}">`)
          : String(html);
        await page.setContent(content, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      }
    } catch (navErr) {
      console.error("Navigation error:", navErr?.message, { targetUrl, timeoutMs });
      return res.status(502).json({
        error: "Navigation failed",
        details: navErr?.message || String(navErr),
        targetUrl
      });
    }

    // Readiness (soft-fail; don’t stall forever)
    const selector = normalizeSelector(waitForSelector, null);
    const imageWaitMs = readyStrategy === "strict" ? 15000 : readyStrategy === "eager" ? 0 : 8000;
    const minHeight   = readyStrategy === "strict" ? 150   : 50;

    try {
      if (selector) {
        await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
      }

      // Mostly idle; ignore hanging sockets
      await page.waitForLoadState("networkidle").catch(() => {});

      // Web fonts ready (best effort)
      await page.evaluate(async () => {
        try { if (document.fonts?.ready) await document.fonts.ready; } catch {}
      });

      // Images loaded (best effort)
      if (imageWaitMs > 0) {
        await page.waitForFunction(
          () => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0),
          { timeout: imageWaitMs }
        ).catch(() => { console.warn("images still loading; proceeding"); });
      }

      // Container has some size
      if (selector) {
        await page.waitForFunction(
          (sel, h) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.height > h;
          },
          { timeout: 8000 },
          selector, minHeight
        ).catch(() => { console.warn("container not tall enough; proceeding"); });
      }

      // Nudge lazy loaders
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(typeof delay === "number" ? delay : 300);
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch (waitErr) {
      const snap = await snapshot(page, "wait-failed");
      console.warn("Readiness failed:", waitErr?.message, { finalUrl: page.url(), ...snap });
      // Continue to PDF anyway
    }

    // Create PDF
    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "5mm", right: "5mm", bottom: "5mm", left: "5mm" },
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

// Graceful shutdown
async function closeBrowser() {
  try { const b = await browserPromise; await b?.close(); } catch {}
}
process.on("SIGTERM", closeBrowser);
process.on("SIGINT",  closeBrowser);
