// Progressive enhancement only. The page works without this file.
// The mobile menu is a <details> element and needs no script; this file only adds Escape and click-outside closing.

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

// Contact form: submit as JSON and show the result inline instead of navigating to /thanks.
const form = document.querySelector("[data-contact-form]");
if (form) {
  const status = form.querySelector("[data-form-status]");
  const submit = form.querySelector('button[type="submit"]');
  let sending = false;

  const FALLBACK_FAILURE = "Not sent. Please try again in a few minutes, or email hello@soldenai.com.";
  const done = form.parentElement && form.parentElement.querySelector("[data-form-done]");

  function show(message, failed) {
    if (!status) return;
    status.setAttribute("role", failed ? "alert" : "status");
    status.hidden = false;
    status.textContent = message;
  }

  // Final result: announce it and move focus to it so keyboard and screen-reader users land on the outcome.
  function settle(message, failed) {
    show(message, failed);
    if (!status) return;
    status.setAttribute("tabindex", "-1");
    status.focus();
  }

  // A script-blocked visitor whose plain post failed is redirected back here with ?sent=0&why=...
  // If this script does run on that landing, explain why the message was not sent.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sent") === "0") {
      const reasons = {
        invalid: "Not sent. Please check your name, work email and message, then try again.",
        limit: "Not sent. Too many messages from this connection. Please try again later.",
        config: "Not sent. The contact form is unavailable right now. Please email hello@soldenai.com.",
        delivery: "Not sent. Your message could not be delivered. Please try again in a few minutes, or email hello@soldenai.com.",
      };
      settle(reasons[params.get("why")] || FALLBACK_FAILURE, true);
    }
  } catch {
    // URLSearchParams unavailable: nothing to explain.
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;
    sending = true;
    const data = Object.fromEntries(new FormData(form).entries());
    data.source = form.dataset.source || "site";
    data.t = Date.now() - loadedAt; // elapsed milliseconds since page load, never a timestamp
    if (submit) submit.setAttribute("aria-busy", "true");
    show("Sending.", false);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        track("contact_submitted", { source: data.source });
        form.reset();
        if (done) {
          // The form gives way to the confirmation: what happens next, not a status line.
          if (status) status.hidden = true;
          form.hidden = true;
          done.hidden = false;
          done.focus();
        } else {
          settle(body.message || "Invite requested. We reply within two business days.", false);
        }
      } else {
        settle(body.message || FALLBACK_FAILURE, true);
      }
    } catch {
      settle("Not sent. Could not reach the server. Please try again in a few minutes, or email hello@soldenai.com.", true);
    } finally {
      sending = false;
      if (submit) submit.removeAttribute("aria-busy");
    }
  });
}

// Hero demo: a directed sequence inside the real mock. Four acts, then a reset. Honours reduced motion.
(function () {
  const frame = document.querySelector("[data-demo]");
  if (!frame) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const snapshot = frame.innerHTML;
  const connects = document.getElementById("connects");

  const q = (sel) => frame.querySelector(sel);
  const row = (k) => q(`[data-row="${k}"]`);
  let counts;
  let logTimers = [];

  function setStatus(k, cls, text) {
    const st = row(k).querySelector("[data-st]");
    st.className = "st " + cls; st.textContent = text;
    row(k).classList.toggle("running", cls === "st-running");
    row(k).classList.toggle("sel", cls === "st-call");
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
    q("[data-k-done]").textContent = counts.done; q("[data-k-review]").textContent = counts.review; q("[data-k-call]").textContent = counts.call;
    q("[data-k-ev]").textContent = counts.ev; q("[data-k-time]").textContent = counts.time;
    q("[data-bar]").className = "progress-bar " + `p-${counts.done}-${counts.review}-${counts.call}`;
    const exc = q("[data-exc]"); exc.hidden = counts.call === 0; exc.textContent = counts.call;
  }
  function clearLogTimers() {
    for (const id of logTimers) clearTimeout(id);
    logTimers = [];
  }
  function log(title, step, lines) {
    q("[data-log-title]").textContent = title; q("[data-log-step]").textContent = step;
    const ol = q("[data-log-lines]"); ol.innerHTML = "";
    clearLogTimers();
    const append = (l) => {
      const li = document.createElement("li"); li.className = "new" + (l.startsWith("ok ") ? " ok" : ""); li.textContent = l.replace(/^ok /, "");
      ol.appendChild(li);
    };
    if (reduce) { lines.forEach(append); return; }
    lines.forEach((l, i) => logTimers.push(setTimeout(() => append(l), 220 * i)));
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
      const refocus = document.activeElement && document.activeElement.matches("[data-demo-pause]");
      frame.innerHTML = snapshot;
      frame.classList.remove("locked");
      counts = { done: 0, review: 0, call: 0, ev: 0, time: "0 min" };
      key(); view("activity"); camera("wide");
      ["bank", "ic", "acc", "rev", "flux", "fs", "lock"].forEach((k) => setStatus(k, "st-queued", "Queued"));
      act("<time>08:00</time><span>NetSuite sync completed, 1,204 records, read-only</span>");
      act("<time>08:01</time><span>Solden opened the April close, 16 workstreams</span>");
      syncPauseButtons();
      if (refocus) { const b = q("[data-demo-pause]"); if (b) b.focus(); }
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

  const T = [
    [600, () => assign("bank")],
    [600, () => assign("ic")],
    [600, () => assign("acc")],
    [600, () => assign("rev")],
    [600, () => assign("flux")],
    [600, () => assign("fs")],
    [900, () => { camera("main"); badge("Running · day 1"); setStatus("bank", "st-running", "Running");
      log("Reconciling bank accounts", "1 of 16", ["Operating GBP · statement 1,904,317.20 · ledger 1,889,112.20", "4 outstanding payments matched to the register · 15,205.00", "ok Difference 0.00 · workpaper attached", "Operating USD, EUR, savings, cards · tied out"]); }],
    [2200, () => { setStatus("bank", "st-done", "Complete"); setResult("bank", "diff 0.00"); counts.done = 1; counts.ev = 48; key();
      setStatus("ic", "st-running", "Running"); log("Matching intercompany balances", "2 of 16", ["UK to NL · management fee · 42,000.00 both sides", "UK to US · recharge · 118,250.00 both sides", "ok Both pairs agree · elimination entries prepared"]); }],
    [1900, () => { setStatus("ic", "st-done", "Complete"); setResult("ic", "2 pairs · agree"); counts.done = 2; counts.ev = 70; key();
      setStatus("acc", "st-running", "Running"); log("Preparing accruals and prepaids", "3 of 16", ["31 recurring journals drafted from templates", "Recruitment fee · vendor bill VB-5588 · 27,500.00 accrued to April", "Prepaid insurance · schedule ties to policy · 4,166.67", "ok Every entry tied to a contract or invoice"]); }],
    [2000, () => { setStatus("acc", "st-done", "Complete"); setResult("acc", "31 journals"); counts.done = 3; counts.ev = 133; key();
      setStatus("rev", "st-running", "Running"); log("Reviewing revenue cut-off", "4 of 16", ["Recognised revenue tied to billings and delivery evidence", "INV-2041 · £18,400 · invoiced 28 April · delivered 1 May", "Cut-off crosses the period under policy v3", "Needs a decision · reviewed by J. Mensah · raising to the controller"]); }],
    [2300, () => { setStatus("rev", "st-call", "Needs your call"); setResult("rev", "1 question"); counts.call = 1; counts.ev = 142; key();
      badge("Needs your call", "warn"); act("<time>11:02</time><span>Solden raised exception 3 with a proposal and three evidence files, reviewed by J.&nbsp;Mensah</span>");
      view("case"); camera("panel"); }],
    [2600, () => { q("[data-approve]").classList.add("pressed"); }],
    [500, () => { q("[data-actions]").classList.add("decided"); setStatus("rev", "st-done", "Complete"); setResult("rev", "Deferred to May");
      counts.call = 0; counts.done = 4; counts.time = "5 min"; key(); badge("Running · day 3");
      act("<time>11:07</time><span><b>H. Whitmore</b> approved exception 3. Journal JE-0426-119 queued for review</span>"); }],
    [1400, () => { view("activity"); camera("main"); setStatus("flux", "st-running", "Running");
      log("Explaining what moved", "14 of 16", ["Every P&L and balance-sheet line against prior period and budget", "Contractor costs −12,400.00 · two engagements ended 31 March · final invoices VB-5610, VB-5611", "ok 3 lines above threshold · drivers attached from workstreams"]); }],
    [2000, () => { setStatus("flux", "st-done", "Complete"); setResult("flux", "3 explained"); counts.done = 14; counts.ev = 241; key();
      setStatus("fs", "st-running", "Running"); log("Assembling the statements", "15 of 16", ["P&L, balance sheet and cash flow from locked workstreams", "ok Net income ties · cash ties · statements articulate", "Reviewer J. Mensah released the pack"]); }],
    [1900, () => { setStatus("fs", "st-done", "Complete"); setResult("fs", "Assembled"); counts.done = 15; counts.ev = 287; key();
      setStatus("lock", "st-call", "Ready to attest"); q("[data-lock-btn]").classList.remove("pbtn-disabled"); badge("Ready to attest"); camera("wide");
      log("Waiting on the controller", "16 of 16", ["All workstreams complete · evidence attached · exceptions resolved", "Attestation gate open"]); }],
    [1800, () => { q("[data-lock-btn]").classList.add("pressed"); }],
    [500, () => { setStatus("lock", "st-done", "Locked"); setResult("lock", "Attested 8 May"); row("lock").classList.add("signed"); frame.classList.add("locked"); counts.done = 16; counts.time = "1.7 h"; key(); badge("Attested and locked", "ok");
      q("[data-runlog]").classList.add("quiet"); log("Close locked", "", ["ok April 2026 locked · immutable · exportable for auditors"]);
      act("<time>14:42</time><span><b>H. Whitmore</b> attested and locked April 2026</span>"); view("pack"); camera("panel"); }],
    [4200, () => { reset(); }],
    [900, () => {}],
  ];
  const LOCKED_STEPS = 18; // T[0..5] hand the work over, T[6..17] end on "Attested and locked"; T[18] is the reset.

  // Loop control. Two independent pauses: out of view (visibility) and the Pause button (user).
  let i = 0, hidden = false, userPaused = false, timer = null, stopped = false;
  const paused = () => hidden || userPaused;

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
  }
  function resume() {
    if (!paused() && timer === null) next();
  }

  // Pause button. It lives in the figure caption below the frame (outside the rebuilt markup), so delegate on the document and re-sync.
  function syncPauseButtons() {
    for (const b of document.querySelectorAll("[data-demo-pause]")) {
      b.setAttribute("aria-pressed", userPaused ? "true" : "false");
      b.textContent = userPaused ? "Play" : "Pause";
    }
  }
  function setUserPaused(on) {
    userPaused = on;
    for (const el of [frame, connects]) {
      if (!el) continue;
      if (on) el.dataset.paused = "true"; else delete el.dataset.paused;
    }
    syncPauseButtons();
    if (on) halt(); else resume();
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest && event.target.closest("[data-demo-pause]");
    if (!b) return;
    setUserPaused(!userPaused);
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      hidden = !entries[0].isIntersecting;
      if (hidden) halt(); else resume();
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
