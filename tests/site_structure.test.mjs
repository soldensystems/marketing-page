// Structural integrity of the static site: anchors resolve, the head block and the shared
// chrome are identical on every page, the demo script's hooks exist in the markup, every
// shipped asset is used, and the content security policy holds. Language rules live in
// tests/site_language.test.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "public");
const pages = fs.readdirSync(root).filter((name) => name.endsWith(".html")).sort();
const routes = JSON.parse(fs.readFileSync(path.join(repo, "routes.json"), "utf8"));
const siteJs = fs.readFileSync(path.join(root, "assets", "site.js"), "utf8");
const siteCss = fs.readFileSync(path.join(root, "assets", "site.css"), "utf8");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function ids(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

// "/product#close" -> product.html, "/#invite" and "#invite" -> the page itself or index.html.
function pageFor(target, current) {
  const route = target.split("#")[0];
  if (route === "") return current;
  if (route === "/") return "index.html";
  return `${route.slice(1)}.html`;
}

const FOOTER_LINE = "The finance department becomes infrastructure. Always running, always proven.";
const CTA = "Request an invite";

// ------------------------------------------------------------------ Anchors

test("every fragment link resolves to an id in the target page", () => {
  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(/href="((?:\/[a-z0-9-]*)?#[^"]+)"/g)) {
      const target = match[1];
      const fragment = target.split("#")[1];
      const file = pageFor(target, page);
      assert.ok(fs.existsSync(path.join(root, file)), `${page} -> ${target}: ${file} does not exist`);
      assert.ok(ids(read(file)).has(fragment), `${page} -> ${target}: no id="${fragment}" in ${file}`);
    }
  }
});

test("every redirect destination with a fragment resolves to an id in the target page", () => {
  for (const rule of routes.redirects || []) {
    if (rule.has || !rule.destination.includes("#")) continue;
    const [route, fragment] = rule.destination.split("#");
    const file = route === "/" ? "index.html" : `${route.slice(1)}.html`;
    assert.ok(fs.existsSync(path.join(root, file)), `${rule.source} -> ${rule.destination}: ${file} does not exist`);
    assert.ok(ids(read(file)).has(fragment), `${rule.source} -> ${rule.destination}: no id="${fragment}" in ${file}`);
  }
});

test("the retired routes redirect permanently and nothing links to a careers page", () => {
  const rules = new Map((routes.redirects || []).filter((r) => !r.has).map((r) => [r.source, r]));
  for (const source of ["/request-demo", "/security", "/careers"]) {
    const rule = rules.get(source);
    assert.ok(rule, `${source} has a redirect`);
    assert.equal(rule.permanent, true, `${source} redirects permanently`);
  }
  for (const page of pages) {
    assert.doesNotMatch(read(page), /href="\/careers/, `${page}: links to a careers page`);
  }
});

// ------------------------------------------------------------------ Head parity

// The parts of <head> and the script tags that must be identical on all eight pages.
// Cache tokens (?v=) are stripped so a bump on one page cannot hide a real drift.
function sharedHead(html) {
  const head = html.slice(0, html.indexOf("</head>"));
  const picks = [
    /<meta name="viewport"[^>]*>/g,
    /<meta name="color-scheme"[^>]*>/g,
    /<meta name="theme-color"[^>]*>/g,
    /<meta property="og:(?:type|site_name|image|image:width|image:height|image:type|image:alt)"[^>]*>/g,
    /<meta name="twitter:card"[^>]*>/g,
    /<link rel="icon"[^>]*>/g,
    /<link rel="apple-touch-icon"[^>]*>/g,
    /<link rel="preload"[^>]*>/g,
    /<link rel="stylesheet"[^>]*>/g,
  ];
  const tags = picks.flatMap((re) => head.match(re) || []);
  const scripts = html.match(/<script[^>]*src="[^"]+"[^>]*>/g) || [];
  return [...tags, ...scripts].map((t) => t.replace(/\?v=[^"]+/, "")).sort();
}

test("icons, theme-color, viewport, social image and scripts are identical on every page", () => {
  const reference = sharedHead(read("index.html"));
  assert.ok(reference.some((t) => t.startsWith('<link rel="apple-touch-icon"')), "index.html declares an apple-touch-icon");
  assert.ok(reference.some((t) => t.includes("/assets/site.js")), "index.html loads site.js");
  for (const page of pages) {
    assert.deepEqual(sharedHead(read(page)), reference, `${page}: shared head block differs from index.html`);
  }
});

const SCRIPT_HOSTS = ["https://cloud.umami.is/"]; // the analytics script; everything else is same-origin
test("every script tag is deferred and served from the site or the analytics host", () => {
  for (const page of pages) {
    for (const tag of read(page).match(/<script[^>]*src="[^"]+"[^>]*>/g) || []) {
      assert.match(tag, /\sdefer\b/, `${page}: ${tag} is not deferred`);
      const src = tag.match(/src="([^"]+)"/)[1];
      assert.ok(src.startsWith("/") || SCRIPT_HOSTS.some((h) => src.startsWith(h)), `${page}: ${tag} is not an allowed origin`);
    }
  }
});

test("the analytics host is allowed by the content security policy", () => {
  const csp = routes.headers.flatMap((r) => r.headers).find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /script-src [^;]*https:\/\/cloud\.umami\.is/);
  assert.match(csp, /connect-src [^;]*https:\/\/cloud\.umami\.is/);
  assert.match(csp, /connect-src [^;]*https:\/\/gateway\.umami\.is/, "Umami posts events to gateway.umami.is");
});

// ------------------------------------------------------------------ Shared chrome

test("the footer line and the header CTA are on every page", () => {
  for (const page of pages) {
    const html = read(page);
    const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    assert.ok(footer.includes(`<p>${FOOTER_LINE}</p>`), `${page}: footer line "${FOOTER_LINE}"`);
    assert.match(html, new RegExp(`<a class="btn btn-small" href="[^"]+" data-cta="header">${CTA}</a>`), `${page}: header CTA "${CTA}"`);
  }
});

test("every tracked CTA reads exactly Request an invite", () => {
  for (const page of pages) {
    for (const match of read(page).matchAll(/<(a|button)\b[^>]*\sdata-cta="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) {
      assert.equal(match[3].trim(), CTA, `${page}: data-cta="${match[2]}" reads "${match[3].trim()}"`);
    }
  }
});

// ------------------------------------------------------------------ Forms

test("every invite form carries the required fields, the honeypot, the timer and a status region", () => {
  for (const page of ["index.html", "about.html", "how-it-works.html"]) {
    const html = read(page);
    const forms = html.match(/<form[\s\S]*?<\/form>/g) || [];
    assert.equal(forms.length, 1, `${page}: exactly one form`);
    const form = forms[0];
    assert.match(form, /<form class="form" method="post" action="\/api\/contact" data-contact-form data-source="[a-z-]+">/, `${page}: form posts to /api/contact with a source`);
    const names = [...form.matchAll(/<(?:input|textarea)[^>]*name="([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(names, ["company", "email", "message", "name", "t", "website"], `${page}: form fields`);
    for (const name of ["name", "email", "company", "message"]) {
      assert.match(form, new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*\\srequired\\b`), `${page}: ${name} is required`);
    }
    assert.match(form, /name="email" type="email"/, `${page}: email field is type=email`);
    assert.match(form, /<div class="field field-hp" aria-hidden="true"><label for="website">[^<]+<\/label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off" \/>/, `${page}: honeypot, hidden from assistive technology`);
    assert.match(form, /<input type="hidden" name="t" value="" \/>/, `${page}: fill-time field`);
    assert.match(form, /<div class="form-status" data-form-status role="status" aria-live="polite"><\/div>/, `${page}: status region, rendered empty so it is announced`);
    assert.match(form, new RegExp(`<button class="btn btn-light" type="submit" data-cta="contact-submit">${CTA}</button>`), `${page}: submit button`);
    for (const id of ["name", "email", "company", "message"]) {
      assert.match(form, new RegExp(`<label for="${id}">`), `${page}: label for ${id}`);
    }
  }
});

// ------------------------------------------------------------------ Script hooks

test("every data-* hook site.js queries exists in index.html", () => {
  const html = read("index.html");
  const hooks = new Set([...siteJs.matchAll(/\[data-([a-z-]+)(?:="[^"]*")?\]/g)].map((m) => m[1]));
  for (const hook of hooks) {
    assert.match(html, new RegExp(`\\sdata-${hook}(?:[\\s=>/])`), `index.html: no data-${hook} for site.js hook [data-${hook}]`);
  }
  for (const match of siteJs.matchAll(/\[data-row="([a-z]+)"\]|"(bank|ic|acc|rev|flux|fs|lock)"/g)) {
    const key = match[1] || match[2];
    assert.ok(html.includes(`data-row="${key}"`), `index.html: no data-row="${key}" for the demo`);
  }
  for (const match of siteJs.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids(html).has(match[1]), `index.html: no id="${match[1]}" for getElementById`);
  }
  assert.ok(html.includes("data-contact-form") && read("about.html").includes("data-contact-form"), "both forms are hooked");
  assert.doesNotMatch(html, /data-demo-pause/, "the demo has no pause control, by decision");
});

test("every progress class the demo can emit has a rule in site.css", () => {
  // Replay the demo's count changes in source order: reset() runs first, then T[] in sequence.
  const counts = { done: 0, review: 0, call: 0 };
  const emitted = new Set();
  const body = siteJs.slice(siteJs.indexOf("function reset()"));
  for (const m of body.matchAll(/counts = \{([^}]*)\}|counts\.(done|review|call)\s*=\s*(\d+)|\bkey\(\);/g)) {
    if (m[0].startsWith("counts = {")) {
      for (const [, k, v] of m[1].matchAll(/(done|review|call):\s*(\d+)/g)) counts[k] = Number(v);
    } else if (m[2]) {
      counts[m[2]] = Number(m[3]);
    } else {
      emitted.add(`p-${counts.done}-${counts.review}-${counts.call}`);
    }
  }
  assert.ok(emitted.size >= 8, `the demo emits progress classes (${[...emitted].join(", ")})`);
  const rules = new Set([...siteCss.matchAll(/\.progress-bar\.(p-\d+-\d+-\d+)/g)].map((m) => m[1]));
  for (const cls of emitted) {
    if (cls === "p-0-0-0") continue; // the empty bar is the base state: no segment has flex, the track fills
    assert.ok(rules.has(cls), `site.css has no .progress-bar.${cls} rule`);
  }
});

test("site state is driven by classes and data attributes, never inline styles", () => {
  assert.doesNotMatch(siteJs, /\.style\b|setAttribute\(\s*["']style["']/, "site.js writes inline styles");
  assert.doesNotMatch(siteJs, /innerHTML\s*=\s*[^;]*style=/, "site.js injects inline styles");
  assert.doesNotMatch(siteJs, /<script/, "site.js injects scripts");
  for (const page of pages) {
    const html = read(page);
    assert.doesNotMatch(html, /\sstyle="/, `${page}: inline style attribute`);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")[^>]*>/, `${page}: executable inline script`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${page}: inline event handler`);
  }
});

// ------------------------------------------------------------------ Assets

function referencedAssets() {
  const sources = [
    ...pages.map((p) => read(p)),
    siteCss,
    siteJs,
    fs.readFileSync(path.join(root, "sitemap.xml"), "utf8"),
    fs.readFileSync(path.join(repo, "lib", "email.js"), "utf8"), // the emails load the full-size lockup
  ].join("\n");
  return new Set([...sources.matchAll(/\/assets\/[a-zA-Z0-9_./-]+\.(?:svg|png|ico|webp|jpg|woff2|css|js)/g)].map((m) => m[0]));
}

test("every logo and every PNG under public/assets is referenced by a page, the stylesheet or the script", () => {
  const referenced = referencedAssets();
  const unused = [];
  const logos = path.join(root, "assets", "logos");
  for (const file of fs.readdirSync(logos).sort()) {
    if (file === "LICENSE.txt") continue; // the attribution file for the vendor marks ships beside them
    if (!referenced.has(`/assets/logos/${file}`)) unused.push(`public/assets/logos/${file}`);
  }
  for (const file of fs.readdirSync(path.join(root, "assets")).sort()) {
    if (!file.endsWith(".png")) continue;
    if (!referenced.has(`/assets/${file}`)) unused.push(`public/assets/${file}`);
  }
  assert.deepEqual(unused, [], `unreferenced assets ship to production: ${unused.join(", ")}. Wire each one in or delete it.`);
});

test("every asset a page, the stylesheet or the script references exists", () => {
  for (const ref of referencedAssets()) {
    assert.ok(fs.existsSync(path.join(root, ref)), `${ref} is referenced but missing`);
  }
  for (const page of pages) {
    for (const match of read(page).matchAll(/(?:src|href)="(\/favicon\.ico|\/robots\.txt|\/sitemap\.xml)"/g)) {
      assert.ok(fs.existsSync(path.join(root, match[1])), `${page}: ${match[1]} is missing`);
    }
  }
});

test("the cache token on every page is the hash of the stylesheet and the script (run npm run stamp)", async () => {
  const { assetToken } = await import("../scripts/stamp.mjs");
  const token = assetToken();
  for (const page of pages) {
    for (const match of read(page).matchAll(/\/assets\/site\.(?:css|js)\?v=([^"]+)"/g)) {
      assert.equal(match[1], token, `${page}: stale cache token ?v=${match[1]}, expected ${token}. Run npm run stamp.`);
    }
  }
});

test("every page names the company as UK law requires, and the legal pages give its registered office", () => {
  for (const page of pages) {
    const footer = read(page).slice(read(page).indexOf("<footer"));
    assert.match(footer, /Solden Systems Ltd\./, `${page}: registered name in the footer`);
    assert.match(footer, /Registered in England and Wales, company number(?: |&nbsp;)16823002/, `${page}: place of registration and number`);
  }
  for (const page of ["privacy.html", "terms.html"]) {
    assert.match(read(page), /Apartment 16 Apedale Road, Newcastle, England, ST5 6FF/, `${page}: registered office address`);
  }
});

// ------------------------------------------------------------------ Indexing

test("the sitemap lists exactly the indexable pages and noindex pages carry no canonical", () => {
  const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
  const listed = new Set([...sitemap.matchAll(/<loc>https:\/\/soldenai\.com(\/[a-z-]*)<\/loc>/g)].map((m) => m[1]));
  for (const page of pages) {
    const html = read(page);
    const route = page === "index.html" ? "/" : `/${page.replace(/\.html$/, "")}`;
    const noindex = /<meta name="robots" content="noindex"/.test(html);
    if (noindex) {
      assert.doesNotMatch(html, /<link rel="canonical"/, `${page}: noindex page carries a canonical`);
      assert.ok(!listed.has(route), `${page}: noindex page is in the sitemap`);
    } else {
      assert.match(html, new RegExp(`<link rel="canonical" href="https://soldenai\\.com${route === "/" ? "/" : route}"`), `${page}: canonical matches its route`);
      assert.ok(listed.has(route), `${page}: indexable page missing from the sitemap`);
    }
  }
});
