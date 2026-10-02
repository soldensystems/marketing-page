// Enforces the marketing brief and the founder-locked language on every page.
// Mirrors tests/product_direction_contract.test.mjs in soldensystems/solden.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "public");
const pages = fs.readdirSync(root).filter((name) => name.endsWith(".html"));
const routes = JSON.parse(fs.readFileSync(path.join(repo, "routes.json"), "utf8"));
const redirectSources = new Set((routes.redirects || []).filter((r) => !r.has).map((r) => r.source));

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

const BANNED = [
  [/AI\s+finance\s+team/i, 'Solden is the AI finance department, never the "AI finance team"'],
  [/modern companies/i, '"growing companies", never "modern companies"'],
  [/—/, "no em-dashes"],
  [/launching soon|coming soon/i, "never promise timelines"],
  [/request a demo|book a demo|see it in action|watch the demo/i, "no demo language; the CTA is an invite"],
  [/\bper[- ]seat|\bper[- ]action|\bcredits\b|credit[- ]based|\bper[- ]credit/i, "outcomes pricing only"],
  [/\bagents? (?:that|who) (?:run|handle)|our agents\b/i, "agents are workers inside the department, never the product"],
  [/runs your (?:month-end )?close|built by operators|backed by y ?combinator/i, "Billow owns this device"],
  [/automate your|in your existing tools|learns how your team works|finishes the job|reduce workload|weeks to days|in minutes/i, "Billow's messaging pattern"],
  [/never do again|out of the loop|one set of books out|many systems in|operating layer|one accountable (?:service|function)|mcp server/i, "LAC's messaging pattern"],
  [/nothing touches the present|read before write|one path to your books|one department, function by function|start with a replay of your last close/i, "heading from the rejected draft"],
  [/delivered as software|rebuilt as software|\bSaaS\b/i, "Solden is a department delivered as a service"],
  [/soc 2 type ii certified|iso 27001|>certified<|>implemented</i, "never claim a certification the company does not hold"],
  [/customer-proven|on the roadmap|>Specified<|>Planned<|>Pre-build<|illustrative/i, "no apologetic copy: never announce what is missing or its build status"],
];

test("the home page shows the product frame", () => {
  const html = read("index.html");
  assert.ok(/class="frame"/.test(html), "the hero shows the product frame");
});

test("every page has exactly one h1, a title, a description and, unless noindex, a canonical", () => {
  for (const page of pages) {
    const html = read(page);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${page}: one h1`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page}: title`);
    assert.match(html, /<meta name="description" content="[^"]+"/, `${page}: description`);
    if (/<meta name="robots" content="noindex"/.test(html)) {
      assert.doesNotMatch(html, /<link rel="canonical"/, `${page}: a noindex page carries no canonical`);
    } else {
      assert.match(html, /<link rel="canonical"/, `${page}: canonical`);
    }
  }
});

test("the home page names Solden as the AI finance department", () => {
  assert.match(read("index.html"), /AI finance department/, "index.html");
});

// site.js writes copy into the page at runtime (the demo log, the form messages) and site.css
// carries generated text in content: strings, so both are scanned with the pages.
const scanned = [...pages, path.join("assets", "site.js"), path.join("assets", "site.css")];

test("banned language stays off every page, the script and the stylesheet", () => {
  for (const file of scanned) {
    const text = read(file);
    for (const [pattern, reason] of BANNED) {
      assert.doesNotMatch(text, pattern, `${file}: ${reason}`);
    }
  }
});

test("no inline styles or inline scripts, so the content security policy holds", () => {
  for (const page of pages) {
    const html = read(page);
    assert.doesNotMatch(html, /\sstyle="/, `${page}: inline style attribute`);
    // Only executable inline scripts break the policy; application/ld+json is data, not code.
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")[^>]*>/, `${page}: inline script`);
  }
});

test("internal links resolve to a page, an asset or a redirect", () => {
  for (const page of pages) {
    const html = read(page);
    for (const match of html.matchAll(/href="(\/[^"#?]*)/g)) {
      const target = match[1];
      if (target === "/") continue;
      if (target.startsWith("/assets/") || target.startsWith("/api/") || /\.[a-z0-9]+$/i.test(target)) {
        assert.ok(fs.existsSync(path.join(root, target)), `${page} -> ${target}`);
        continue;
      }
      const ok = fs.existsSync(path.join(root, `${target}.html`)) || redirectSources.has(target);
      assert.ok(ok, `${page} -> ${target}`);
    }
  }
});

test("redirect destinations exist", () => {
  for (const rule of routes.redirects || []) {
    if (rule.has) continue;
    const target = rule.destination.split("#")[0];
    assert.ok(fs.existsSync(path.join(root, `${target}.html`)), `${rule.source} -> ${rule.destination}`);
  }
});

// A statistic is a percentage or an "N in ten" phrase in visible text. Each one must sit in the
// same block (paragraph, list item, cell, heading) as its source: a citation element, a numbered
// source marker, or a first-party sample the sentence names ("thirty conversations ... eight in ten").
const STATISTIC = /\d+(?:\.\d+)?\s?%|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}) in (?:ten|10)\b/i;
const SOURCE = /<sup\b|<cite\b|class="idx"|class="sources"|\b(?:conversations|interviews|respondents|surveyed|according to|source:)\b/i;

test("every statistic on every page carries a source in the same block", () => {
  for (const page of pages) {
    const html = read(page)
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<svg[\s\S]*?<\/svg>/g, ""); // attribute percentages inside diagrams are geometry, not claims
    const blocks = html.split(/<\/(?:p|li|td|th|dd|dt|h[1-6]|figcaption)>/);
    for (const block of blocks) {
      const text = block.replace(/<[^>]+>/g, " ");
      const hit = text.match(STATISTIC);
      if (!hit) continue;
      assert.match(block, SOURCE, `${page}: statistic "${hit[0]}" has no source in its block: ${text.trim().slice(0, 120)}`);
    }
  }
});

test("every invite form asks only for name, work email, company and message", () => {
  for (const page of ["index.html", "about.html", "how-it-works.html"]) {
    const html = read(page);
    const names = [...html.matchAll(/<(?:input|textarea)[^>]*name="([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(names, ["company", "email", "message", "name", "t", "website"], page);
    assert.match(html, /<div class="form-status" data-form-status role="status" aria-live="polite">/, `${page}: status region, rendered from the start`);
    assert.match(html, /class="field field-hp"/, `${page}: honeypot`);
  }
});

test("retired CTA and apology lines stay off every page, the script and the stylesheet", () => {
  for (const file of scanned) {
    const text = read(file);
    assert.doesNotMatch(text, /design[- ]partner/i, `${file}: design partner language is retired`);
    assert.doesNotMatch(text, /pre-build|not yet held|we do not hold|now onboarding|\bnot yet\b|planned for|coming later/i, `${file}: no apologetic copy`);
    assert.doesNotMatch(text, /request a demo|book a demo/i, `${file}: the CTA is "Request an invite"`);
  }
});

test("a career page is never linked or offered", () => {
  for (const page of pages) {
    assert.doesNotMatch(read(page), /\bcareers?\b|we are hiring|join us/i, `${page}: no careers page or hiring copy`);
  }
});
