// Page content works without this file. Protected contact requests need JavaScript; email is always available.
// The mobile menu is a <details> element and needs no script; this file only adds closing on Escape, on a click
// outside it and on choosing one of its links.

const loadedAt = Date.now();

document.documentElement.classList.add("js");

// Analytics: Umami (cookieless) when its script is present; nothing otherwise.
function track(name, data) {
  if (window.umami && typeof window.umami.track === "function") {
    window.umami.track(name, data);
  }
}

for (const el of document.querySelectorAll("[data-cta]")) {
  el.addEventListener("click", () => track("cta_click", { cta: el.dataset.cta }));
}

// Mobile menu: close an open <details class="nav-menu"> on Escape (returning focus to its summary) and on click outside.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.nav-menu[open]")) {
    menu.open = false;
    const summary = menu.querySelector("summary");
    if (summary) summary.focus();
  }
});
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.nav-menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
// An in-page link (Request an invite) would otherwise leave the menu open over the section it scrolled to.
for (const link of document.querySelectorAll("details.nav-menu nav a")) {
  link.addEventListener("click", () => {
    const menu = link.closest("details");
    if (menu) menu.open = false;
  });
}

// Reveal sections as they enter the viewport. Respects reduced-motion through CSS.
const reveals = document.querySelectorAll(".reveal");
if (reveals.length && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.08 }
  );
  for (const el of reveals) io.observe(el);
} else {
  for (const el of reveals) el.classList.add("in");
}

// Contact protection loads once, only on pages with an invite form. The public config contains no secret.
// Both network operations are bounded so a blocked script or unavailable endpoint has an email fallback.
async function contactJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }).then(async (response) => ({
        response,
        body: await response.json().catch(() => ({})),
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Contact request timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let turnstileLoad;
let turnstileLoadAttempt = 0;
function loadTurnstile() {
  if (turnstileLoad) return turnstileLoad;
  turnstileLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const callbackName = `soldenTurnstileLoaded${++turnstileLoadAttempt}`;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      delete window[callbackName];
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve(window.turnstile);
      }
    };
    const timer = setTimeout(() => finish(new Error("Verification script timed out")), 10000);
    // Cloudflare rejects ready() for an async/defer script. Its named onload
    // callback signals API readiness, independently of the script element's load event.
    // Use a different name per retry so a late old callback cannot settle a new load.
    window[callbackName] = () => {
      if (settled) return;
      if (!window.turnstile || typeof window.turnstile.render !== "function") {
        finish(new Error("Verification script unavailable"));
        return;
      }
      finish();
    };
    script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${callbackName}`;
    script.async = true;
    script.onerror = () => finish(new Error("Verification script blocked"));
    document.head.appendChild(script);
  }).catch((error) => {
    turnstileLoad = null; // A deliberate retry can recover from a blocked or interrupted load.
    throw error;
  });
  return turnstileLoad;
}

let contactProtection;
function loadContactProtection() {
  if (contactProtection) return contactProtection;
  contactProtection = (async () => {
    const { response, body } = await contactJson("/api/contact-config", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok || typeof body.siteKey !== "string" || !body.siteKey.trim() || body.action !== "contact") {
      throw new Error("Contact protection unavailable");
    }
    const api = await loadTurnstile();
    return { api, siteKey: body.siteKey, action: body.action };
  })().catch((error) => {
    contactProtection = null;
    throw error;
  });
  return contactProtection;
}

// Each form owns its token and widget. The server must independently verify every token.
for (const [index, form] of [...document.querySelectorAll("[data-contact-form]")].entries()) {
  const status = form.querySelector("[data-form-status]");
  const submit = form.querySelector('button[type="submit"]');
  const widget = form.querySelector("[data-turnstile]");
  const verificationStatus = form.querySelector("[data-verification-status]");
  const retry = form.querySelector("[data-verification-retry]");
  const done = form.parentElement && form.parentElement.querySelector("[data-form-done]");
  let sending = false;
  let completed = false;
  let initialising = false;
  let protection;
  let widgetId = null;
  let token = "";
  let tokenExpiresAt = 0;

  const FALLBACK_FAILURE = "Not sent. Please try again in a few minutes, or email hello@soldenai.com.";
  const VERIFICATION_FAILURE = "Verification is unavailable. Please retry verification, or email hello@soldenai.com.";

  // Live regions exist in the original markup, before their first announcement.
  if (status && !status.id) status.id = `form-status-${index}`;
  if (verificationStatus) {
    verificationStatus.id = `verification-status-${index}`;
    if (submit) submit.setAttribute("aria-describedby", verificationStatus.id);
  }
  const fields = [
    ["name", "Name"],
    ["company", "Company"],
    ["email", "Work email"],
    ["message", "How your close runs today"],
  ];
  function markInvalid(message) {
    for (const [name, label] of fields) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      const named = message.includes(label) || (name === "email" && /work email/i.test(message) && !/^Please fill in/.test(message));
      if (named) {
        input.setAttribute("aria-invalid", "true");
        if (status) input.setAttribute("aria-describedby", status.id);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
  }

  function show(message, failed) {
    if (!status) return;
    status.setAttribute("role", failed ? "alert" : "status");
    status.textContent = message;
    if (failed) markInvalid(message);
  }

  function settle(message, failed) {
    show(message, failed);
    if (!status) return;
    status.setAttribute("tabindex", "-1");
    status.focus();
  }

  function updateSubmit() {
    if (submit) submit.disabled = sending || completed || !token;
    if (retry) retry.disabled = sending || initialising || completed;
  }

  function verification(message, canRetry = false) {
    if (verificationStatus) verificationStatus.textContent = message;
    if (retry) retry.hidden = !canRetry;
    updateSubmit();
  }

  function clearToken() {
    token = "";
    tokenExpiresAt = 0;
    updateSubmit();
  }

  function resetVerification() {
    clearToken();
    if (completed) return;
    verification("Please complete the verification below.");
    try {
      if (!protection || widgetId === null) throw new Error("Verification unavailable");
      protection.api.reset(widgetId);
    } catch {
      // A removed or broken widget needs a fresh render, rather than endless failed resets.
      try { protection?.api.remove(widgetId); } catch { /* The widget may already be gone. */ }
      widgetId = null;
      verification(VERIFICATION_FAILURE, true);
    }
  }

  async function initialiseVerification() {
    if (initialising || completed) return;
    initialising = true;
    clearToken();
    verification("Loading verification.");
    try {
      if (!widget) throw new Error("Verification container missing");
      protection = await loadContactProtection();
      verification("Please complete the verification below.");
      widgetId = protection.api.render(widget, {
        sitekey: protection.siteKey,
        action: protection.action,
        theme: "dark",
        // Flexible widgets have a 300px minimum; compact also fits small phone layouts.
        size: widget.clientWidth >= 300 ? "flexible" : "compact",
        tabindex: 0,
        "response-field": false, // Keep the token in memory and add it explicitly to JSON.
        retry: "auto",
        "refresh-expired": "auto",
        "refresh-timeout": "auto",
        callback: (value) => {
          if (sending || completed) return;
          if (typeof value !== "string" || !value) {
            clearToken();
            verification(VERIFICATION_FAILURE, true);
            return;
          }
          token = value;
          // Also check age on submit, in case a sleeping tab delayed the expiry callback.
          tokenExpiresAt = Date.now() + 290000;
          verification("Verification complete. You can request an invite.");
        },
        "expired-callback": () => {
          if (completed) return;
          clearToken();
          verification("Verification expired. Please verify again.", true);
        },
        "error-callback": () => {
          if (completed) return;
          clearToken();
          verification(VERIFICATION_FAILURE, true);
        },
        "timeout-callback": () => {
          if (completed) return;
          clearToken();
          verification("Verification timed out. Please verify again.", true);
        },
        "unsupported-callback": () => {
          if (completed) return;
          clearToken();
          verification("This browser cannot complete verification. Please email hello@soldenai.com.");
        },
      });
      if (widgetId === null || widgetId === undefined) throw new Error("Verification did not start");
    } catch {
      widgetId = null;
      verification(VERIFICATION_FAILURE, true);
    } finally {
      initialising = false;
      updateSubmit();
    }
  }

  if (retry) retry.addEventListener("click", () => {
    if (sending || initialising || completed) return;
    if (widgetId !== null) resetVerification();
    else initialiseVerification();
  });

  // A plain post from an old cached page still gets a clear failure, never a verification bypass.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sent") === "0") {
      const reasons = {
        invalid: "Not sent. Please check your name, work email and message, then try again.",
        limit: "Not sent. Too many messages from this connection. Please email hello@soldenai.com.",
        origin: "Not sent. Please use the form on this page, or email hello@soldenai.com.",
        config: "Not sent. The contact form is unavailable right now. Please email hello@soldenai.com.",
        verification: "Not sent. Please complete verification and try again, or email hello@soldenai.com.",
        delivery: "Not sent. Your message could not be delivered. Please try again in a few minutes, or email hello@soldenai.com.",
      };
      settle(reasons[params.get("why")] || FALLBACK_FAILURE, true);
    }
  } catch {
    // URLSearchParams unavailable: nothing to explain.
  }

  form.addEventListener("reset", () => {
    if (!sending && !completed) resetVerification();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending || completed) return;
    if (!token || Date.now() >= tokenExpiresAt) {
      if (token) resetVerification();
      settle("Not sent. Please complete verification below, or email hello@soldenai.com.", true);
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.source = form.dataset.source || "site";
    data.t = Date.now() - loadedAt; // elapsed milliseconds since page load, never a timestamp
    data["cf-turnstile-response"] = token;
    sending = true;
    clearToken(); // Never reuse a submitted token, even if the response is lost.
    if (submit) submit.setAttribute("aria-busy", "true");
    markInvalid("");
    show("Sending.", false);
    try {
      const { response, body } = await contactJson(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      }, 35000);
      if (response.ok) {
        completed = true;
        form.reset();
        if (done) {
          if (status) status.textContent = "";
          form.hidden = true;
          done.hidden = false;
          done.focus();
        } else {
          settle(body.message || "Invite requested. We reply within two business days.", false);
        }
        // Analytics must never turn successful delivery into a retry.
        try { track("contact_submitted", { source: data.source }); } catch { /* Optional analytics. */ }
      } else {
        settle(body.message || FALLBACK_FAILURE, true);
      }
    } catch {
      settle("We could not confirm delivery. Please try again in a few minutes, or email hello@soldenai.com.", true);
    } finally {
      sending = false;
      if (submit) submit.removeAttribute("aria-busy");
      // Validation, delivery, network and timeout failures all require a fresh challenge.
      if (!completed) resetVerification();
      updateSubmit();
    }
  });

  // Register handlers first, keeping the form fail-closed throughout asynchronous startup.
  initialiseVerification();
}

// Hero demo: a directed sequence inside the real mock. Four acts, then a reset. Honours reduced motion.
// It pauses while the pointer is over it or it has keyboard focus, while it is off-screen and while the tab is hidden.
(function () {
  const frame = document.querySelector("[data-demo]");
  if (!frame) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const snapshot = frame.innerHTML;

  const q = (sel) => frame.querySelector(sel);
  const row = (k) => q(`[data-row="${k}"]`);
  let counts;
  let logTimers = [];
  let logPending = [];

  function setStatus(k, cls, text) {
    const r = row(k); const st = r.querySelector("[data-st]");
    st.className = "st " + cls; st.textContent = text;
    r.dataset.state = cls.slice(3);
    r.classList.toggle("running", cls === "st-running");
    r.classList.toggle("sel", cls === "st-call");
  }
  function setResult(k, text) { const r = row(k).querySelector("[data-res]"); r.textContent = text; r.classList.add("in"); }
  // Handover: the workstream's owner changes from a named team member to Solden, with a short flash on the row.
  function assign(k) {
    const r = row(k);
    r.dataset.owner = "solden";
    r.classList.add("handoff");
    setTimeout(() => r.classList.remove("handoff"), 400);
  }
  function key() {
    const set = (sel, v) => { const el = q(sel); if (el) el.textContent = v; };
    set("[data-k-done]", counts.done); set("[data-k-ev]", counts.ev); set("[data-k-time]", counts.time);
    q("[data-bar]").className = "progress-bar " + `p-${counts.done}-${counts.review}-${counts.call}`;
    const exc = q("[data-exc]"); exc.hidden = counts.call === 0; exc.textContent = counts.call;
  }
  function clearLogTimers() {
    for (const id of logTimers) clearTimeout(id);
    logTimers = [];
    logPending = [];
  }
  function appendLine(l) {
    const ol = q("[data-now-lines]");
    const li = document.createElement("li"); li.className = "new" + (l.startsWith("ok ") ? " ok" : ""); li.textContent = l.replace(/^ok /, "");
    while (ol.children.length >= 3) ol.removeChild(ol.firstChild);
    ol.appendChild(li);
  }
  // A pause mid-stream writes the remaining lines at once, so nothing keeps moving while the demo holds.
  function flushLog() {
    const rest = logPending;
    for (const id of logTimers) clearTimeout(id);
    logTimers = [];
    logPending = [];
    rest.forEach(appendLine);
  }
  // Now running: the panel names the current workstream and streams its evidence, a line at a time.
  function log(title, step, lines) {
    clearLogTimers();
    q("[data-now-name]").textContent = step ? `${title} · ${step}` : title;
    q("[data-now-lines]").innerHTML = "";
    if (reduce) { lines.forEach(appendLine); return; }
    logPending = lines.slice();
    lines.forEach((l, i) => logTimers.push(setTimeout(() => { logPending.shift(); appendLine(l); }, 380 * i)));
  }
  // The opening: papers arrive, file into the register, then the department forms around it.
  function papers(n) { q("[data-papers]").dataset.papers = n; }
  function phase(p) { frame.dataset.phase = p; }
  function run(k, title, step, lines) { setStatus(k, "st-running", "Running"); log(title, step, lines); }
  function finish(k, result) { setStatus(k, "st-done", "Complete"); setResult(k, result); }
  // Something that needs the controller joins the card beside the work.
  function flag(html) {
    const li = document.createElement("li"); li.className = "new"; li.innerHTML = html; q("[data-calls]").appendChild(li);
  }
  function act(text) {
    const ol = q("[data-activity]"); const li = document.createElement("li"); li.className = "new";
    li.innerHTML = text; while (ol.children.length >= 4) ol.removeChild(ol.lastChild); ol.insertBefore(li, ol.firstChild);
  }
  function view(v) { q("[data-panel]").dataset.view = v; }
  function camera(c) { frame.dataset.camera = c; }
  function badge(t, cls) { const b = q("[data-head-badge]"); b.textContent = t; b.className = "head-badge " + (cls || ""); }

  // Reset: fade the body out (.resetting), swap the markup while it is invisible, then fade it back in.
  // The first call and reduced motion swap at once. innerHTML replacement does not clear the frame's own classes, so .locked is removed here.
  let resetTimer = null;
  let firstReset = true;
  function reset() {
    clearLogTimers();
    if (resetTimer !== null) { clearTimeout(resetTimer); resetTimer = null; }
    const swap = () => {
      frame.innerHTML = snapshot;
      frame.classList.remove("locked");
      phase("open");
      counts = { done: 0, review: 0, call: 0, ev: 0, time: "0 min" };
      key(); view("activity"); camera("wide");
      frame.querySelectorAll("[data-row]").forEach((r) => setStatus(r.dataset.row, "st-queued", "Queued"));
      act("<time>08:00</time><span>NetSuite sync completed, 1,204 records, read‑only</span>");
      act("<time>08:01</time><span>Solden opened the April close, 16 workstreams</span>");
    };
    if (firstReset || reduce) { firstReset = false; swap(); frame.classList.remove("resetting"); return; }
    frame.classList.add("resetting");
    resetTimer = setTimeout(() => {
      resetTimer = null;
      swap();
      void frame.offsetHeight; // give the swapped-in body a computed style at opacity 0, so removing the class fades it in
      requestAnimationFrame(() => frame.classList.remove("resetting"));
    }, 350);
  }

  const HANDOVER = ["bank", "ic", "bs", "pay", "ar", "ap", "fa", "pr", "acc", "fx", "tax", "rev", "flux", "elim", "fs"];
  const T = [
    // The opening: the period's evidence arrives and files into the register.
    [350, () => papers(1)],
    [420, () => papers(2)],
    [420, () => papers(3)],
    [420, () => papers(4)],
    [1200, () => phase("file")],
    [1000, () => phase("run")],
    // Handover: each workstream passes from the team to Solden.
    ...HANDOVER.map((k) => [80, () => assign(k)]),
    [700, () => { badge("Running · day 1"); run("bank", "Bank reconciliations", "1 of 16", ["Operating GBP · ledger 1,889,112.20", "4 payments in transit · 15,205.00", "ok Difference 0.00 · workpaper attached"]); }],
    [1900, () => { finish("bank", "diff 0.00"); counts.done = 1; counts.ev = 48; key();
      run("ic", "Intercompany", "2 of 16", ["UK to NL · fee 42,000.00 both sides", "UK to US · recharge 118,250.00", "ok Both pairs agree"]); }],
    [1600, () => { finish("ic", "2 pairs agree"); counts.done = 2; counts.ev = 70; key();
      run("bs", "Balance sheet", "3 of 16", ["42 accounts in scope", "ok Every balance proved to support"]); }],
    [1000, () => { finish("bs", "42 proved"); counts.done = 3; counts.ev = 96; key(); run("pay", "Payments and processors", "4 of 16", ["ok Payouts, fees and refunds tied"]); }],
    [520, () => { finish("pay", "Payouts tied"); counts.done = 4; counts.ev = 112; key(); run("ar", "Accounts receivable", "5 of 16", ["ok Cash applied · ageing run"]); }],
    [520, () => { finish("ar", "Cash applied"); counts.done = 5; counts.ev = 128; key(); run("ap", "Accounts payable", "6 of 16", ["ok Ageing run · no duplicates"]); }],
    [520, () => { finish("ap", "No duplicates"); counts.done = 6; counts.ev = 141; key(); run("fa", "Fixed assets", "7 of 16", ["ok Depreciation run · register ties"]); }],
    [520, () => { finish("fa", "Depreciation run"); counts.done = 7; counts.ev = 150; key(); run("pr", "Payroll", "8 of 16", ["ok Tied to the GL by cost centre"]); }],
    [520, () => { finish("pr", "Tied to GL"); counts.done = 8; counts.ev = 163; key();
      run("acc", "Accruals and prepaids", "9 of 16", ["31 recurring journals drafted", "VB-5588 · 27,500.00 accrued to April", "ok Every entry tied to its source"]); }],
    [1700, () => { finish("acc", "31 journals"); counts.done = 9; counts.ev = 196; key(); run("fx", "FX revaluation", "10 of 16", ["ok USD and EUR balances revalued"]); }],
    [520, () => { finish("fx", "Revalued"); counts.done = 10; counts.ev = 204; key(); run("tax", "Tax provisions", "11 of 16", ["ok VAT computed per policy"]); }],
    [520, () => { finish("tax", "VAT computed"); counts.done = 11; counts.ev = 213; key();
      run("rev", "Revenue review", "12 of 16", ["INV-2041 · £18,400 · invoiced 28 April", "Delivered 1 May · crosses the period", "Reviewed by J. Mensah · raising to you"]); }],
    [1900, () => { setStatus("rev", "st-call", "Needs your call"); setResult("rev", "1 question"); counts.call = 1; counts.ev = 222; key();
      badge("Needs your call", "warn"); act("<time>11:02</time><span>Solden raised exception 3 with a proposal and three evidence files, reviewed by J.&nbsp;Mensah</span>");
      view("case"); camera("panel"); }],
    [2600, () => { q("[data-approve]").classList.add("pressed"); }],
    [500, () => { q("[data-actions]").classList.add("decided"); finish("rev", "Deferred to May");
      counts.call = 0; counts.done = 12; counts.ev = 226; counts.time = "5 min"; key(); badge("Running · day 3");
      act("<time>11:07</time><span><b>H. Whitmore</b> approved exception 3. Journal JE-0426-119 prepared, to post after review</span>"); }],
    [1300, () => { view("activity"); camera("main"); run("flux", "Flux and variance", "13 of 16", ["Every line against prior period and budget", "ok 3 movements explained"]); }],
    [1400, () => { finish("flux", "3 explained"); counts.done = 13; counts.ev = 248; key(); run("elim", "Eliminations", "14 of 16", ["ok Generated from reconciled balances"]); }],
    [800, () => { finish("elim", "Generated"); counts.done = 14; counts.ev = 259; key();
      run("fs", "Financial statements", "15 of 16", ["P&L, balance sheet and cash flow", "ok Statements articulate", "Reviewed by J. Mensah"]); }],
    [1700, () => { finish("fs", "Assembled"); counts.done = 15; counts.ev = 287; key();
      setStatus("lock", "st-call", "Ready to attest"); q("[data-lock-btn]").classList.remove("pbtn-disabled"); badge("Ready to attest"); camera("wide");
      log("Attest and lock", "16 of 16", ["Fifteen workstreams complete, pack assembled", "ok Evidence attached · exceptions resolved"]);
      flag("<i></i><span><b>Attest and lock April 2026</b><small>All evidence attached</small></span><em>Attest</em>"); }],
    [1800, () => { q("[data-lock-btn]").classList.add("pressed"); }],
    [500, () => { finish("lock", "Attested 8 May"); frame.classList.add("locked"); counts.done = 16; counts.time = "1.7 h"; key(); badge("Attested and locked", "ok");
      const lockBtn = q("[data-lock-btn]"); lockBtn.textContent = "Locked"; lockBtn.classList.remove("pressed");
      act("<time>14:42</time><span><b>H. Whitmore</b> attested and locked April 2026</span>"); view("pack"); camera("wide"); }],
    [4400, () => { reset(); }],
    [900, () => {}],
  ];
  const LOCKED_STEPS = T.length - 2; // everything up to "Attested and locked"; the last two steps are the reset and a pause.

  // Loop control. The demo holds while it is off-screen, while the tab is hidden, and while the visitor is
  // looking at it closely: the pointer over it or keyboard focus inside it. There is no visible control.
  let i = 0, hidden = false, tabHidden = document.hidden, pointing = false, focused = false, timer = null, stopped = false;
  const paused = () => hidden || tabHidden || pointing || focused;

  function next() {
    if (stopped || paused() || timer !== null) return;
    const [delay, fn] = T[i];
    timer = setTimeout(() => {
      timer = null;
      try {
        fn();
      } catch (err) {
        stopped = true;
        clearLogTimers();
        console.error("Hero demo stopped:", err);
        return;
      }
      i = (i + 1) % T.length;
      next();
    }, delay);
  }
  function halt() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    flushLog();
    frame.classList.add("held");
  }
  function resume() {
    if (paused()) return;
    frame.classList.remove("held");
    if (timer === null) next();
  }
  function update() {
    if (paused()) halt(); else resume();
  }

  frame.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") { pointing = true; update(); } });
  frame.addEventListener("pointerleave", () => { pointing = false; update(); });
  frame.addEventListener("focusin", () => { focused = true; update(); });
  frame.addEventListener("focusout", (event) => { if (!frame.contains(event.relatedTarget)) { focused = false; update(); } });
  document.addEventListener("visibilitychange", () => { tabHidden = document.hidden; update(); });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      hidden = !entries[0].isIntersecting;
      update();
    }, { threshold: 0.15 }).observe(frame);
  }

  reset();
  const heroSection = document.getElementById("hero");
  if (heroSection) heroSection.classList.add("in");
  requestAnimationFrame(() => requestAnimationFrame(() => frame.classList.add("landed")));
  if (reduce) {
    // Static, finished state for reduced motion: the locked close and the pack, never the reset.
    stopped = true;
    try {
      T.slice(0, LOCKED_STEPS).forEach(([, fn]) => fn());
      camera("wide");
    } catch (err) {
      console.error("Hero demo stopped:", err);
    }
    return;
  }
  next();
})();

// AI summary hand-off: the visible prompt remains usable without JavaScript or clipboard access.
for (const summary of document.querySelectorAll("[data-ai-summary]")) {
  const prompt = summary.querySelector("[data-ai-prompt]");
  const button = summary.querySelector("[data-ai-copy]");
  const status = summary.querySelector("[data-ai-status]");
  if (!prompt || !button || !status) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "";
    try {
      await navigator.clipboard.writeText(prompt.textContent.trim());
      status.textContent = "Prompt copied. Paste it into your chosen AI.";
    } catch {
      status.textContent = "Copy isn’t available here. Select and copy the prompt above.";
    } finally {
      button.disabled = false;
    }
  });
}
