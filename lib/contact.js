// Contact form handler. Framework-agnostic: works as a Vercel Node function
// and inside the local Express preview server.
//
// Behaviour:
// - Accepts JSON or form-encoded POSTs with name, email, company, message.
// - Honeypot field `website` and a minimum fill time trap bots silently. The client
//   sends `t` as elapsed milliseconds since page load; a submission is rejected as a
//   bot only when `t` is a finite number below MIN_FILL_MS. Missing or non-numeric
//   `t` passes through, so a client without JavaScript is never punished.
// - Rate limits per hashed IP: in memory always, and in Postgres when configured.
//   The hash is an HMAC when IP_HASH_SECRET is set, a plain SHA-256 otherwise.
// - Stores the lead in Postgres when a store is attached. Storage is a record, not the
//   delivery path: every store call is raced against a short timeout and a slow or
//   broken database never blocks the email.
// - Emails the founder inbox through Resend's REST API. The prospect's address is the reply-to.
// - Responds with JSON for fetch() clients. Plain form posts get a 303 redirect: to /thanks
//   on success, back to the referring page with ?sent=0&why=<code> on any error.

import { createHash, createHmac } from "node:crypto";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_FILL_MS = 3000;
const LIMITS = { name: 120, email: 200, company: 160, message: 4000 };
const HOUR_MS = 60 * 60 * 1000;
const MEMORY_MAX_KEYS = 10_000;
const DEFAULT_MAX_PER_HOUR = 5;
const DEFAULT_STORE_TIMEOUT_MS = 2000;
const WHY_BY_STATUS = { 400: "invalid", 429: "limit", 503: "config", 502: "delivery" };

export function createContactHandler(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  // `store` is a ready store object. `getStore` is an async factory called on each
  // request, which lets the host attach Postgres lazily and retry after a failure.
  const getStore = options.getStore ?? (async () => options.store ?? null);
  const memory = new Map();
  const maxPerHour = parseMaxPerHour(env.CONTACT_MAX_PER_IP_PER_HOUR);

  function sweepMemory(cutoff) {
    for (const [key, hits] of memory) {
      const fresh = hits.filter((ts) => ts > cutoff);
      if (fresh.length === 0) memory.delete(key);
      else if (fresh.length !== hits.length) memory.set(key, fresh);
    }
  }

  function recentInMemory(ipHash) {
    const cutoff = now() - HOUR_MS;
    sweepMemory(cutoff);
    return (memory.get(ipHash) || []).length;
  }

  function recordInMemory(ipHash) {
    if (!memory.has(ipHash) && memory.size >= MEMORY_MAX_KEYS) {
      // Cap the map: drop the oldest key. Entries are inserted in time order.
      const oldest = memory.keys().next().value;
      memory.delete(oldest);
    }
    const hits = memory.get(ipHash) || [];
    hits.push(now());
    memory.set(ipHash, hits);
  }

  async function storageCall(label, work) {
    try {
      return await withTimeout(work(), storeTimeoutMs, label);
    } catch (error) {
      console.error(`contact: storage ${label} failed, continuing to email`, error?.message || error);
      return undefined;
    }
  }

  return async function handleContact(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { ok: false, message: "Method not allowed." });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(req, res, 400, { ok: false, message: "Could not read the form." });
    }

    const fields = {
      name: clean(body.name, LIMITS.name),
      email: clean(body.email, LIMITS.email).toLowerCase(),
      company: clean(body.company, LIMITS.company),
      message: clean(body.message, LIMITS.message),
    };

    // Bot traps. Respond as if successful so the bot learns nothing.
    const honeypot = clean(body.website, 200);
    if (honeypot || tooFast(body.t)) {
      return send(req, res, 200, { ok: true, message: successMessage() });
    }

    const missing = Object.entries(fields).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) {
      return send(req, res, 400, { ok: false, message: `Please fill in: ${missing.join(", ")}.` });
    }
    if (!EMAIL_PATTERN.test(fields.email)) {
      return send(req, res, 400, { ok: false, message: "Please enter a valid work email." });
    }

    const ipHash = hashIp(clientIp(req), env.IP_HASH_SECRET);
    if (recentInMemory(ipHash) >= maxPerHour) {
      return send(req, res, 429, { ok: false, message: "Too many messages from this connection. Please try again later." });
    }

    if (!env.RESEND_API_KEY || !env.LEAD_NOTIFY_TO) {
      console.error("contact: RESEND_API_KEY or LEAD_NOTIFY_TO is not set");
      return send(req, res, 503, { ok: false, message: "The contact form is unavailable right now. Please reach us on LinkedIn." });
    }

    let leadId = null;
    const store = await storageCall("connect", () => Promise.resolve(getStore()));
    if (store) {
      const recent = await storageCall("countRecent", () => store.countRecent(ipHash));
      if (typeof recent === "number" && recent >= maxPerHour) {
        return send(req, res, 429, { ok: false, message: "Too many messages from this connection. Please try again later." });
      }
      const inserted = await storageCall("insertLead", () =>
        store.insertLead({
          ...fields,
          source: clean(body.source, 40) || "soldenai.com",
          ip_hash: ipHash,
          user_agent: clean(req.headers?.["user-agent"], 400),
        })
      );
      if (inserted !== undefined && inserted !== null) leadId = inserted;
    }

    const sent = await sendEmail(fetchImpl, env, fields, leadId);
    if (!sent.ok) {
      console.error("contact: email failed", sent.error);
      return send(req, res, 502, { ok: false, message: "Your message could not be sent. Please try again in a few minutes." });
    }

    recordInMemory(ipHash);
    return send(req, res, 200, { ok: true, message: successMessage() });
  };
}

export function parseMaxPerHour(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_PER_HOUR;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`contact: CONTACT_MAX_PER_IP_PER_HOUR=${JSON.stringify(raw)} is not a positive number, using ${DEFAULT_MAX_PER_HOUR}`);
  return DEFAULT_MAX_PER_HOUR;
}

// `t` is elapsed milliseconds since the page loaded. Only a finite value in
// [0, MIN_FILL_MS) counts as a bot. Anything absent or unparseable is allowed through.
function tooFast(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  const elapsed = Number(raw);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function successMessage() {
  return "Thanks. We will reply from a founder inbox within two business days.";
}

async function sendEmail(fetchImpl, env, fields, leadId) {
  const from = env.LEAD_NOTIFY_FROM || "Solden <leads@soldenai.com>";
  const text = [
    `Name: ${fields.name}`,
    `Email: ${fields.email}`,
    `Company: ${fields.company}`,
    leadId ? `Lead ID: ${leadId}` : null,
    "",
    fields.message,
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(6000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: env.LEAD_NOTIFY_TO.split(",").map((s) => s.trim()).filter(Boolean),
        reply_to: fields.email,
        subject: `Invite request: ${fields.company}`,
        text,
      }),
    });
    if (!response.ok) {
      return { ok: false, error: `Resend responded ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readBody(req) {
  // A framework body parser (Express, Vercel) may already have run.
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
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

// Express computes req.ip honouring its `trust proxy` setting, so it wins when present.
// On Vercel the platform sets x-real-ip and x-vercel-forwarded-for from the real
// connection; x-forwarded-for is the last resort because clients can inject it.
function clientIp(req) {
  if (typeof req.ip === "string" && req.ip) return req.ip;
  const headers = req.headers || {};
  for (const name of ["x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"]) {
    const value = headers[name];
    if (value) return String(value).split(",")[0].trim();
  }
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

// Where a plain form post goes back to on error: the referring page's path (same-origin,
// path only, so this can never redirect off-site) with the form anchor, or /about#contact.
function returnLocation(req, status) {
  const why = WHY_BY_STATUS[status] || "delivery";
  let pathname = "/about";
  const referer = req.headers?.referer || req.headers?.referrer;
  if (referer) {
    try {
      const candidate = new URL(String(referer), "http://localhost").pathname;
      if (/^\/[A-Za-z0-9\-/]*$/.test(candidate)) pathname = candidate;
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
