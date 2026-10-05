// The site's server. Production runs this on Railway (`npm start`); the same file is the local
// preview. It serves public/ with clean URLs and no trailing slashes (308 redirects), applies the
// redirects and headers from routes.json, hosts the contact handler, blocks dotfiles, and serves
// the 404 page.

import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import contact from "./api/contact.js";
import { contactConfiguration, TURNSTILE_ACTION } from "./lib/contact.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, "public");
const routes = JSON.parse(await readFile(path.join(root, "routes.json"), "utf8"));
const port = Number(process.env.PORT || 8080);

const app = express();
app.disable("x-powered-by");
// Behind Railway's edge proxy the visitor's address arrives in X-Forwarded-For, so trust one hop
// there (the contact handler's rate limit reads req.ip). Elsewhere it is off unless TRUST_PROXY
// is set (e.g. "1" or "loopback"), so a client cannot spoof its address.
const trustProxy = process.env.TRUST_PROXY ? parseTrustProxy(process.env.TRUST_PROXY) : process.env.RAILWAY_ENVIRONMENT ? 1 : false;
app.set("trust proxy", trustProxy);

// Health check for the platform. Answers before any redirect or header rule.
app.get("/healthz", (_req, res) => res.type("text/plain").set("Cache-Control", "no-store").send("ok"));

// Nothing under a dot-directory or dotfile is ever served (.git, .env, .gstack).
app.use((req, res, next) => {
  if (req.path.split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) {
    return notFound(res);
  }
  next();
});

// Apply each header rule only to the paths its `source` pattern matches, in order,
// so later rules override earlier ones.
for (const rule of routes.headers || []) {
  const pattern = sourceToRegExp(rule.source);
  app.use((req, res, next) => {
    if (pattern.test(req.path)) {
      for (const { key, value } of rule.headers) res.setHeader(key, value);
    }
    next();
  });
}

// Host rules first (www to the apex), then path redirects.
for (const rule of routes.redirects || []) {
  if (!rule.has) continue;
  const host = rule.has.find((h) => h.type === "host")?.value;
  if (!host) continue;
  app.use((req, res, next) => {
    if (req.hostname !== host) return next();
    const target = rule.destination.replace("$1", req.originalUrl.replace(/^\//, ""));
    res.redirect(rule.permanent ? 308 : 307, target);
  });
}
for (const rule of routes.redirects || []) {
  if (rule.has) continue;
  app.get(rule.source, (_req, res) => res.redirect(rule.permanent ? 308 : 307, rule.destination));
}

// cleanUrls + trailingSlash:false. /x.html -> /x, /index.html -> /, /x/ -> /x.
// Every redirect stays on this site: leading slashes and backslashes collapse to one "/", so a path
// such as //evil.example/ can never become a protocol-relative Location that leaves soldenai.com.
function localPath(p) {
  return "/" + String(p).replace(/^[\\/]+/, "");
}
app.get(/^\/(.*)\.html$/, (req, res) => {
  const clean = req.params[0] === "index" ? "/" : localPath(req.params[0]);
  res.redirect(308, clean + queryString(req));
});
app.get(/^\/(.+)\/$/, (req, res) => {
  res.redirect(308, localPath(req.params[0]) + queryString(req));
});

app.use("/api", express.json({ limit: "32kb" }));
app.use("/api", express.urlencoded({ extended: false, limit: "32kb" }));
// Only the public widget key is exposed. Never return the secret or request-derived hosts.
app.get("/api/contact-config", (_req, res) => {
  const configuration = contactConfiguration(process.env);
  res.set("Cache-Control", "no-store");
  if (!configuration) return res.status(503).json({ ok: false, message: "Please email hello@soldenai.com." });
  return res.json({ siteKey: configuration.siteKey, action: TURNSTILE_ACTION });
});
app.all("/api/contact", (req, res, next) => {
  Promise.resolve(contact(req, res)).catch(next);
});
// A malformed or oversized body must answer with plain JSON, never an Express error page.
app.use("/api", (error, _req, res, _next) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).set("Cache-Control", "no-store").json({ ok: false, message: "Could not read the form. Please email hello@soldenai.com." });
});
app.all(/^\/api(\/|$)/, (_req, res) => res.status(404).set("Cache-Control", "no-store").json({ ok: false, message: "Not found." }));

app.use(express.static(site, { extensions: ["html"], index: "index.html", dotfiles: "ignore", redirect: false }));
app.use((_req, res) => notFound(res));

app.listen(port, () => {
  console.log(`soldenai.com on http://localhost:${port}`);
});

function notFound(res) {
  res.status(404).sendFile(path.join(site, "404.html"));
}

function queryString(req) {
  const index = req.originalUrl.indexOf("?");
  return index === -1 ? "" : req.originalUrl.slice(index);
}

// Route `source` patterns are path-to-regexp style. This site only uses literal paths and (.*).
function sourceToRegExp(source) {
  const escaped = source
    .split("(.*)")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function parseTrustProxy(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}
