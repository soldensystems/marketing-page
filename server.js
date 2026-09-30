// Local preview server. Mirrors Vercel's behaviour closely enough to QA the site:
// clean URLs and no trailing slashes (308 redirects), the redirects and headers from
// vercel.json, the contact function, dotfile blocking, and the 404 page.
// Production runs on Vercel; this file is for `npm start` on a laptop or any Node host.

import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import contact from "./api/contact.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, "public");
const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
const port = Number(process.env.PORT || 8080);

const app = express();
app.disable("x-powered-by");
// Off by default so a client cannot spoof its address through X-Forwarded-For; the contact
// handler reads req.ip. Behind a known reverse proxy set TRUST_PROXY (e.g. "1" or "loopback").
app.set("trust proxy", process.env.TRUST_PROXY ? parseTrustProxy(process.env.TRUST_PROXY) : false);

// Nothing under a dot-directory or dotfile is ever served (.git, .env, .gstack, .vercel).
app.use((req, res, next) => {
  if (req.path.split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) {
    return notFound(res);
  }
  next();
});

// Apply each header rule only to the paths its `source` pattern matches, in order,
// so later rules override earlier ones exactly as Vercel does.
for (const rule of vercel.headers || []) {
  const pattern = sourceToRegExp(rule.source);
  app.use((req, res, next) => {
    if (pattern.test(req.path)) {
      for (const { key, value } of rule.headers) res.setHeader(key, value);
    }
    next();
  });
}

for (const rule of vercel.redirects || []) {
  if (rule.has) continue; // host-based rules are Vercel-only
  app.get(rule.source, (_req, res) => res.redirect(rule.permanent ? 308 : 307, rule.destination));
}

// cleanUrls + trailingSlash:false. /x.html -> /x, /index.html -> /, /x/ -> /x.
app.get(/^\/(.*)\.html$/, (req, res) => {
  const clean = req.params[0] === "index" ? "/" : `/${req.params[0]}`;
  res.redirect(308, clean + queryString(req));
});
app.get(/^\/(.+)\/$/, (req, res) => {
  res.redirect(308, `/${req.params[0]}` + queryString(req));
});

// Vercel Web Analytics only exists on Vercel. Serve an empty script locally so consoles stay clean.
app.get("/_vercel/insights/script.js", (_req, res) => res.type("application/javascript").send(""));

app.use("/api", express.json({ limit: "32kb" }));
app.use("/api", express.urlencoded({ extended: false, limit: "32kb" }));
app.all("/api/contact", (req, res) => contact(req, res));
// A malformed or oversized body must answer with plain JSON, never an Express error page.
app.use("/api", (error, _req, res, _next) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).set("Cache-Control", "no-store").json({ ok: false, message: "Could not read the form." });
});
app.all(/^\/api(\/|$)/, (_req, res) => res.status(404).set("Cache-Control", "no-store").json({ ok: false, message: "Not found." }));

app.use(express.static(site, { extensions: ["html"], index: "index.html", dotfiles: "ignore", redirect: false }));
app.use((_req, res) => notFound(res));

app.listen(port, () => {
  console.log(`soldenai.com preview on http://localhost:${port}`);
});

function notFound(res) {
  res.status(404).sendFile(path.join(site, "404.html"));
}

function queryString(req) {
  const index = req.originalUrl.indexOf("?");
  return index === -1 ? "" : req.originalUrl.slice(index);
}

// Vercel `source` patterns use path-to-regexp. This site only uses literal paths and (.*).
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
