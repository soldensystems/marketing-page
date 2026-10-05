// Browser-like tests execute the shipped script with a small DOM and fake Turnstile/network.
// No external request, challenge, lead storage or email delivery is performed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(repo, "public/assets/site.js"), "utf8");
const pages = ["index.html", "about.html", "how-it-works.html"];
const htmlFor = (page) => fs.readFileSync(path.join(repo, "public", page), "utf8");
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const response = (ok = true, body = {}) => ({ ok, json: async () => body });

class Element {
  constructor() {
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.id = "";
    this.focused = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) {
    const event = { preventDefault() {}, target: this };
    return Promise.all((this.listeners.get(name) || []).map((callback) => callback(event)));
  }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
}

function formFor(page, width = 420) {
  const html = htmlFor(page).match(/<form[\s\S]*?<\/form>/)[0];
  const form = new Element();
  form.action = html.match(/action="([^"]+)"/)[1];
  form.dataset = { source: html.match(/data-source="([^"]+)"/)[1] };
  form.values = new Map([
    ["name", "A Test"], ["company", "Test Company"], ["email", "test@example.com"],
    ["message", "Two entities, ten business days."], ["website", ""], ["t", ""],
  ]);
  const inputs = new Map([...form.values.keys()].map((key) => [key, new Element()]));
  form.elements = { namedItem: (name) => inputs.get(name) };
  form.status = new Element();
  form.submit = new Element();
  form.submit.disabled = /type="submit"[^>]*\bdisabled/.test(html);
  form.widget = new Element();
  form.widget.clientWidth = width;
  form.verification = new Element();
  form.retry = new Element();
  form.retry.hidden = true;
  form.done = new Element();
  form.done.hidden = true;
  const selectors = {
    "[data-form-status]": form.status,
    'button[type="submit"]': form.submit,
    "[data-turnstile]": form.widget,
    "[data-verification-status]": form.verification,
    "[data-verification-retry]": form.retry,
  };
  form.querySelector = (selector) => selectors[selector] || null;
  form.parentElement = { querySelector: (selector) => selector === "[data-form-done]" ? form.done : null };
  form.resetCount = 0;
  form.reset = () => { form.resetCount++; form.dispatch("reset"); };
  return form;
}

async function browser(options = {}) {
  const forms = (options.pages || ["index.html"]).map((page) => formFor(page, options.width));
  const calls = [];
  const scripts = [];
  const widgets = [];
  const timerMap = new Map();
  let nextTimer = 0;
  let now = 100000;
  let configCalls = 0;
  let posts = 0;
  const api = {
    ready(callback) {
      if (options.readyThrows) throw new Error("Readiness unavailable");
      if (!options.readyHangs) callback();
    },
    render(element, config) {
      if (options.renderThrows) throw new Error("Render unavailable");
      const widget = { element, config, id: `widget-${widgets.length}`, resets: 0 };
      widgets.push(widget);
      return widget.id;
    },
    remove(id) {
      const widget = widgets.find((item) => item.id === id);
      if (widget) widget.removed = true;
    },
    reset(id) {
      const widget = widgets.find((item) => item.id === id);
      if (!widget) throw new Error("Unknown widget");
      widget.resets++;
      if (options.resetThrows) throw new Error("Reset unavailable");
      if (options.tokenOnReset) widget.config.callback(`fresh-${widget.resets}`);
    },
  };
  const document = new Element();
  document.documentElement = new Element();
  document.querySelectorAll = (selector) => selector === "[data-contact-form]" ? forms : [];
  document.querySelector = () => null; // No hero animation needed for contact coverage.
  document.createElement = () => new Element();
  document.head = {
    appendChild(element) {
      scripts.push(element);
      queueMicrotask(() => {
        if (options.scriptFails) element.onerror?.();
        else if (!options.scriptHangs) { window.turnstile = api; element.onload?.(); }
      });
    },
  };
  const window = { location: { search: options.search || "" } };
  class TestDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    document, window, URLSearchParams, AbortController, Date: TestDate,
    FormData: class { constructor(form) { this.data = form.values; } entries() { return this.data.entries(); } },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timerMap.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timerMap.delete(id); },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === "/api/contact-config") {
        configCalls++;
        if (options.configFetch) return options.configFetch(configCalls, init);
        return response(true, { siteKey: "public-test-key", action: "contact" });
      }
      posts++;
      return options.postFetch ? options.postFetch(posts, init) : response(true, { message: "Sent." });
    },
  });
  vm.runInContext(script, context, { filename: "site.js" });
  await flush();
  return {
    forms, calls, scripts, widgets, options, api,
    posts: () => calls.filter((call) => call.init.method === "POST"),
    solve(index = 0, token = "verified-token") { widgets[index].config.callback(token); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timerMap.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timerMap.delete(due[0]);
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
    timers: timerMap,
  };
}

test("all three forms start disabled and include explicit email/no-JS alternatives", () => {
  for (const page of pages) {
    const html = htmlFor(page);
    const form = html.match(/<form[\s\S]*?<\/form>/)[0];
    assert.match(form, /action="\/api\/contact"/);
    assert.match(form, /type="submit"[^>]*\bdisabled/);
    assert.match(form, /data-turnstile/);
    assert.match(form, /data-verification-status role="status" aria-live="polite"/);
    assert.match(form, /type="button" data-verification-retry hidden/);
    assert.match(form, /<p class="form-alternative">[^<]*<a href="mailto:hello@soldenai.com"/);
    assert.match(form, /<noscript>[\s\S]*JavaScript[\s\S]*href="mailto:hello@soldenai.com"[\s\S]*<\/noscript>/);
    assert.doesNotMatch(form, /turnstile.*(?:secret|sitekey)=/i);
    assert.doesNotMatch(form, /formaction=/);
  }
});

test("CSP permits only the required Cloudflare script/frame origin and keeps existing restrictions", () => {
  const routes = JSON.parse(fs.readFileSync(path.join(repo, "routes.json"), "utf8"));
  const csp = routes.headers.flatMap((route) => route.headers).find((header) => header.key === "Content-Security-Policy").value;
  const directives = new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get("script-src"), ["'self'", "https://cloud.umami.is", "https://challenges.cloudflare.com"]);
  assert.deepEqual(directives.get("frame-src"), ["https://challenges.cloudflare.com"]);
  assert.deepEqual(directives.get("style-src"), ["'self'"]);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
});

test("one config request and explicit script initialise independent contact widgets on all forms", async () => {
  const b = await browser({ pages });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, "/api/contact-config");
  assert.equal(b.calls[0].init.cache, "no-store");
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  assert.equal(b.scripts[0].async, true);
  assert.equal(b.widgets.length, 3);
  for (const [index, form] of b.forms.entries()) {
    const config = b.widgets[index].config;
    assert.equal(config.sitekey, "public-test-key");
    assert.equal(config.action, "contact");
    assert.equal(config["response-field"], false);
    assert.equal(config.tabindex, 0);
    assert.equal(config.size, "flexible");
    assert.equal(config["refresh-expired"], "auto");
    assert.equal(config["refresh-timeout"], "auto");
    assert.equal(form.submit.disabled, true);
    assert.equal(form.submit.getAttribute("aria-describedby"), form.verification.id);
  }
  b.solve(1, "about-only");
  assert.deepEqual(b.forms.map((form) => form.submit.disabled), [true, false, true]);
  assert.equal(b.posts().length, 0);
  assert.equal(b.timers.size, 0);
});

for (const page of pages) {
  test(`${page}: no request before verification; verified JSON preserves source, timer and success focus`, async () => {
    const b = await browser({ pages: [page] });
    const form = b.forms[0];
    await form.dispatch("submit");
    assert.equal(b.posts().length, 0);
    assert.match(form.status.textContent, /complete verification/);
    assert.equal(form.status.focused, true);
    b.solve();
    assert.equal(form.submit.disabled, false);
    await b.advance(2500);
    await form.dispatch("submit");
    const post = b.posts()[0];
    const data = JSON.parse(post.init.body);
    assert.equal(post.url, "/api/contact");
    assert.equal(data["cf-turnstile-response"], "verified-token");
    assert.equal(data.source, form.dataset.source);
    assert.equal(data.t, 2500);
    assert.equal(data.website, "");
    assert.equal(form.done.focused, true);
    assert.equal(form.done.hidden, false);
    assert.equal(form.hidden, true);
    assert.equal(form.resetCount, 1);
    assert.equal(form.submit.disabled, true);
    assert.equal(form.submit.getAttribute("aria-busy"), null);
    await form.dispatch("submit");
    assert.equal(b.posts().length, 1);
  });
}

test("repeated submissions and callbacks during delivery cannot send or reuse another token", async () => {
  let finish;
  const b = await browser({ postFetch: () => new Promise((resolve) => { finish = resolve; }) });
  const form = b.forms[0];
  b.solve();
  const first = form.dispatch("submit");
  assert.equal(form.submit.disabled, true);
  assert.equal(form.submit.getAttribute("aria-busy"), "true");
  await form.dispatch("submit");
  b.solve(0, "unexpected-token-during-submit");
  await form.dispatch("submit");
  assert.equal(b.posts().length, 1);
  finish(response(false, { message: "Not sent. Work email is required." }));
  await first;
  assert.equal(form.submit.disabled, true);
  assert.equal(form.elements.namedItem("email").getAttribute("aria-invalid"), "true");
  assert.equal(form.status.getAttribute("role"), "alert");
  assert.equal(form.status.focused, true);
  assert.equal(b.widgets[0].resets, 1);
  assert.equal(form.resetCount, 0, "failed delivery preserves user inputs");
  await form.dispatch("submit");
  assert.equal(b.posts().length, 1);
});

for (const [name, handler] of [
  ["validation", async () => response(false, { message: "Name is required." })],
  ["rate limit", async () => response(false, { message: "Too many requests." })],
  ["delivery", async () => response(false, { message: "Delivery failed." })],
  ["non-JSON response", async () => ({ ok: false, json: async () => { throw new Error("Invalid JSON"); } })],
  ["network", async () => { throw new Error("Offline"); }],
]) {
  test(`${name} failure resets verification; a retry needs a fresh token`, async () => {
    const b = await browser({ postFetch: (count) => count === 1 ? handler() : response() });
    const form = b.forms[0];
    b.solve(0, "first-token");
    await form.dispatch("submit");
    assert.equal(b.widgets[0].resets, 1);
    assert.equal(form.submit.disabled, true);
    assert.equal(form.hidden, false);
    assert.equal(form.done.hidden, true);
    await form.dispatch("submit");
    assert.equal(b.posts().length, 1);
    b.solve(0, "replacement-token");
    await form.dispatch("submit");
    assert.equal(b.posts().length, 2);
    assert.equal(JSON.parse(b.posts()[1].init.body)["cf-turnstile-response"], "replacement-token");
    assert.equal(form.done.hidden, false);
  });
}

test("a stalled POST times out, releases busy state, and requires a fresh challenge", async () => {
  const b = await browser({ postFetch: () => new Promise(() => {}) });
  const form = b.forms[0];
  b.solve();
  const pending = form.dispatch("submit");
  await b.advance(35000);
  await pending;
  assert.equal(b.posts()[0].init.signal.aborted, true);
  assert.match(form.status.textContent, /could not confirm delivery/);
  assert.match(form.status.textContent, /hello@soldenai.com/);
  assert.equal(form.submit.getAttribute("aria-busy"), null);
  assert.equal(form.submit.disabled, true);
  assert.equal(b.widgets[0].resets, 1);
});

for (const name of ["expired-callback", "error-callback", "timeout-callback", "unsupported-callback"]) {
  test(`${name} clears a previous token and keeps requests blocked`, async () => {
    const b = await browser();
    b.solve();
    b.widgets[0].config[name]();
    assert.equal(b.forms[0].submit.disabled, true);
    await b.forms[0].dispatch("submit");
    assert.equal(b.posts().length, 0);
    if (name !== "unsupported-callback") {
      assert.equal(b.forms[0].retry.hidden, false);
      await b.forms[0].retry.dispatch("click");
      assert.equal(b.widgets[0].resets, 1);
      b.solve(0, "retried-token");
      assert.equal(b.forms[0].submit.disabled, false);
    }
  });
}

test("tokens that age while a tab sleeps are refused even without an expiry callback", async () => {
  const b = await browser();
  b.solve();
  await b.advance(290000);
  await b.forms[0].dispatch("submit");
  assert.equal(b.posts().length, 0);
  assert.equal(b.widgets[0].resets, 1);
  assert.equal(b.forms[0].submit.disabled, true);
});

test("manual form reset invalidates verification", async () => {
  const b = await browser();
  b.solve();
  b.forms[0].reset();
  assert.equal(b.widgets[0].resets, 1);
  assert.equal(b.forms[0].submit.disabled, true);
});

test("fresh success during a synchronous widget reset is accepted after failed delivery", async () => {
  const b = await browser({ postFetch: async () => response(false), tokenOnReset: true });
  b.solve();
  await b.forms[0].dispatch("submit");
  assert.equal(b.forms[0].submit.disabled, false);
  assert.equal(b.widgets[0].resets, 1);
});

for (const [label, options] of [
  ["unconfigured", { configFetch: async () => response(false) }],
  ["empty site key", { configFetch: async () => response(true, { siteKey: "", action: "contact" }) }],
  ["wrong action", { configFetch: async () => response(true, { siteKey: "key", action: "login" }) }],
  ["script blocked", { scriptFails: true }],
  ["render error", { renderThrows: true }],
  ["script readiness error", { readyThrows: true }],
]) {
  test(`${label} shows an email fallback and leaves submit disabled`, async () => {
    const b = await browser(options);
    const form = b.forms[0];
    assert.equal(form.submit.disabled, true);
    assert.match(form.verification.textContent, /hello@soldenai.com/);
    assert.equal(form.retry.hidden, false);
    assert.equal(form.retry.disabled, false);
    await form.dispatch("submit");
    assert.equal(b.posts().length, 0);
  });
}

for (const [label, options] of [
  ["configuration request", { configFetch: () => new Promise(() => {}) }],
  ["script request", { scriptHangs: true }],
  ["script readiness", { readyHangs: true }],
]) {
  test(`stalled ${label} times out with an email fallback and retry`, async () => {
    const b = await browser(options);
    await b.advance(10000);
    const form = b.forms[0];
    assert.match(form.verification.textContent, /hello@soldenai.com/);
    assert.equal(form.submit.disabled, true);
    assert.equal(form.retry.hidden, false);
    assert.equal(form.retry.disabled, false);
    assert.equal(b.timers.size, 0);
    if (b.scripts.length) assert.equal(b.scripts[0].removed, true);
  });
}

test("retry can recover from missing config without losing form input", async () => {
  const b = await browser({ configFetch: async (count) => count === 1 ? response(false) : response(true, { siteKey: "new-key", action: "contact" }) });
  const form = b.forms[0];
  await form.retry.dispatch("click");
  await flush();
  assert.equal(b.widgets.length, 1);
  assert.equal(b.widgets[0].config.sitekey, "new-key");
  assert.equal(form.resetCount, 0);
  b.solve();
  assert.equal(form.submit.disabled, false);
});

test("retry recovers from a blocked script and repeated clicks share one in-flight load", async () => {
  const options = { scriptFails: true };
  const b = await browser(options);
  options.scriptFails = false;
  const form = b.forms[0];
  await form.retry.dispatch("click");
  await form.retry.dispatch("click");
  await flush();
  assert.equal(b.scripts.length, 2);
  assert.equal(b.widgets.length, 1);
  b.solve();
  assert.equal(form.retry.hidden, true);
  assert.equal(form.submit.disabled, false);
});

test("narrow phone layout uses a compact keyboard-accessible widget", async () => {
  const b = await browser({ width: 224 });
  assert.equal(b.widgets[0].config.size, "compact");
  assert.equal(b.widgets[0].config.tabindex, 0);
});

test("pages without contact forms never request config or Cloudflare", async () => {
  const b = await browser({ pages: [] });
  assert.equal(b.calls.length, 0);
  assert.equal(b.scripts.length, 0);
});

test("an old plain-post verification redirect explains the failure without sending", async () => {
  const b = await browser({ search: "?sent=0&why=verification" });
  assert.match(b.forms[0].status.textContent, /complete verification/);
  assert.equal(b.posts().length, 0);
});


test("a failed widget reset can recover by rendering a replacement widget", async () => {
  const options = { resetThrows: true };
  const b = await browser(options);
  b.solve();
  b.widgets[0].config["error-callback"]();
  await b.forms[0].retry.dispatch("click");
  assert.equal(b.widgets[0].removed, true);
  assert.equal(b.forms[0].retry.hidden, false);
  options.resetThrows = false;
  await b.forms[0].retry.dispatch("click");
  await flush();
  assert.equal(b.widgets.length, 2);
  b.solve(1, "replacement-widget-token");
  assert.equal(b.forms[0].submit.disabled, false);
});
