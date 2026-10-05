import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createContactHandler, contactConfiguration, parseMaxPerHour } from "../lib/contact.js";
import { sslOptionsFromEnv } from "../lib/store.js";

const env = { RESEND_API_KEY: "re_test", LEAD_NOTIFY_TO: "founders@example.com", TURNSTILE_SITE_KEY: "test-site", TURNSTILE_SECRET_KEY: "test-secret" };
const valid = { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines Ltd", message: "We run NetSuite with four entities.", t: "8500", "cf-turnstile-response": "test-token" };
const formHeaders = { "content-type": "application/x-www-form-urlencoded", accept: "text/html" };
function request(body = valid, { headers = {}, ip = "203.0.113.5", ...rest } = {}) {
  return { method: "POST", headers: { "content-type": "application/json", accept: "application/json", origin: "https://soldenai.com", host: "soldenai.com", ...headers }, body, socket: { remoteAddress: ip }, ...rest };
}
function response() {
  return { statusCode: 200, headers: {}, body: "", setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(chunk) { this.body = chunk || ""; } };
}
async function submit(handle, body = valid, options = {}) {
  const res = response(); await handle(request(body, options), res); return res;
}
// Purpose-built contract fake, not a substitute for the real PostgreSQL integration suite.
function fakeStore() {
  const records = new Map();
  const claims = [];
  return {
    records, claims,
    async claimSubmission(args) {
      claims.push(args);
      let row = records.get(args.dedupKey);
      if (row?.busy) return { status: "busy" };
      if (row?.teamSent && (!row.confirmation || row.confirmationSent)) return { status: "complete" };
      if (!row) {
        const messages = args.buildMessages(records.size + 1);
        row = { id: String(records.size + 1), leaseToken: "lease", ...messages, teamSent: false, confirmationSent: false };
        records.set(args.dedupKey, row);
      }
      row.busy = true;
      return { ...row, status: "claimed" };
    },
    async authorizeConfirmation(_id, _leaseToken, limit) { return limit > 0; },
    async markSent(id, leaseToken, kind) { const row = [...records.values()].find((r) => r.id === id); row[`${kind}Sent`] = true; return true; },
    async finishSubmission(id) { [...records.values()].find((r) => r.id === id).busy = false; return true; },
  };
}
function harness(options = {}) {
  const calls = [];
  const store = options.store ?? fakeStore();
  const fetch = async (url, init) => {
    const call = { url, ...init, payload: JSON.parse(init.body) }; calls.push(call);
    if (url.endsWith("/siteverify")) return { ok: true, json: async () => ({ success: true, hostname: "soldenai.com", action: "contact" }) };
    assert.equal(url, "https://api.resend.com/emails", "no unexpected network destination");
    return { ok: true };
  };
  const handle = createContactHandler({ env, fetch, store, ...options });
  return { calls, store, handle, emails: () => calls.filter((c) => c.url.endsWith("/emails")) };
}

test("verified submission reserves durable admission before sending both keyed emails", async () => {
  const h = harness(); const res = await submit(h.handle);
  assert.equal(res.statusCode, 200);
  assert.equal(h.calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(h.calls[0].payload.secret, "test-secret");
  assert.equal(h.store.claims.length, 1);
  const [team, confirmation] = h.emails();
  assert.deepEqual(team.payload.to, ["founders@example.com"]);
  assert.equal(team.payload.reply_to, "ada@example.com");
  assert.match(team.payload.text, /four entities/);
  assert.equal(team.payload.subject, "Invite request: Analytical Engines Ltd");
  assert.match(team.headers["Idempotency-Key"], /^contact-team\//);
  assert.match(confirmation.headers["Idempotency-Key"], /^contact-confirmation\//);
  assert.notEqual(team.headers["Idempotency-Key"], confirmation.headers["Idempotency-Key"]);
  assert.deepEqual(confirmation.payload.to, ["ada@example.com"]);
  assert.match(confirmation.payload.text, /Thanks, Ada\./);
});

for (const token of [undefined, "", " ", null, [], {}, "x".repeat(2049)]) {
  test(`missing or malformed token rejected before persistence: ${typeof token}/${String(token).length}`, async () => {
    const h = harness(); const res = await submit(h.handle, { ...valid, "cf-turnstile-response": token });
    assert.equal(res.statusCode, 403); assert.equal(h.calls.length, 0); assert.equal(h.store.claims.length, 0);
  });
}
for (const validation of [
  { success: false, "error-codes": ["invalid-input-response"] },
  { success: false, "error-codes": ["timeout-or-duplicate"] },
  { success: true, hostname: "evil.example", action: "contact" },
  { success: true, hostname: "soldenai.com", action: "login" },
  { success: "true", hostname: "soldenai.com", action: "contact" }, null,
]) {
  test(`invalid, expired, replayed or mismatched challenge fails closed: ${JSON.stringify(validation)}`, async () => {
    const h = harness({ fetch: async () => ({ ok: true, json: async () => validation }) });
    assert.equal((await submit(h.handle)).statusCode, 403); assert.equal(h.store.claims.length, 0);
  });
}
for (const failure of [
  async () => { throw new Error("offline"); },
  async () => ({ ok: false, status: 503 }),
  async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }),
  async () => new Promise(() => {}),
  async () => ({ ok: true, json: () => new Promise(() => {}) }),
]) {
  test("verification transport, status, malformed response and hung body failures are bounded", async () => {
    const h = harness({ fetch: failure, verificationTimeoutMs: 10 }); const start = Date.now();
    assert.equal((await submit(h.handle)).statusCode, 503); assert.equal(h.store.claims.length, 0); assert.ok(Date.now() - start < 1000);
  });
}

test("a token cannot be replayed even on an otherwise duplicate request", async () => {
  const h = harness(); let used = false;
  const handle = createContactHandler({ env, store: h.store, fetch: async (url, init) => {
    if (url.endsWith("/siteverify")) { const success = !used; used = true; return { ok: true, json: async () => ({ success, hostname: "soldenai.com", action: "contact" }) }; }
    h.calls.push({ url, payload: JSON.parse(init.body) }); return { ok: true };
  } });
  assert.equal((await submit(handle)).statusCode, 200);
  assert.equal((await submit(handle)).statusCode, 403);
  assert.equal(h.store.claims.length, 1); assert.equal(h.calls.length, 2);
});

for (const origin of [undefined, "", "null", "https://evil.example", "http://soldenai.com", "https://soldenai.com.evil.example"]) {
  test(`origin is exact and required: ${origin}`, async () => {
    const h = harness(); assert.equal((await submit(h.handle, valid, { headers: { origin, "x-forwarded-host": "evil.example", host: "evil.example" } })).statusCode, 403);
    assert.equal(h.calls.length, 0);
  });
}
for (const t of [undefined, "", "abc", -1, 2999, Infinity, null, [], {}]) {
  test(`untrusted/missing timer has no bypass: ${String(t)}`, async () => {
    const h = harness(); assert.equal((await submit(h.handle, { ...valid, t })).statusCode, 400); assert.equal(h.calls.length, 0);
  });
}
test("honeypot is silent and validation errors send nothing", async () => {
  const h = harness(); assert.equal((await submit(h.handle, { ...valid, website: "spam" })).statusCode, 200);
  assert.equal((await submit(h.handle, { name: "Ada" })).statusCode, 400);
  assert.equal((await submit(h.handle, { ...valid, email: "bad" })).statusCode, 400); assert.equal(h.calls.length, 0);
});

test("attempt slots are reserved before concurrent verification; raw forwarding headers cannot evade", async () => {
  const h = harness({ env: { ...env, CONTACT_MAX_ATTEMPTS_PER_IP_PER_HOUR: "2" } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => submit(h.handle, { ...valid, message: String(i) }, { headers: { "x-forwarded-for": `1.1.1.${i}`, "x-real-ip": `2.2.2.${i}` } })));
  assert.equal(results.filter((r) => r.statusCode === 429).length, 6);
  assert.equal(h.calls.filter((c) => c.url.endsWith("/siteverify")).length, 2);
});
test("attempt window expires, and trusted Express req.ip wins over the connection", async () => {
  let clock = 1000;
  const h = harness({ now: () => clock, env: { ...env, CONTACT_MAX_ATTEMPTS_PER_IP_PER_HOUR: "1" } });
  assert.equal((await submit(h.handle)).statusCode, 200);
  assert.equal((await submit(h.handle)).statusCode, 429);
  assert.equal((await submit(h.handle, { ...valid, message: "other" }, { ip: "1.2.3.4" })).statusCode, 200);
  clock += 3_600_001;
  assert.equal((await submit(h.handle)).statusCode, 200);
});
test("IP HMAC, normalized content and quotas reach atomic admission", async () => {
  const h = harness({ env: { ...env, IP_HASH_SECRET: "test-only", CONTACT_MAX_PER_IP_PER_HOUR: "2", CONTACT_MAX_PER_RECIPIENT_PER_HOUR: "1", CONTACT_MAX_CONFIRMATIONS_PER_HOUR: "4" } });
  await submit(h.handle, { ...valid, email: " ADA@EXAMPLE.COM ", name: " Ada   Lovelace ", message: "A\r\n\r\n\r\nB   C" });
  const args = h.store.claims[0];
  assert.equal(args.lead.ip_hash, createHmac("sha256", "test-only").update("203.0.113.5").digest("hex").slice(0, 32));
  assert.equal(args.lead.email, "ada@example.com"); assert.equal(args.lead.message, "A\n\nB C");
  assert.deepEqual(args.limits, { ipPerHour: 2, recipientPerHour: 1, confirmationsPerHour: 4 });
});

test("shared store deduplicates concurrent handlers, then returns completed success", async () => {
  const h = harness(); const second = harness({ store: h.store });
  const results = await Promise.all([submit(h.handle), submit(second.handle)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(h.emails().length + second.emails().length, 2);
  assert.equal((await submit(second.handle, { ...valid, email: "ADA@EXAMPLE.COM", source: "about" }, { ip: "198.51.100.5" })).statusCode, 200);
  assert.equal(h.emails().length + second.emails().length, 2);
});
for (const status of ["limited", "expired"]) {
  test(`durable admission ${status} sends no email`, async () => {
    const h = harness({ store: { claimSubmission: async () => ({ status }) } });
    assert.equal((await submit(h.handle)).statusCode, status === "limited" ? 429 : 503); assert.equal(h.emails().length, 0);
  });
}
for (const options of [
  { getStore: async () => null }, { getStore: async () => { throw new Error("database offline"); } },
  { getStore: () => new Promise(() => {}) },
  { store: { claimSubmission: async () => { throw new Error("transaction failed"); } } },
  { store: { claimSubmission: () => new Promise(() => {}) } },
]) {
  test("missing, failed or hanging durable store blocks email", async () => {
    const h = harness({ ...options, storeTimeoutMs: 10 });
    assert.equal((await submit(h.handle)).statusCode, 503); assert.equal(h.emails().length, 0);
  });
}

test("delivery failure retries the same immutable payload and key, even after config/source changes", async () => {
  const h = harness(); const calls = []; let failTeam = true;
  const fetch = async (url, init) => {
    if (url.endsWith("/siteverify")) return { ok: true, json: async () => ({ success: true, hostname: "soldenai.com", action: "contact" }) };
    calls.push({ body: init.body, key: init.headers["Idempotency-Key"] });
    if (failTeam) { failTeam = false; return { ok: false }; } return { ok: true };
  };
  let handle = createContactHandler({ env, store: h.store, fetch });
  assert.equal((await submit(handle)).statusCode, 502);
  handle = createContactHandler({ env: { ...env, LEAD_NOTIFY_TO: "new@example.com" }, store: h.store, fetch });
  assert.equal((await submit(handle, { ...valid, source: "how-it-works" })).statusCode, 200);
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls.length, 3);
});
test("ambiguous Resend timeout is bounded and replay keeps its idempotency key", async () => {
  const h = harness(); const calls = []; let hang = true;
  const fetch = async (url, init) => {
    if (url.endsWith("/siteverify")) return { ok: true, json: async () => ({ success: true, hostname: "soldenai.com", action: "contact" }) };
    calls.push(init);
    if (hang) { hang = false; return new Promise(() => {}); } return { ok: true };
  };
  const handle = createContactHandler({ env, store: h.store, fetch, deliveryTimeoutMs: 10 });
  assert.equal((await submit(handle)).statusCode, 502);
  assert.equal((await submit(handle)).statusCode, 200);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});
test("failed receipt persistence never proceeds to confirmation and retries the same team payload", async () => {
  const h = harness(); let fail = true; const mark = h.store.markSent;
  h.store.markSent = async (...args) => { if (fail) { fail = false; throw new Error("database lost"); } return mark(...args); };
  assert.equal((await submit(h.handle)).statusCode, 502); assert.equal(h.emails().length, 1);
  assert.equal((await submit(h.handle)).statusCode, 200);
  assert.deepEqual(h.emails()[0].payload, h.emails()[1].payload);
  assert.equal(h.emails()[0].headers["Idempotency-Key"], h.emails()[1].headers["Idempotency-Key"]);
});
test("lost lease stops sending; failed release cannot erase receipt flags", async () => {
  const h = harness(); h.store.markSent = async () => false;
  assert.equal((await submit(h.handle)).statusCode, 502); assert.equal(h.emails().length, 1);
  const other = harness(); other.store.finishSubmission = async () => { throw new Error("offline"); };
  assert.equal((await submit(other.handle)).statusCode, 200);
  assert.equal([...other.store.records.values()][0].teamSent, true);
});
test("confirmation failure still acknowledges team delivery, retry sends only the confirmation", async () => {
  const h = harness(); const calls = []; let fail = true;
  const fetch = async (url, init) => {
    if (url.endsWith("/siteverify")) return { ok: true, json: async () => ({ success: true, hostname: "soldenai.com", action: "contact" }) };
    calls.push(init); if (init.headers["Idempotency-Key"].includes("confirmation") && fail) { fail = false; return { ok: false }; } return { ok: true };
  };
  const handle = createContactHandler({ env, store: h.store, fetch });
  assert.equal((await submit(handle)).statusCode, 200); assert.equal((await submit(handle)).statusCode, 200);
  assert.equal(calls.length, 3); assert.equal(calls[1].body, calls[2].body); assert.deepEqual(calls[1].headers, calls[2].headers);
});
test("reserved confirmation suppression never suppresses the team", async () => {
  const h = harness(); const claim = h.store.claimSubmission;
  h.store.claimSubmission = async (args) => { const row = await claim(args); row.confirmation = null; return row; };
  assert.equal((await submit(h.handle)).statusCode, 200); assert.equal(h.emails().length, 1);
});
test("confirmation never repeats submitted links or message, while team HTML escapes them", async () => {
  const h = harness(); await submit(h.handle, { ...valid, name: "http://spam.example/win Now", company: "<ScRiPt>spam.example</ScRiPt>", message: "<b>Cheap pills</b>" });
  const [team, confirmation] = h.emails().map((c) => c.payload);
  assert.match(team.html, /&lt;script&gt;/i); assert.doesNotMatch(team.html, /<script\b/i);
  assert.doesNotMatch(confirmation.html + confirmation.text + confirmation.subject, /spam\.example|pills/);
  assert.match(confirmation.text, /Thanks, there\./);
});

test("plain form posts have no no-JS verification bypass, and errors return only local paths", async () => {
  const h = harness();
  let res = await submit(h.handle, new URLSearchParams({ ...valid, "cf-turnstile-response": "" }).toString(), { headers: { ...formHeaders, referer: "https://evil.example/how-it-works" } });
  assert.equal(res.statusCode, 303); assert.equal(res.headers.location, "/how-it-works?sent=0&why=verification#contact");
  res = await submit(h.handle, new URLSearchParams(valid).toString(), { headers: formHeaders });
  assert.equal(res.headers.location, "/thanks");
  res = await submit(h.handle, "name=Ada&t=8500", { headers: { ...formHeaders, referer: "https://evil.example/phish" } });
  assert.equal(res.headers.location, "/about?sent=0&why=invalid#contact");
});
test("GET always returns 405 JSON; malformed JSON fails safely", async () => {
  const h = harness(); let res = await submit(h.handle, null, { method: "GET", headers: formHeaders });
  assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, "POST");
  assert.equal((await submit(h.handle, "{bad")).statusCode, 400); assert.equal(h.calls.length, 0);
});
test("configuration is fail-closed, rejects test keys in production and never derives origins from a request", async () => {
  for (const patch of [{ TURNSTILE_SITE_KEY: "" }, { TURNSTILE_SECRET_KEY: "" }, { CONTACT_ALLOWED_ORIGINS: "https://evil.example/path" }, { CONTACT_ALLOWED_ORIGINS: "http://soldenai.com" }, { NODE_ENV: "production", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }, { RAILWAY_ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" }]) {
    assert.equal(contactConfiguration({ ...env, ...patch }), null);
    const h = harness({ env: { ...env, ...patch } }); assert.equal((await submit(h.handle)).statusCode, 503); assert.equal(h.calls.length, 0);
  }
  assert.deepEqual(contactConfiguration({ ...env, CONTACT_ALLOWED_ORIGINS: "http://localhost:8080" }).origins, ["http://localhost:8080"]);
  for (const patch of [{ RESEND_API_KEY: "" }, { LEAD_NOTIFY_TO: "" }]) assert.equal((await submit(harness({ env: { ...env, ...patch } }).handle)).statusCode, 503);
});
test("hourly limits are positive integers and TLS verification remains explicit", () => {
  for (const value of [undefined, "", "nope", "0", "-1", "1.5", "Infinity"]) assert.equal(parseMaxPerHour(value, 7), 7);
  assert.equal(parseMaxPerHour("2"), 2);
  assert.equal(sslOptionsFromEnv({}), undefined); assert.equal(sslOptionsFromEnv({ DB_SSL: "true" }), true);
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL_NO_VERIFY: "true" }), { rejectUnauthorized: false });
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL_CA: "a\\nb", DB_SSL_NO_VERIFY: "true" }), { ca: "a\nb", rejectUnauthorized: true });
});

test("zero confirmation budget is passed through as a deliberate off switch", async () => {
  const h = harness({ env: { ...env, CONTACT_MAX_CONFIRMATIONS_PER_HOUR: "0" } });
  await submit(h.handle);
  assert.equal(h.store.claims[0].limits.confirmationsPerHour, 0);
});

test("confirmation dispatch must receive durable permission immediately before sending", async () => {
  for (const permit of [async () => false, async () => { throw new Error("database lost"); }, () => new Promise(() => {})]) {
    const h = harness({ storeTimeoutMs: 10 }); h.store.authorizeConfirmation = permit;
    assert.equal((await submit(h.handle)).statusCode, 200);
    assert.equal(h.emails().length, 1);
    assert.equal([...h.store.records.values()][0].teamSent, true);
  }
});

test("JSON object/array fields cannot throw through coercion before verification", async () => {
  for (const key of ["name", "email", "company", "message"]) {
    for (const value of [{ toString: 0 }, ["Ada"], 42, null]) {
      const h = harness();
      assert.equal((await submit(h.handle, { ...valid, [key]: value })).statusCode, 400);
      assert.equal(h.calls.length, 0);
    }
  }
  const h = harness();
  assert.equal((await submit(h.handle, { ...valid, website: { toString: 0 }, source: { toString: 0 } })).statusCode, 200);
});
