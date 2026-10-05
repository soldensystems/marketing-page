// Fail-closed contact admission: verify the visitor, atomically reserve durable quotas and
// delivery state, then send immutable email payloads with stable provider idempotency keys.
import { createHash, createHmac } from "node:crypto";
import { buildInternalEmail, buildProspectEmail } from "./email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_FILL_MS = 3000;
const LIMITS = { name: 120, email: 200, company: 160, message: 4000 };
const HOUR_MS = 60 * 60 * 1000;
const MEMORY_MAX_KEYS = 10_000;
const WHY_BY_STATUS = { 400: "invalid", 403: "verification", 409: "pending", 429: "limit", 503: "config", 502: "delivery" };
const LABELS = { name: "Name", email: "Work email", company: "Company", message: "How your close runs today" };
const RETURN_PATHS = new Set(["/", "/about", "/how-it-works"]);
const UNAVAILABLE = "The contact form is unavailable right now. Please try again in a few minutes, or email hello@soldenai.com.";
const VERIFY_AGAIN = "Please complete the security check again, then retry. You can also email hello@soldenai.com.";
export const TURNSTILE_ACTION = "contact";

export function contactConfiguration(env) {
  const origins = String(env.CONTACT_ALLOWED_ORIGINS || "https://soldenai.com,https://www.soldenai.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  try {
    // Explicit exact origins, independent of request Host or forwarding headers.
    if (!origins.length || origins.some((origin) => {
      const url = new URL(origin);
      return url.origin !== origin || !["https:", "http:"].includes(url.protocol) ||
        (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    })) return null;
    const siteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
    const secretKey = String(env.TURNSTILE_SECRET_KEY || "").trim();
    if (!siteKey || !secretKey) return null;
    // Cloudflare's public test keys must never protect a production deployment.
    if ((env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT) &&
        [siteKey, secretKey].some((key) => /^[123]x0{10,}/.test(key))) return null;
    return { siteKey, secretKey, origins, hostnames: new Set(origins.map((origin) => new URL(origin).hostname)) };
  } catch { return null; }
}

export function createContactHandler(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const storeTimeoutMs = options.storeTimeoutMs ?? 2500;
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 5000;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 6000;
  const getStore = options.getStore ?? (async () => options.store ?? null);
  const memory = new Map();
  const limits = {
    ipPerHour: parseMaxPerHour(env.CONTACT_MAX_PER_IP_PER_HOUR, 5),
    recipientPerHour: parseMaxPerHour(env.CONTACT_MAX_PER_RECIPIENT_PER_HOUR, 3),
    confirmationsPerHour: parseMaxPerHour(env.CONTACT_MAX_CONFIRMATIONS_PER_HOUR, 20, 0),
  };
  const maxAttempts = parseMaxPerHour(env.CONTACT_MAX_ATTEMPTS_PER_IP_PER_HOUR, 30);

  // A cheap process-local burst brake, reserved synchronously before external work.
  // Durable cross-instance delivery quotas are reserved by claimSubmission below.
  function reserveAttempt(ipHash) {
    const cutoff = now() - HOUR_MS;
    for (const [key, hits] of memory) {
      const fresh = hits.filter((ts) => ts > cutoff);
      if (!fresh.length) memory.delete(key);
      else memory.set(key, fresh);
    }
    const hits = memory.get(ipHash) || [];
    if (hits.length >= maxAttempts || (!memory.has(ipHash) && memory.size >= MEMORY_MAX_KEYS)) return false;
    hits.push(now());
    memory.set(ipHash, hits);
    return true;
  }

  const storageCall = (label, work) => withTimeout(Promise.resolve().then(work), storeTimeoutMs, label);

  return async function handleContact(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { ok: false, message: "Method not allowed." });
    }
    const configuration = contactConfiguration(env);
    // Missing, opaque, foreign and forged-forwarded-host origins all fail closed.
    if (!configuration) return send(req, res, 503, { ok: false, message: UNAVAILABLE });
    if (!configuration.origins.includes(req.headers?.origin)) {
      return send(req, res, 403, { ok: false, message: "Not sent. Please use the form on soldenai.com, or email hello@soldenai.com." });
    }

    let body;
    try { body = await readBody(req); }
    catch { return send(req, res, 400, { ok: false, message: "Could not read the form. Please email hello@soldenai.com." }); }

    const fields = {
      name: clean(body.name, LIMITS.name),
      email: clean(body.email, LIMITS.email).toLowerCase(),
      company: clean(body.company, LIMITS.company),
      message: cleanText(body.message, LIMITS.message),
    };
    // Keep the honeypot as a cheap additional signal. The timer is never proof of humanity.
    if (clean(body.website, 200)) return send(req, res, 200, { ok: true, message: successMessage() });
    const missing = Object.entries(fields).filter(([, value]) => !value).map(([key]) => LABELS[key]);
    if (missing.length) return send(req, res, 400, { ok: false, message: `Please fill in: ${missing.join(", ")}.` });
    if (!EMAIL_PATTERN.test(fields.email)) return send(req, res, 400, { ok: false, message: "Please enter a valid work email." });
    const elapsed = typeof body.t === "string" && body.t.trim() ? Number(body.t) : typeof body.t === "number" ? body.t : NaN;
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      return send(req, res, 400, { ok: false, message: "Please take a moment to review the form, then try again. You can also email hello@soldenai.com." });
    }
    const ipHash = hashIp(clientIp(req), env.IP_HASH_SECRET);
    if (!reserveAttempt(ipHash)) return limited(req, res);
    if (!env.RESEND_API_KEY || !recipients(env).length) return send(req, res, 503, { ok: false, message: UNAVAILABLE });

    const token = body["cf-turnstile-response"];
    if (typeof token !== "string" || !token.trim() || token.length > 2048) {
      return send(req, res, 403, { ok: false, message: VERIFY_AGAIN });
    }
    let verified;
    try {
      verified = await withTimeout((async () => {
        const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST", signal: AbortSignal.timeout(verificationTimeoutMs),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: configuration.secretKey, response: token }),
        });
        if (!response.ok) throw new Error("verification unavailable");
        return response.json();
      })(), verificationTimeoutMs, "verification");
    } catch {
      console.error("contact: verification service unavailable");
      return send(req, res, 503, { ok: false, message: UNAVAILABLE });
    }
    if (!verified || verified.success !== true || verified.action !== TURNSTILE_ACTION || !configuration.hostnames.has(verified.hostname)) {
      return send(req, res, 403, { ok: false, message: VERIFY_AGAIN });
    }

    let store;
    let claim;
    try {
      store = await storageCall("connect", getStore);
      if (!store) throw new Error("store not configured");
      const source = clean(body.source, 40) || "soldenai.com";
      // Exclude page source and IP, so retries across pages/connections share a delivery.
      const dedupKey = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      claim = await storageCall("claim", () => store.claimSubmission({
        dedupKey,
        lead: { ...fields, source, ip_hash: ipHash, user_agent: clean(req.headers?.["user-agent"], 400) },
        limits,
        buildMessages: (leadId) => buildMessages(env, fields, { leadId, source }),
      }));
      if (claim.status === "limited") return limited(req, res);
      if (claim.status === "complete") return send(req, res, 200, { ok: true, message: successMessage() });
      if (claim.status === "busy") {
        res.setHeader("Retry-After", "30");
        return send(req, res, 409, { ok: false, message: "Your request is still being processed. Please wait 30 seconds before trying again, or email hello@soldenai.com." });
      }
      if (claim.status !== "claimed") throw new Error("delivery requires review");
    } catch {
      console.error("contact: durable admission unavailable");
      return send(req, res, 503, { ok: false, message: UNAVAILABLE });
    }

    let responseStatus = 200;
    try {
      if (!claim.teamSent) {
        await deliver(fetchImpl, env, claim.team, `contact-team/${claim.id}`, deliveryTimeoutMs);
        if (!await storageCall("team receipt", () => store.markSent(claim.id, claim.leaseToken, "team"))) throw new Error("lease lost");
      }
      if (claim.confirmation && !claim.confirmationSent) {
        try {
          const permitted = await storageCall("confirmation permit", () =>
            store.authorizeConfirmation(claim.id, claim.leaseToken, limits.confirmationsPerHour));
          if (permitted) {
            await deliver(fetchImpl, env, claim.confirmation, `contact-confirmation/${claim.id}`, deliveryTimeoutMs);
            if (!await storageCall("confirmation receipt", () => store.markSent(claim.id, claim.leaseToken, "confirmation"))) throw new Error("lease lost");
          }
        } catch {
          // Team delivery is the commitment. Retain pending confirmation for a safe retry.
          console.error("contact: prospect confirmation pending");
        }
      }
    } catch {
      console.error("contact: team delivery pending");
      responseStatus = 502;
    } finally {
      try { await storageCall("release", () => store.finishSubmission(claim.id, claim.leaseToken)); }
      catch { console.error("contact: delivery lease will expire"); }
    }
    return send(req, res, responseStatus, {
      ok: responseStatus === 200,
      message: responseStatus === 200 ? successMessage() : "Your message could not be confirmed as sent. Please retry in a few minutes, or email hello@soldenai.com.",
    });
  };
}

export function parseMaxPerHour(raw, fallback = 5, minimum = 1) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function limited(req, res) {
  res.setHeader("Retry-After", "3600");
  return send(req, res, 429, { ok: false, message: "Too many messages. Please try again later, or email hello@soldenai.com." });
}

function successMessage() {
  return "Invite requested. We reply within two business days, then a short call to scope your replay.";
}

function recipients(env) {
  return String(env.LEAD_NOTIFY_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function deliver(fetchImpl, env, message, key, timeoutMs) {
  await withTimeout((async () => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error("delivery unavailable");
  })(), timeoutMs, "delivery");
}

function buildMessages(env, fields, { leadId, source }) {
  const from = env.LEAD_NOTIFY_FROM || "Solden <leads@soldenai.com>";
  return {
    team: { from, to: recipients(env), reply_to: fields.email, ...buildInternalEmail(fields, { leadId, source }) },
    confirmation: { from, to: [fields.email], reply_to: recipients(env)[0], ...buildProspectEmail(fields) },
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readBody(req) {
  // A framework body parser (Express) may already have run.
  if (req.body !== undefined && req.body !== null && typeof req.body !== "string") return asRecord(req.body);
  const contentType = String(req.headers?.["content-type"] || "");
  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw && typeof req.on === "function") {
    raw = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 32 * 1024) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }
  if (!raw) return {};
  if (contentType.includes("application/json")) return asRecord(JSON.parse(raw));
  return Object.fromEntries(new URLSearchParams(raw));
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// The message keeps its line breaks: runs of other whitespace collapse, and at most one blank line survives.
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

// Trust Express's configured proxy chain, or the connection itself. Never parse arbitrary
// forwarding headers in this framework-independent handler.
function clientIp(req) {
  if (typeof req.ip === "string" && req.ip) return req.ip;
  return req.socket?.remoteAddress || "unknown";
}

function hashIp(ip, secret) {
  const hash = secret ? createHmac("sha256", secret) : createHash("sha256");
  return hash.update(ip).digest("hex").slice(0, 32);
}

function wantsJson(req) {
  const accept = String(req.headers?.accept || "");
  const contentType = String(req.headers?.["content-type"] || "");
  return accept.includes("application/json") || contentType.includes("application/json");
}

// Where a plain form post goes back to on error: the referring page, if it is one of the pages
// that carries the form (path only, so this can never redirect off-site), or /about#contact.
function returnLocation(req, status) {
  const why = WHY_BY_STATUS[status] || "delivery";
  let pathname = "/about";
  const referer = req.headers?.referer || req.headers?.referrer;
  if (referer) {
    try {
      const candidate = new URL(String(referer), "http://localhost").pathname;
      if (RETURN_PATHS.has(candidate)) pathname = candidate;
    } catch {
      // Ignore a malformed Referer and fall back to /about.
    }
  }
  const anchor = pathname === "/" ? "invite" : "contact";
  return `${pathname}?sent=0&why=${why}#${anchor}`;
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function send(req, res, status, payload) {
  if (!wantsJson(req)) {
    return redirect(res, status === 200 ? "/thanks" : returnLocation(req, status));
  }
  return sendJson(res, status, payload);
}
