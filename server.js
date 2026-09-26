/**
 * Production server for soldenai.com.
 *
 * Two responsibilities:
 *   1. Serve the static marketing HTML/CSS/JS with strict CSP + HSTS.
 *   2. Receive contact-form submissions and write them to a small
 *      Postgres database dedicated to the landing site.
 *
 * The Solden product database is intentionally isolated from
 * this service, marketing leads have a different blast radius and
 * different ops model than production AP data.
 *
 * Required env:
 *   PORT         , Railway-supplied bind port (defaults to 8080 locally).
 *   DATABASE_URL , Postgres connection string. If absent, the form
 *                   endpoint returns 503 and logs a warning, but the
 *                   static site still serves cleanly.
 *   RESEND_API_KEY, authorizes the required internal lead email and
 *                   prospect confirmation email.
 *   LEAD_NOTIFY_TO, internal lead recipient and prospect reply-to address.
 *
 * Optional env:
 *   SLACK_WEBHOOK_URL, if set, fire a non-blocking Slack notification
 *                       when a lead lands. DB write is the source of
 *                       truth; Slack is human-visibility only.
 *   LEAD_NOTIFY_FROM  , Resend-verified sender. Defaults to
 *                       leads@soldenai.com.
 *   DB_SSL           , "true" to force TLS on the PG connection. Most
 *                       Railway internal connections don't need it; set
 *                       this only when pointing at an external PG that
 *                       requires SSL.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildInternalLeadEmail,
  buildProspectConfirmationEmail,
} from './email-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const STATIC_DIR = path.resolve(__dirname);
const DATABASE_URL = process.env.DATABASE_URL || '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const IS_PRODUCTION_LIKE =
  process.env.NODE_ENV === 'production' ||
  Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const DEV_CONTACT_FALLBACK =
  !DATABASE_URL &&
  !IS_PRODUCTION_LIKE &&
  process.env.DEV_CONTACT_FALLBACK !== 'false';
const DEV_LEADS_PATH =
  process.env.DEV_LEADS_PATH ||
  path.join(os.tmpdir(), 'soldenai-landing-leads.jsonl');
// Resend HTTP API for emailing new leads. The API key is the same
// Resend key used as the SMTP password for transactional email. From
// must be a Resend-verified sender on soldenai.com; To is where leads
// land. Both the internal lead email and prospect confirmation must be
// accepted by Resend before the form reports success.
const rawResendApiKey = String(process.env.RESEND_API_KEY || '');
const RESEND_API_KEY = rawResendApiKey.trim();
const RESEND_API_URL =
  process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const configurationErrors = [];
const EMAIL_FETCH_TIMEOUT_MS = parseBoundedInteger(
  'EMAIL_FETCH_TIMEOUT_MS',
  8_000,
  250,
  15_000
);
const EMAIL_LEASE_MS = EMAIL_FETCH_TIMEOUT_MS + 25_000;
const EMAIL_MAX_ATTEMPTS = parseBoundedInteger(
  'EMAIL_MAX_ATTEMPTS',
  6,
  1,
  20
);
const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_MAX_PER_IP = parseBoundedInteger(
  'CONTACT_MAX_PER_IP_PER_HOUR',
  5,
  1,
  100
);
const CONTACT_MAX_PER_EMAIL = parseBoundedInteger(
  'CONTACT_MAX_PER_EMAIL_PER_HOUR',
  3,
  1,
  50
);
const BLOCKED_EMAIL_DOMAINS = new Set(
  String(process.env.BLOCKED_EMAIL_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
);
const LEAD_NOTIFY_FROM = normalizeMailbox(
  process.env.LEAD_NOTIFY_FROM || 'leads@soldenai.com'
);
const LEAD_NOTIFY_TO = normalizeMailbox(process.env.LEAD_NOTIFY_TO || '');
if (process.env.LEAD_NOTIFY_FROM && !LEAD_NOTIFY_FROM) {
  configurationErrors.push('LEAD_NOTIFY_FROM is not one valid mailbox');
}
if (process.env.LEAD_NOTIFY_TO && !LEAD_NOTIFY_TO) {
  configurationErrors.push('LEAD_NOTIFY_TO is not one valid mailbox');
}
if (
  rawResendApiKey &&
  (RESEND_API_KEY.length < 10 || /\s/.test(RESEND_API_KEY))
) {
  configurationErrors.push('RESEND_API_KEY is malformed');
}
try {
  const resendUrl = new URL(RESEND_API_URL);
  if (IS_PRODUCTION_LIKE) {
    if (resendUrl.href !== 'https://api.resend.com/emails') {
      configurationErrors.push(
        'RESEND_API_URL must be the canonical Resend endpoint in production'
      );
    }
  } else if (!['http:', 'https:'].includes(resendUrl.protocol)) {
    configurationErrors.push('RESEND_API_URL must use HTTP or HTTPS');
  }
} catch {
  configurationErrors.push('RESEND_API_URL is invalid');
}
const devSubmissionStates = new Map();
const devRateEvents = new Map();

if (!isEmailConfigured()) {
  console.warn(
    '[startup] contact email delivery is not configured; valid submissions will be stored but cannot return success'
  );
}
if (configurationErrors.length) {
  console.error(
    '[startup] invalid contact configuration: ' +
      configurationErrors.join('; ')
  );
}

function parseBoundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    configurationErrors.push(
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
    return fallback;
  }
  return value;
}

function normalizeMailbox(value, blockedDomains = null) {
  const raw = String(value || '').trim();
  if (
    !raw ||
    raw.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    raw.includes(' ') ||
    (raw.match(/@/g) || []).length !== 1
  ) {
    return null;
  }
  const [localPart, domainPart] = raw.split('@');
  const domain = String(domainPart || '').toLowerCase();
  if (
    !localPart ||
    localPart.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart) ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !domain ||
    domain.length > 253 ||
    !domain.includes('.') ||
    !domain
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      ) ||
    blockedDomains?.has(domain)
  ) {
    return null;
  }
  return `${localPart}@${domain}`;
}

function isEmailConfigured() {
  return Boolean(
    RESEND_API_KEY &&
      LEAD_NOTIFY_FROM &&
      LEAD_NOTIFY_TO &&
      configurationErrors.length === 0
  );
}

export function normalizeContactEmail(value) {
  return normalizeMailbox(value, BLOCKED_EMAIL_DOMAINS);
}

function normalizeSubmissionId(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    candidate
  )
    ? candidate
    : null;
}

// The repository contains design studies, internal notes, deployment files,
// and server code beside the public site. Public delivery is therefore an
// exact allowlist, never a directory mount.
export const PUBLIC_PAGE_ROUTES = Object.freeze({
  '/': 'index.html',
  '/request-demo': 'request-demo.html',
  '/security': 'security.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
});

export const CANONICAL_PAGE_REDIRECTS = Object.freeze({
  '/index': '/',
  '/index.html': '/',
  '/request-demo.html': '/request-demo',
  '/security.html': '/security',
  '/privacy.html': '/privacy',
  '/terms.html': '/terms',
});

// These pages were once public, but their architecture-first catalogues no
// longer represent the customer-facing product. Keep old links useful while
// consolidating the story on the canonical homepage sections.
export const RETIRED_PAGE_REDIRECTS = Object.freeze({
  '/connectors': '/#product',
  '/connectors.html': '/#product',
  '/surfaces': '/#how-it-works',
  '/surfaces.html': '/#how-it-works',
});

function preserveQueryBeforeFragment(destination, originalUrl) {
  const queryIndex = String(originalUrl || '').indexOf('?');
  if (queryIndex < 0) return destination;
  const query = String(originalUrl).slice(queryIndex);
  const fragmentIndex = destination.indexOf('#');
  if (fragmentIndex < 0) return `${destination}${query}`;
  return `${destination.slice(0, fragmentIndex)}${query}${destination.slice(
    fragmentIndex
  )}`;
}

export const PUBLIC_ASSET_ROUTES = Object.freeze({
  '/solden-landing.css': 'solden-landing.css',
  '/assets/apple-touch-icon.png': 'assets/apple-touch-icon.png',
  '/assets/favicon-16x16.png': 'assets/favicon-16x16.png',
  '/assets/favicon-32x32.png': 'assets/favicon-32x32.png',
  '/assets/favicon.png': 'assets/favicon.png',
  '/assets/home.css': 'assets/home.css',
  '/assets/icons/solden-icon-database.svg':
    'assets/icons/solden-icon-database.svg',
  '/assets/icons/solden-icon-evidence.svg':
    'assets/icons/solden-icon-evidence.svg',
  '/assets/icons/solden-icon-files.svg': 'assets/icons/solden-icon-files.svg',
  '/assets/icons/solden-icon-journal.svg':
    'assets/icons/solden-icon-journal.svg',
  '/assets/icons/solden-icon-judgement.svg':
    'assets/icons/solden-icon-judgement.svg',
  '/assets/icons/solden-icon-linkedin.svg':
    'assets/icons/solden-icon-linkedin.svg',
  '/assets/icons/solden-icon-reconcile.svg':
    'assets/icons/solden-icon-reconcile.svg',
  '/assets/icons/solden-icon-search.svg': 'assets/icons/solden-icon-search.svg',
  '/assets/icons/solden-icon-shield.svg': 'assets/icons/solden-icon-shield.svg',
  '/assets/icons/solden-icon-target.svg': 'assets/icons/solden-icon-target.svg',
  '/assets/icons/solden-icon-verified.svg':
    'assets/icons/solden-icon-verified.svg',
  '/assets/icons/solden-icon-workflow.svg':
    'assets/icons/solden-icon-workflow.svg',
  '/assets/icons/solden-icon-x.svg': 'assets/icons/solden-icon-x.svg',
  '/assets/icons/solden-nav-accounts-payable.svg':
    'assets/icons/solden-nav-accounts-payable.svg',
  '/assets/icons/solden-nav-accounts-receivable.svg':
    'assets/icons/solden-nav-accounts-receivable.svg',
  '/assets/icons/solden-nav-audit-compliance.svg':
    'assets/icons/solden-nav-audit-compliance.svg',
  '/assets/icons/solden-nav-cash-treasury.svg':
    'assets/icons/solden-nav-cash-treasury.svg',
  '/assets/icons/solden-nav-close-systems.svg':
    'assets/icons/solden-nav-close-systems.svg',
  '/assets/icons/solden-nav-fpa-reporting.svg':
    'assets/icons/solden-nav-fpa-reporting.svg',
  '/assets/icons/solden-nav-team-capacity.svg':
    'assets/icons/solden-nav-team-capacity.svg',
  '/assets/media/solden-july-close.mp4':
    'assets/media/solden-july-close.mp4',
  '/assets/media/solden-july-close-start-1080.png':
    'assets/media/solden-july-close-start-1080.png',
  '/assets/media/solden-july-close-start.png':
    'assets/media/solden-july-close-start.png',
  '/assets/media/solden-july-close-verified-1080.png':
    'assets/media/solden-july-close-verified-1080.png',
  '/assets/media/solden-july-close-verified.png':
    'assets/media/solden-july-close-verified.png',
  '/assets/site-shell.css': 'assets/site-shell.css',
  '/assets/solden-lockup-white-212.png':
    'assets/solden-lockup-white-212.png',
  '/assets/solden-lockup-white.png': 'assets/solden-lockup-white.png',
  '/assets/solden-mark-44.png': 'assets/solden-mark-44.png',
  '/assets/solden-mark.png': 'assets/solden-mark.png',
  '/assets/fonts/solden-fonts.css': 'assets/fonts/solden-fonts.css',
  '/assets/fonts/InterVariable.woff2': 'assets/fonts/InterVariable.woff2',
  '/assets/fonts/GeistMono-Variable.woff2':
    'assets/fonts/GeistMono-Variable.woff2',
  '/assets/js/demo.js': 'assets/js/demo.js',
  '/assets/js/document-mode.js': 'assets/js/document-mode.js',
  '/assets/js/home.js': 'assets/js/home.js',
  '/assets/js/site-shell.js': 'assets/js/site-shell.js',
});

export function resolveContainedPublicFile(rootDirectory, relativePath) {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, relativePath);
  const lexicalRelative = path.relative(root, resolved);
  if (
    !lexicalRelative ||
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw new Error(`[startup] public file escapes static root: ${relativePath}`);
  }

  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(resolved);
  const realRelative = path.relative(realRoot, realFile);
  if (
    !realRelative ||
    realRelative === '..' ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error(`[startup] public file symlink escapes static root: ${relativePath}`);
  }
  const expectedRealFile = path.resolve(realRoot, lexicalRelative);
  if (realFile !== expectedRealFile) {
    throw new Error(`[startup] public file uses symlink indirection: ${relativePath}`);
  }
  return realFile;
}

function resolvePublicFile(relativePath) {
  return resolveContainedPublicFile(STATIC_DIR, relativePath);
}

function assertPublicFileManifest() {
  const publicFiles = new Set([
    ...Object.values(PUBLIC_PAGE_ROUTES),
    ...Object.values(PUBLIC_ASSET_ROUTES),
  ]);
  for (const relativePath of publicFiles) {
    const resolved = resolvePublicFile(relativePath);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`[startup] allowlisted public file not found: ${resolved}`);
    }
  }
}

assertPublicFileManifest();

// ── Postgres pool ─────────────────────────────────────────────
//
// Lazily connected, the static site stays up even if Postgres is
// down or unconfigured. The form endpoint surfaces a 503 in that case
// so the operator sees a clear error rather than silent data loss.
let pool = null;
let schemaReady = false;
let schemaError = null;
let schemaInitializationRunning = false;
let schemaRetryTimer = null;
let schemaRetryAttempt = 0;
if (DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  pool.on('error', (err) => {
    console.error('[pg] idle client error', err.message);
  });
} else {
  if (DEV_CONTACT_FALLBACK) {
    console.warn(
      `[startup] DATABASE_URL not set, contact submissions will be written to ${DEV_LEADS_PATH}`
    );
  } else {
    console.warn(
      '[startup] DATABASE_URL not set, contact submissions will be rejected with 503'
    );
  }
}

async function ensureSchema() {
  if (!pool) return;
  // Idempotent: safe to run on every boot. The marketing site has no
  // formal migration framework, the schema is small enough to keep
  // co-located with the code that uses it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id           BIGSERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      name         TEXT NOT NULL,
      email        TEXT NOT NULL,
      company      TEXT,
      role         TEXT,
      erp          TEXT,
      topic        TEXT,
      message      TEXT,
      source       TEXT NOT NULL DEFAULT 'soldenai.com',
      ip_hash      TEXT,
      user_agent   TEXT,
      submission_id UUID,
      request_fingerprint TEXT,
      internal_email_status TEXT NOT NULL DEFAULT 'pending',
      internal_email_provider_id TEXT,
      internal_email_attempts INTEGER NOT NULL DEFAULT 0,
      internal_email_error TEXT,
      prospect_email_status TEXT NOT NULL DEFAULT 'pending',
      prospect_email_provider_id TEXT,
      prospect_email_attempts INTEGER NOT NULL DEFAULT 0,
      prospect_email_error TEXT,
      email_last_attempt_at TIMESTAMPTZ,
      email_next_retry_at TIMESTAMPTZ,
      email_accepted_at TIMESTAMPTZ,
      email_lease_token UUID,
      email_lease_until TIMESTAMPTZ
    );
  `);
  await pool.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS submission_id UUID,
      ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
      ADD COLUMN IF NOT EXISTS internal_email_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS internal_email_provider_id TEXT,
      ADD COLUMN IF NOT EXISTS internal_email_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS internal_email_error TEXT,
      ADD COLUMN IF NOT EXISTS prospect_email_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS prospect_email_provider_id TEXT,
      ADD COLUMN IF NOT EXISTS prospect_email_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS prospect_email_error TEXT,
      ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email_next_retry_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email_accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email_lease_token UUID,
      ADD COLUMN IF NOT EXISTS email_lease_until TIMESTAMPTZ;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL CHECK (request_count > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_email_recovery_events (
      id BIGSERIAL PRIMARY KEY,
      recovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submission_id UUID NOT NULL,
      operator_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      prior_internal_status TEXT NOT NULL,
      prior_internal_attempts INTEGER NOT NULL,
      prior_internal_error TEXT,
      prior_internal_provider_id TEXT,
      prior_prospect_status TEXT NOT NULL,
      prior_prospect_attempts INTEGER NOT NULL,
      prior_prospect_error TEXT,
      prior_prospect_provider_id TEXT
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (lower(email));`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_submission_id
       ON leads (submission_id) WHERE submission_id IS NOT NULL;`
  );
  // Rows captured before submission idempotency existed must never be picked
  // up as new email work during the migration.
  await pool.query(
    `UPDATE leads SET
       internal_email_status = 'historical',
       prospect_email_status = 'historical'
     WHERE submission_id IS NULL
       AND internal_email_status = 'pending'
       AND prospect_email_status = 'pending';`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leads_email_retry_v3
       ON leads (email_next_retry_at)
       WHERE submission_id IS NOT NULL
         AND (
           internal_email_status NOT IN ('accepted', 'dead_letter')
           OR prospect_email_status NOT IN ('accepted', 'dead_letter')
         );`
  );
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
if (IS_PRODUCTION_LIKE) app.set('env', 'production');
// Railway is the sole public network path in production. Locally and in tests,
// forwarded headers are untrusted so a direct client cannot choose req.ip.
app.set('trust proxy', IS_PRODUCTION_LIKE ? 1 : false);
app.set('case sensitive routing', true);
app.set('strict routing', true);

// ── Security headers ─────────────────────────────────────────
//
// CSP rationale:
//   default-src 'self'          , start strict; explicit allow per directive
//   script-src 'self'            , no inline scripts (page JS is external in /assets/js)
//   style-src 'self' 'unsafe-inline'
//                                , a few inline style attrs on hero swatches
//   font-src 'self' data:        , Inter and Geist Mono self-hosted from /assets/fonts/
//   img-src 'self' data:
//   media-src 'self'            , the muted hero close film is self-hosted
//   connect-src 'self'           , fetch only same-origin (POST /api/contact)
//   form-action 'self'           , form posts only same-origin
//   frame-ancestors 'none'       , no clickjacking
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

app.use((req, res, next) => {
  if (req.secure) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Keep one canonical public origin. Railway also receives the www custom
// domain, while this redirect prevents duplicate URLs and preserves the full
// path and query string for existing links.
app.use((req, res, next) => {
  if (String(req.hostname || '').toLowerCase() !== 'www.soldenai.com') {
    return next();
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.redirect(
    308,
    `https://soldenai.com${String(req.originalUrl || req.url || '/')}`
  );
});

// Tight body limit, the form is short. Security headers are installed before
// parsing so rejected bodies receive the same bounded response policy as every
// other request.
app.use(express.json({ limit: '32kb' }));
app.use((error, _req, res, next) => {
  if (!error) return next();
  const status = Number(error.status || error.statusCode || 0);
  if (error.type === 'entity.too.large' || status === 413) {
    return res.status(413).json({ ok: false, error: 'payload_too_large' });
  }
  if (
    error.type === 'entity.parse.failed' ||
    (error instanceof SyntaxError && status === 400)
  ) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  console.error('[http] request body parsing failed', {
    type: String(error.type || 'unknown'),
    status: status || 500,
  });
  return res.status(500).json({ ok: false, error: 'server_error' });
});

// Reject non-canonical URL spellings before Express can normalize them into
// an allowlisted route. Query strings remain valid; only the raw path is
// constrained.
app.use((req, res, next) => {
  const rawPath = String(req.originalUrl || req.url || '').split('?', 1)[0];
  const segments = rawPath.split('/');
  if (
    !rawPath.startsWith('/') ||
    rawPath.includes('%') ||
    rawPath.includes('\\') ||
    rawPath.includes('\0') ||
    rawPath.includes('//') ||
    segments.includes('.') ||
    segments.includes('..')
  ) {
    return sendNotFound(res);
  }
  return next();
});

// ── Healthcheck ──────────────────────────────────────────────
//
// Reports DB reachability so a misconfigured deploy is visible in
// Railway's healthcheck panel, not just at form-submit time.
app.get('/healthz', async (_req, res) => {
  // Liveness is about the web server, not the leads DB. The static
  // marketing site stays up even when Postgres is unreachable; only
  // contact-form submissions degrade (they 503 at submit time). So
  // /healthz always returns 200 when the server is running and just
  // REPORTS db reachability for visibility. Gating the healthcheck on
  // the DB previously took the whole site down whenever the leads
  // Postgres was down.
  const out = {
    ok: true,
    service: 'soldenai-landing',
    db: DEV_CONTACT_FALLBACK ? 'dev-file' : 'unconfigured',
    email: isEmailConfigured() ? 'configured' : 'unconfigured',
  };
  if (pool) {
    try {
      await pool.query('SELECT 1');
      out.db = 'ok';
    } catch (err) {
      out.db = 'down';
      console.warn('[health] database probe failed:', err.message);
    }
  }
  res.status(200).json(out);
});

// Readiness is stricter than liveness: the site may stay online while a
// dependency is degraded, but Railway should not promote a release that cannot
// durably capture a request and send both required emails.
app.get('/readyz', async (_req, res) => {
  const out = {
    ok: false,
    service: 'soldenai-landing',
    storage: DEV_CONTACT_FALLBACK ? 'dev-file' : 'unconfigured',
    email: isEmailConfigured() ? 'configured' : 'unconfigured',
  };
  if (configurationErrors.length) out.configuration = 'invalid';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      out.storage = schemaReady ? 'ok' : 'initializing';
    } catch (err) {
      out.storage = 'down';
      console.warn('[ready] database probe failed:', err.message);
    }
  }
  out.ok =
    (out.storage === 'ok' || out.storage === 'dev-file') &&
    out.email === 'configured';
  return res.status(out.ok ? 200 : 503).json(out);
});

// ── Contact form ─────────────────────────────────────────────
//
// Fields match the markup in request-demo.html. Honeypot field is named
// `company_website`; bots fill it because the label says so, real
// users never see it (CSS off-screen). Honeypot trips to silent 200,
// no DB write, no Slack notify.
app.post('/api/contact', async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot, return 200 so bots don't get useful signal.
    if (body.company_website && String(body.company_website).trim() !== '') {
      return res.json({ ok: true });
    }

    // Strictly accept one mailbox and one client-stable UUID. The UUID makes a
    // browser retry the same submission instead of creating another lead or
    // another pair of emails after a lost response.
    const name = String(body.name || '').trim();
    const email = normalizeContactEmail(body.email);
    const submissionId = normalizeSubmissionId(body.submission_id);
    if (
      !name ||
      name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(name)
    ) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }
    if (!email) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!submissionId) {
      return res.status(400).json({ ok: false, error: 'invalid_submission_id' });
    }

    // Hash the IP so we have an abuse signal without retaining PII
    // directly. Sixteen bytes is plenty to spot the same source.
    // Express derives req.ip from the one trusted Railway proxy hop. Never
    // trust a client-selected X-Forwarded-For value directly.
    const ip = String(req.ip || '');
    const ipHash = ip
      ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32)
      : null;

    const trimOrNull = (v, max) => {
      const s = String(v || '').trim();
      return s ? s.slice(0, max) : null;
    };
    for (const field of ['company', 'role', 'erp', 'topic']) {
      if (/[\u0000-\u001f\u007f]/.test(String(body[field] || ''))) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_field',
          field,
        });
      }
    }
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        String(body.message || '')
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_field',
        field: 'message',
      });
    }

    const leadInput = {
      submission_id: submissionId,
      name: name.slice(0, 200),
      email,
      company: trimOrNull(body.company, 200),
      role: trimOrNull(body.role, 200),
      erp: trimOrNull(body.erp, 60),
      topic: trimOrNull(body.topic, 60),
      message: trimOrNull(body.message, 5000),
      source: 'soldenai.com',
      ip_hash: ipHash,
      user_agent: trimOrNull(req.headers['user-agent'], 500),
    };
    leadInput.request_fingerprint = canonicalLeadFingerprint(leadInput);

    if (!pool) {
      if (!DEV_CONTACT_FALLBACK) {
        console.warn('[contact] DATABASE_URL missing, dropping submission');
        return res.status(503).json({ ok: false, error: 'no_storage' });
      }
      return await handleDevContact(leadInput, res);
    }
    return await handleDatabaseContact(leadInput, res);
  } catch (err) {
    console.error('[contact] processing failed', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

function newDeliveryState() {
  return {
    internal: { status: 'pending', providerId: null, attempts: 0, error: null },
    prospect: { status: 'pending', providerId: null, attempts: 0, error: null },
    nextRetryAt: null,
    acceptedAt: null,
  };
}

function isDeliveryAccepted(state) {
  return (
    state.internal.status === 'accepted' &&
    state.prospect.status === 'accepted'
  );
}

function isDeliveryTerminal(state) {
  return hasDeadLetter(state) && !hasRetryableDeliveryWork(state);
}

function hasDeadLetter(state) {
  return ['internal', 'prospect'].some(
    (channel) => state[channel].status === 'dead_letter'
  );
}

function hasRetryableDeliveryWork(state) {
  return ['internal', 'prospect'].some(
    (channel) =>
      state[channel].status !== 'accepted' &&
      state[channel].status !== 'dead_letter'
  );
}

function isRetryDue(state) {
  if (!state.nextRetryAt) return true;
  const retryAt = new Date(state.nextRetryAt).getTime();
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

export function canonicalLeadFingerprint(lead) {
  const canonical = {
    name: String(lead.name || ''),
    email: String(lead.email || '').toLowerCase(),
    company: lead.company || null,
    role: lead.role || null,
    erp: lead.erp || null,
    topic: lead.topic || null,
    message: lead.message || null,
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function deliveryStateFromRow(row) {
  return {
    internal: {
      status: row.internal_email_status || 'pending',
      providerId: row.internal_email_provider_id || null,
      attempts: Number(row.internal_email_attempts || 0),
      error: row.internal_email_error || null,
    },
    prospect: {
      status: row.prospect_email_status || 'pending',
      providerId: row.prospect_email_provider_id || null,
      attempts: Number(row.prospect_email_attempts || 0),
      error: row.prospect_email_error || null,
    },
    nextRetryAt: row.email_next_retry_at || null,
    acceptedAt: row.email_accepted_at || null,
  };
}

function rowToLead(row) {
  return {
    id: row.id,
    submission_id: String(row.submission_id),
    name: row.name,
    email: row.email,
    company: row.company,
    role: row.role,
    erp: row.erp,
    topic: row.topic,
    message: row.message,
    request_fingerprint:
      row.request_fingerprint || canonicalLeadFingerprint(row),
  };
}

function rateLimitResponse(res) {
  res.setHeader('Retry-After', '3600');
  return res.status(429).json({ ok: false, error: 'rate_limited' });
}

function checkDevRateLimit(ipHash, email) {
  const now = Date.now();
  const checks = [
    [`ip:${ipHash || 'unknown'}`, CONTACT_MAX_PER_IP],
    [`email:${email.toLowerCase()}`, CONTACT_MAX_PER_EMAIL],
  ];
  for (const [key, limit] of checks) {
    const recent = (devRateEvents.get(key) || []).filter(
      (timestamp) => now - timestamp < CONTACT_RATE_WINDOW_MS
    );
    devRateEvents.set(key, recent);
    if (recent.length >= limit) return false;
  }
  for (const [key] of checks) devRateEvents.get(key).push(now);
  return true;
}

function databaseRateLimitKey(kind, value) {
  return crypto
    .createHash('sha256')
    .update(`${kind}:${value || 'unknown'}`)
    .digest('hex');
}

async function reserveDatabaseRateLimit(client, ipHash, email) {
  // Sort keys so concurrent transactions always lock counter rows in the same
  // order. The counter increment and lead insertion share one transaction, so
  // rejected or duplicate submissions do not consume quota.
  const checks = [
    {
      key: databaseRateLimitKey('ip', ipHash),
      limit: CONTACT_MAX_PER_IP,
    },
    {
      key: databaseRateLimitKey('email', email.toLowerCase()),
      limit: CONTACT_MAX_PER_EMAIL,
    },
  ].sort((left, right) => left.key.localeCompare(right.key));

  for (const check of checks) {
    const result = await client.query(
      `INSERT INTO contact_rate_limits (
         key_hash, window_started_at, request_count, updated_at
       ) VALUES ($1, now(), 1, now())
       ON CONFLICT (key_hash) DO UPDATE SET
         request_count = CASE
           WHEN contact_rate_limits.window_started_at <= now() - interval '1 hour'
           THEN 1 ELSE contact_rate_limits.request_count + 1 END,
         window_started_at = CASE
           WHEN contact_rate_limits.window_started_at <= now() - interval '1 hour'
           THEN now() ELSE contact_rate_limits.window_started_at END,
         updated_at = now()
       RETURNING request_count`,
      [check.key]
    );
    if (Number(result.rows[0]?.request_count || 0) > check.limit) return false;
  }
  return true;
}

async function handleDevContact(leadInput, res) {
  let entry = devSubmissionStates.get(leadInput.submission_id);
  if (entry) {
    if (entry.lead.request_fingerprint !== leadInput.request_fingerprint) {
      return res.status(409).json({ ok: false, error: 'submission_conflict' });
    }
  } else {
    if (!checkDevRateLimit(leadInput.ip_hash, leadInput.email)) {
      return rateLimitResponse(res);
    }
    const lead = {
      ...leadInput,
      id: `dev-${leadInput.submission_id.slice(0, 8)}`,
      created_at: new Date().toISOString(),
    };
    entry = { lead, delivery: newDeliveryState() };
    devSubmissionStates.set(lead.submission_id, entry);
    await fs.promises.mkdir(path.dirname(DEV_LEADS_PATH), { recursive: true });
    await fs.promises.appendFile(
      DEV_LEADS_PATH,
      JSON.stringify(lead) + '\n',
      'utf8'
    );
    console.log(`[contact] dev lead stored (${lead.email}) -> ${DEV_LEADS_PATH}`);
  }

  entry.delivery = await deliverRequiredEmails(
    entry.lead,
    entry.delivery,
    async () => {}
  );
  return sendDeliveryOutcome(res, entry.lead, entry.delivery, {
    dev: true,
    automatic_retry: false,
  });
}

async function handleDatabaseContact(leadInput, res) {
  let existing = await pool.query(
    `SELECT * FROM leads WHERE submission_id = $1`,
    [leadInput.submission_id]
  );
  let row = existing.rows[0];
  if (row) {
    const rowFingerprint =
      row.request_fingerprint || canonicalLeadFingerprint(row);
    if (rowFingerprint !== leadInput.request_fingerprint) {
      return res.status(409).json({ ok: false, error: 'submission_conflict' });
    }
    if (!row.request_fingerprint) {
      await pool.query(
        `UPDATE leads SET request_fingerprint = $2
         WHERE id = $1 AND request_fingerprint IS NULL`,
        [row.id, rowFingerprint]
      );
      row.request_fingerprint = rowFingerprint;
    }
  }

  let newlyStored = false;
  if (!row) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO leads (
          submission_id, request_fingerprint, name, email, company, role,
          erp, topic, message, ip_hash, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (submission_id) WHERE submission_id IS NOT NULL DO NOTHING
        RETURNING *`,
        [
          leadInput.submission_id,
          leadInput.request_fingerprint,
          leadInput.name,
          leadInput.email,
          leadInput.company,
          leadInput.role,
          leadInput.erp,
          leadInput.topic,
          leadInput.message,
          leadInput.ip_hash,
          leadInput.user_agent,
        ]
      );
      row = inserted.rows[0];
      if (row) {
        if (
          !(await reserveDatabaseRateLimit(
            client,
            leadInput.ip_hash,
            leadInput.email
          ))
        ) {
          await client.query('ROLLBACK');
          return rateLimitResponse(res);
        }
        await client.query('COMMIT');
        newlyStored = true;
      } else {
        // A concurrent replay won the UUID insert. Roll back this request's
        // rate reservations and resolve the persisted request below.
        await client.query('ROLLBACK');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (!row) {
      existing = await pool.query(
        `SELECT * FROM leads WHERE submission_id = $1`,
        [leadInput.submission_id]
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error('lead insert conflict could not be resolved');
    const rowFingerprint =
      row.request_fingerprint || canonicalLeadFingerprint(row);
    if (rowFingerprint !== leadInput.request_fingerprint) {
      return res.status(409).json({ ok: false, error: 'submission_conflict' });
    }
    if (newlyStored) console.log(`[contact] lead #${row.id} stored (${row.email})`);
  }

  if (newlyStored) {
    notifySlack(rowToLead(row)).catch((err) =>
      console.warn('[contact] slack notify failed:', err.message)
    );
  }

  const lead = rowToLead(row);
  const currentDelivery = deliveryStateFromRow(row);
  if (isDeliveryAccepted(currentDelivery)) {
    return sendDeliveryOutcome(res, lead, currentDelivery);
  }
  if (isDeliveryTerminal(currentDelivery) || !isRetryDue(currentDelivery)) {
    return sendDeliveryOutcome(res, lead, currentDelivery);
  }
  const claim = await claimDatabaseEmailDelivery(lead.id);
  if (!claim) {
    const refreshed = await pool.query(`SELECT * FROM leads WHERE id = $1`, [
      lead.id,
    ]);
    return sendDeliveryOutcome(
      res,
      lead,
      deliveryStateFromRow(refreshed.rows[0] || row),
      { delivery_in_progress: true }
    );
  }
  const delivery = await deliverRequiredEmails(
    lead,
    deliveryStateFromRow(claim.row),
    (nextState) =>
      persistDatabaseDeliveryState(lead.id, claim.token, nextState)
  );
  return sendDeliveryOutcome(res, lead, delivery);
}

async function claimDatabaseEmailDelivery(leadId) {
  const token = crypto.randomUUID();
  const result = await pool.query(
    `UPDATE leads SET
       email_lease_token = $2,
       email_lease_until = now() + ($3 * interval '1 millisecond')
     WHERE id = $1
       AND (email_lease_until IS NULL OR email_lease_until <= now())
       AND (email_next_retry_at IS NULL OR email_next_retry_at <= now())
       AND (
         internal_email_status NOT IN ('accepted', 'dead_letter')
         OR prospect_email_status NOT IN ('accepted', 'dead_letter')
       )
     RETURNING *`,
    [leadId, token, EMAIL_LEASE_MS]
  );
  return result.rows[0] ? { token, row: result.rows[0] } : null;
}

async function persistDatabaseDeliveryState(leadId, leaseToken, state) {
  const result = await pool.query(
    `UPDATE leads SET
       internal_email_status = CASE
         WHEN internal_email_status IN ('accepted', 'dead_letter')
         THEN internal_email_status
         ELSE $3 END,
       internal_email_provider_id = CASE
         WHEN internal_email_status = 'accepted' THEN internal_email_provider_id
         ELSE COALESCE($4, internal_email_provider_id) END,
       internal_email_attempts = GREATEST(internal_email_attempts, $5),
       internal_email_error = CASE
         WHEN internal_email_status = 'accepted' OR $3 = 'accepted' THEN NULL
         WHEN internal_email_status = 'dead_letter' THEN internal_email_error
         ELSE $6 END,
       prospect_email_status = CASE
         WHEN prospect_email_status IN ('accepted', 'dead_letter')
         THEN prospect_email_status
         ELSE $7 END,
       prospect_email_provider_id = CASE
         WHEN prospect_email_status = 'accepted' THEN prospect_email_provider_id
         ELSE COALESCE($8, prospect_email_provider_id) END,
       prospect_email_attempts = GREATEST(prospect_email_attempts, $9),
       prospect_email_error = CASE
         WHEN prospect_email_status = 'accepted' OR $7 = 'accepted' THEN NULL
         WHEN prospect_email_status = 'dead_letter' THEN prospect_email_error
         ELSE $10 END,
       email_last_attempt_at = now(),
       email_next_retry_at = CASE
         WHEN (internal_email_status = 'accepted' OR $3 = 'accepted')
          AND (prospect_email_status = 'accepted' OR $7 = 'accepted')
         THEN NULL
         WHEN (internal_email_status IN ('accepted', 'dead_letter')
              OR $3 IN ('accepted', 'dead_letter'))
          AND (prospect_email_status IN ('accepted', 'dead_letter')
              OR $7 IN ('accepted', 'dead_letter'))
         THEN NULL
         ELSE $11::timestamptz END,
       email_accepted_at = CASE
         WHEN (internal_email_status = 'accepted' OR $3 = 'accepted')
          AND (prospect_email_status = 'accepted' OR $7 = 'accepted')
         THEN COALESCE(email_accepted_at, now())
         ELSE email_accepted_at END,
       email_lease_token = NULL,
       email_lease_until = NULL
     WHERE id = $1 AND email_lease_token = $2
     RETURNING *`,
    [
      leadId,
      leaseToken,
      state.internal.status,
      state.internal.providerId,
      state.internal.attempts,
      state.internal.error,
      state.prospect.status,
      state.prospect.providerId,
      state.prospect.attempts,
      state.prospect.error,
      state.nextRetryAt,
    ]
  );
  if (result.rows[0]) return deliveryStateFromRow(result.rows[0]);
  const refreshed = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  return refreshed.rows[0]
    ? deliveryStateFromRow(refreshed.rows[0])
    : state;
}

async function deliverRequiredEmails(lead, priorState, persistState) {
  const state = {
    internal: { ...priorState.internal },
    prospect: { ...priorState.prospect },
    nextRetryAt: priorState.nextRetryAt,
    acceptedAt: priorState.acceptedAt,
  };
  const work = [];
  for (const item of [
    { channel: 'internal', send: () => notifyEmail(lead) },
    { channel: 'prospect', send: () => notifyProspectEmail(lead) },
  ]) {
    const channelState = state[item.channel];
    if (channelState.status === 'accepted' || channelState.status === 'dead_letter') {
      continue;
    }
    if (channelState.attempts >= EMAIL_MAX_ATTEMPTS) {
      channelState.status = 'dead_letter';
      channelState.error = `delivery stopped after ${channelState.attempts} attempts`;
      continue;
    }
    work.push(item);
  }
  if (work.length === 0) {
    state.nextRetryAt = null;
    const persistedState = await persistState(state);
    return persistedState || state;
  }

  const results = await Promise.allSettled(work.map((item) => item.send()));
  let configurationMissing = false;
  let retryAfterMs = 0;
  for (let index = 0; index < work.length; index += 1) {
    const channel = work[index].channel;
    const result = results[index];
    if (result.status === 'fulfilled') {
      state[channel].attempts += 1;
      state[channel].status = 'accepted';
      state[channel].providerId = result.value || state[channel].providerId;
      state[channel].error = null;
    } else {
      const emailNotConfigured =
        result.reason?.code === 'email_not_configured';
      configurationMissing ||= emailNotConfigured;
      if (emailNotConfigured) {
        // No provider I/O occurred, so this does not consume an attempt. The
        // durable blocked state becomes retryable after configuration is fixed.
        state[channel].status = 'blocked';
        state[channel].error = String(
          result.reason?.message || result.reason
        ).slice(0, 500);
        continue;
      }
      state[channel].attempts += 1;
      retryAfterMs = Math.max(
        retryAfterMs,
        Number(result.reason?.retryAfterMs || 0)
      );
      const isTerminal =
        result.reason?.code === 'email_terminal' ||
        state[channel].attempts >= EMAIL_MAX_ATTEMPTS;
      state[channel].status = isTerminal
        ? 'dead_letter'
        : result.reason?.code === 'email_timeout' ||
            result.reason?.code === 'email_unknown'
          ? 'unknown'
          : 'failed';
      state[channel].error = String(result.reason?.message || result.reason).slice(
        0,
        500
      );
    }
  }
  const accepted =
    state.internal.status === 'accepted' &&
    state.prospect.status === 'accepted';
  state.acceptedAt = accepted ? new Date().toISOString() : null;
  const retryableWork = hasRetryableDeliveryWork(state);
  const exponentialBackoffMs = Math.min(
    60 * 60 * 1000,
    60 * 1000 *
      2 ** Math.max(state.internal.attempts, state.prospect.attempts, 1)
  );
  state.nextRetryAt =
    accepted || !retryableWork
      ? null
      : new Date(
          Date.now() + Math.max(exponentialBackoffMs, retryAfterMs)
        ).toISOString();
  state.configurationMissing = configurationMissing;
  const newlyDeadLettered = ['internal', 'prospect'].filter(
    (channel) =>
      priorState[channel].status !== 'dead_letter' &&
      state[channel].status === 'dead_letter'
  );
  if (newlyDeadLettered.length) {
    console.error(
      '[contact-alert] ' +
        JSON.stringify({
          event: 'required_email_dead_lettered',
          submission_id: lead.submission_id,
          channels: newlyDeadLettered,
          attempts: Object.fromEntries(
            newlyDeadLettered.map((channel) => [
              channel,
              state[channel].attempts,
            ])
          ),
          errors: Object.fromEntries(
            newlyDeadLettered.map((channel) => [
              channel,
              state[channel].error,
            ])
          ),
        })
    );
  }
  const persistedState = await persistState(state);
  if (persistedState) {
    persistedState.configurationMissing = configurationMissing;
    return persistedState;
  }
  return state;
}

function sendDeliveryOutcome(res, lead, state, extra = {}) {
  const accepted =
    state.internal.status === 'accepted' &&
    state.prospect.status === 'accepted';
  if (accepted) {
    console.log(`[contact] required emails accepted (${lead.email})`);
    return res.json({
      ok: true,
      ...extra,
      email: 'accepted',
      internal_email: 'accepted',
      prospect_email: 'accepted',
      submission_id: lead.submission_id,
    });
  }
  const terminal = hasDeadLetter(state);
  const configurationMissing =
    Boolean(state.configurationMissing) || !isEmailConfigured();
  const automaticRetry =
    extra.automatic_retry ??
    Boolean(
      !terminal &&
        !configurationMissing &&
        (state.nextRetryAt || extra.delivery_in_progress)
    );
  if (terminal) {
    console.error(
      `[contact] required email delivery dead-lettered (${lead.email}); ` +
        `internal=${state.internal.status}, prospect=${state.prospect.status}`
    );
  }
  return res
    .status(configurationMissing ? 503 : terminal ? 502 : 202)
    .json({
      ok: false,
      ...extra,
      error: configurationMissing
        ? 'email_not_configured'
        : terminal
          ? 'email_delivery_failed'
          : 'email_delivery_pending',
      request_received: true,
      email: terminal ? 'failed' : 'pending',
      internal_email: state.internal.status,
      prospect_email: state.prospect.status,
      automatic_retry: automaticRetry,
      submission_id: lead.submission_id,
    });
}

async function notifySlack(lead) {
  if (!SLACK_WEBHOOK_URL) return;
  const lines = [
    `:envelope_with_arrow: *New Solden lead* #${lead.id}`,
    `*${lead.name}*, ${lead.email}`,
    lead.company ? `Company: ${lead.company}` : null,
    lead.role ? `Role: ${lead.role}` : null,
    lead.erp ? `ERP: ${lead.erp}` : null,
    lead.topic ? `Topic: ${lead.topic}` : null,
    lead.message ? `> ${String(lead.message).slice(0, 500)}` : null,
  ].filter(Boolean);
  await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  });
}

async function notifyEmail(lead) {
  assertRequiredEmailConfiguration();
  const template = buildInternalLeadEmail(lead);
  return sendResendEmail(
    {
      from: `Solden Leads <${LEAD_NOTIFY_FROM}>`,
      to: [LEAD_NOTIFY_TO],
      reply_to: lead.email,
      ...template,
    },
    `contact-internal/${lead.submission_id}`
  );
}

async function notifyProspectEmail(lead) {
  assertRequiredEmailConfiguration();
  const template = buildProspectConfirmationEmail(lead, {
    replyTo: LEAD_NOTIFY_TO || LEAD_NOTIFY_FROM,
  });
  return sendResendEmail(
    {
      from: `Solden <${LEAD_NOTIFY_FROM}>`,
      to: [lead.email],
      reply_to: LEAD_NOTIFY_TO || LEAD_NOTIFY_FROM,
      ...template,
    },
    `contact-prospect/${lead.submission_id}`
  );
}

async function sendResendEmail(payload, idempotencyKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Keep the same deadline through response-body consumption. Headers alone
    // are not a complete provider result.
    const responseBody = await response.text();
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const providerError = new Error(
        `resend ${response.status}: ${responseBody.slice(0, 200)}`
      );
      providerError.code = retryable ? 'email_retryable' : 'email_terminal';
      if (retryable) {
        providerError.retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after')
        );
      }
      throw providerError;
    }
    let providerResponse;
    try {
      providerResponse = responseBody ? JSON.parse(responseBody) : {};
    } catch {
      const parseError = new Error(
        'resend accepted the request but returned an unreadable response'
      );
      parseError.code = 'email_unknown';
      throw parseError;
    }
    const providerId =
      typeof providerResponse.id === 'string'
        ? providerResponse.id.trim()
        : '';
    if (
      !providerId ||
      providerId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(providerId)
    ) {
      const unknownError = new Error(
        'resend accepted the request without returning a valid provider id'
      );
      unknownError.code = 'email_unknown';
      throw unknownError;
    }
    return providerId;
  } catch (error) {
    if (
      typeof error?.code === 'string' &&
      error.code.startsWith('email_')
    ) {
      throw error;
    }
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `resend request timed out after ${EMAIL_FETCH_TIMEOUT_MS}ms`
      );
      timeoutError.code = 'email_timeout';
      throw timeoutError;
    }
    const unknownError = new Error(
      `resend request outcome unknown: ${String(error?.message || error)}`
    );
    unknownError.code = 'email_unknown';
    throw unknownError;
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
  }
  const dateValue = Date.parse(raw);
  if (!Number.isFinite(dateValue)) return 0;
  return Math.min(
    Math.max(0, dateValue - Date.now()),
    24 * 60 * 60 * 1000
  );
}

function assertRequiredEmailConfiguration() {
  if (isEmailConfigured()) return;
  const error = new Error(
    'contact email delivery is not configured correctly'
  );
  error.code = 'email_not_configured';
  throw error;
}

let retrySweepRunning = false;
let retryTimer = null;

async function retryDueEmailDeliveries() {
  if (!pool || !isEmailConfigured() || retrySweepRunning) return;
  retrySweepRunning = true;
  try {
    const result = await pool.query(
      `SELECT * FROM leads
       WHERE (
           internal_email_status NOT IN ('accepted', 'dead_letter')
           OR prospect_email_status NOT IN ('accepted', 'dead_letter')
         )
         AND submission_id IS NOT NULL
         AND (email_next_retry_at IS NULL OR email_next_retry_at <= now())
       ORDER BY COALESCE(email_next_retry_at, created_at) ASC
       LIMIT 20`
    );
    for (const row of result.rows) {
      const claim = await claimDatabaseEmailDelivery(row.id);
      if (!claim) continue;
      const lead = rowToLead(claim.row);
      await deliverRequiredEmails(
        lead,
        deliveryStateFromRow(claim.row),
        (nextState) =>
          persistDatabaseDeliveryState(lead.id, claim.token, nextState)
      );
    }
  } catch (error) {
    console.warn('[contact] email retry sweep failed:', error.message);
  } finally {
    retrySweepRunning = false;
  }
}

function startEmailRetryWorker() {
  if (!pool || !isEmailConfigured() || retryTimer) return;
  retryDueEmailDeliveries().catch((error) =>
    console.warn('[contact] initial email retry failed:', error.message)
  );
  retryTimer = setInterval(() => {
    retryDueEmailDeliveries().catch((error) =>
      console.warn('[contact] email retry failed:', error.message)
    );
  }, 60_000);
  retryTimer.unref?.();
}

function sendNotFound(res) {
  return res.status(404).type('html').send(
    '<!doctype html><title>Not found · Solden</title>' +
      '<p style="font-family:Inter,Helvetica Neue,Arial,sans-serif;padding:48px">' +
      'Not found. <a href="/">Back to home</a>.</p>'
  );
}

function sendPublicFile(res, next, relativePath, cacheControl) {
  res.setHeader('Cache-Control', cacheControl);
  return res.sendFile(
    resolvePublicFile(relativePath),
    { dotfiles: 'deny' },
    (error) => {
      if (!error) return;
      if (error.status === 404 && !res.headersSent) return sendNotFound(res);
      return next(error);
    }
  );
}

// ── Exact public pages and assets ────────────────────────────
// GET registrations also provide Express's automatic HEAD handling. No other
// file in this directory is reachable through the marketing server.
for (const [routePath, destination] of Object.entries(RETIRED_PAGE_REDIRECTS)) {
  app.get(routePath, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.redirect(
      308,
      preserveQueryBeforeFragment(destination, req.originalUrl || req.url)
    );
  });
}

for (const [routePath, destination] of Object.entries(
  CANONICAL_PAGE_REDIRECTS
)) {
  app.get(routePath, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.redirect(
      308,
      preserveQueryBeforeFragment(destination, req.originalUrl || req.url)
    );
  });
}

for (const [routePath, relativePath] of Object.entries(PUBLIC_PAGE_ROUTES)) {
  app.get(routePath, (_req, res, next) =>
    sendPublicFile(res, next, relativePath, 'no-store, max-age=0')
  );
}

for (const [routePath, relativePath] of Object.entries(PUBLIC_ASSET_ROUTES)) {
  app.get(routePath, (_req, res, next) =>
    sendPublicFile(
      res,
      next,
      relativePath,
      'public, max-age=86400, stale-while-revalidate=604800'
    )
  );
}

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  return sendNotFound(res);
});

// ── Boot ─────────────────────────────────────────────────────
// Listen first so the static marketing site is always available.
// Schema bootstrap is best-effort: if the leads DB is unreachable
// (down, still booting, bad URL) the site still serves and contact
// submissions degrade to a 503 in /api/contact, rather than the
// whole site crash-looping. Gating boot on the leads DB previously
// took soldenai.com down whenever Postgres had any issue.
export function startServer(port = PORT) {
  const server = app.listen(port, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(
      `[startup] soldenai-landing listening on :${boundPort}, static=${STATIC_DIR}`
    );
  });
  scheduleSchemaInitialization();
  return server;
}

function scheduleSchemaInitialization(delayMs = 0) {
  if (
    !pool ||
    schemaReady ||
    schemaInitializationRunning ||
    schemaRetryTimer
  ) {
    return;
  }
  schemaRetryTimer = setTimeout(async () => {
    schemaRetryTimer = null;
    if (schemaReady || schemaInitializationRunning) return;
    schemaInitializationRunning = true;
    try {
      await ensureSchema();
      schemaReady = true;
      schemaError = null;
      schemaRetryAttempt = 0;
      console.log('[startup] schema ensured (landing contact tables)');
      startEmailRetryWorker();
    } catch (error) {
      schemaReady = false;
      schemaError = error.message;
      schemaRetryAttempt += 1;
      const nextDelayMs = Math.min(
        60_000,
        1_000 * 2 ** Math.min(schemaRetryAttempt - 1, 6)
      );
      console.error(
        `[startup] schema ensure failed; retrying in ${nextDelayMs}ms:`,
        error.message
      );
    } finally {
      schemaInitializationRunning = false;
      if (!schemaReady && !schemaRetryTimer) {
        const nextDelayMs = Math.min(
          60_000,
          1_000 * 2 ** Math.min(Math.max(schemaRetryAttempt - 1, 0), 6)
        );
        scheduleSchemaInitialization(nextDelayMs);
      }
    }
  }, delayMs);
  schemaRetryTimer.unref?.();
}

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}
