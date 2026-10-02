import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createContactHandler, parseMaxPerHour } from "../lib/contact.js";
import { sslOptionsFromEnv } from "../lib/store.js";

function fakeRequest({ body, headers = {}, method = "POST", ip = "203.0.113.5" }) {
  return {
    method,
    headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": ip, ...headers },
    body,
    socket: { remoteAddress: ip },
  };
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk || "";
      this.ended = true;
    },
  };
  return res;
}

const env = { RESEND_API_KEY: "re_test", LEAD_NOTIFY_TO: "founders@example.com", CONTACT_MAX_PER_IP_PER_HOUR: "2" };
const valid = { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines Ltd", message: "We run NetSuite with four entities.", t: "8500" };
const formHeaders = { "content-type": "application/x-www-form-urlencoded", accept: "text/html" };

function okFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
}

function quiet(fn) {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = error;
      console.warn = warn;
    });
}

test("valid submission emails the founder inbox with reply-to set", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  const res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(calls.length, 2, "team note, then the prospect confirmation");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.deepEqual(calls[0].init.to, ["founders@example.com"]);
  assert.equal(calls[0].init.reply_to, "ada@example.com");
  assert.match(calls[0].init.text, /four entities/);
  assert.match(calls[0].init.html, /Analytical Engines Ltd/);
  assert.match(calls[0].init.html, /<!doctype html>/i);
  assert.deepEqual(calls[1].init.to, ["ada@example.com"]);
  assert.equal(calls[1].init.reply_to, "founders@example.com");
  assert.equal(calls[1].init.subject, "Your invite request to Solden");
  assert.match(calls[1].init.html, /Thanks, Ada\./);
  assert.match(calls[1].init.text, /two business days/);
});

test("a failed prospect confirmation does not fail the request", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init: JSON.parse(init.body) });
    return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 500 };
  };
  const handle = createContactHandler({ env, fetch });
  const res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
});

test("email subject is an invite request and never uses retired language", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  await handle(fakeRequest({ body: valid }), fakeResponse());
  assert.equal(calls[0].init.subject, "Invite request: Analytical Engines Ltd");
  assert.doesNotMatch(calls[0].init.subject, /design[- ]partner/i);
  assert.doesNotMatch(calls[0].init.text, /design[- ]partner/i);
  assert.doesNotMatch(calls[0].init.html + calls[1].init.html, /design[- ]partner|founder inbox/i);
});

test("missing fields return 400 and send nothing", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  const res = fakeResponse();
  await handle(fakeRequest({ body: { name: "Ada" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).message, /Please fill in: Work email, Company, How your close runs today\./);
  assert.equal(calls.length, 0);
});

test("invalid email returns 400", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  const res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, email: "not-an-email" } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("honeypot submissions are swallowed silently", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  const res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, website: "http://spam.example" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(calls.length, 0);
});

test("bot timing: t is elapsed milliseconds, only a fast finite value is rejected", async () => {
  const calls = [];
  const handle = createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "50" }, fetch: okFetch(calls) });

  // Too fast: swallowed with a fake success, no email.
  let res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, t: "500" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);

  // Legitimate elapsed time sends the email.
  res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, t: "8500" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);

  // A body without t at all did not come from either form: swallowed, no email.
  res = fakeResponse();
  const { t: _omitted, ...withoutT } = valid;
  await handle(fakeRequest({ body: withoutT }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);

  // A legitimate send again, so the counts below carry on in pairs.
  res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(calls.length, 4);

  // Empty and non-numeric t pass through as well.
  res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, t: "" } }), res);
  assert.equal(calls.length, 6);
  res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, t: "abc" } }), res);
  assert.equal(calls.length, 8);

  // A negative value is not in [0, MIN_FILL_MS), so it passes too.
  res = fakeResponse();
  await handle(fakeRequest({ body: { ...valid, t: "-4" } }), res);
  assert.equal(calls.length, 10);
});

test("per-IP rate limit applies after the configured number of sends", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  for (let i = 0; i < 2; i += 1) {
    const res = fakeResponse();
    await handle(fakeRequest({ body: valid }), res);
    assert.equal(res.statusCode, 200);
  }
  const res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(calls.length, 4);
});

test("rate limit window slides: hits older than an hour are swept", async () => {
  const calls = [];
  let clock = 1_000_000;
  const handle = createContactHandler({ env, fetch: okFetch(calls), now: () => clock });
  for (let i = 0; i < 2; i += 1) await handle(fakeRequest({ body: valid }), fakeResponse());
  let res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 429);
  clock += 60 * 60 * 1000 + 1;
  res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 6);
});

test("rate limit key prefers req.ip, then x-real-ip, over x-forwarded-for", async () => {
  const calls = [];
  const handle = createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "1" }, fetch: okFetch(calls) });
  // Same real client, rotating a spoofed x-forwarded-for each time.
  await handle(fakeRequest({ body: valid, headers: { "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1" } }), fakeResponse());
  const res = fakeResponse();
  await handle(fakeRequest({ body: valid, headers: { "x-real-ip": "198.51.100.7", "x-forwarded-for": "2.2.2.2" } }), res);
  assert.equal(res.statusCode, 429);

  const viaExpress = createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "1" }, fetch: okFetch(calls) });
  await viaExpress({ ...fakeRequest({ body: valid, ip: "3.3.3.3" }), ip: "10.0.0.9" }, fakeResponse());
  const second = fakeResponse();
  await viaExpress({ ...fakeRequest({ body: valid, ip: "4.4.4.4" }), ip: "10.0.0.9" }, second);
  assert.equal(second.statusCode, 429);
});

test("IP hash is an HMAC when IP_HASH_SECRET is set", async () => {
  const seen = [];
  const store = {
    async countRecent() {
      return 0;
    },
    async insertLead(lead) {
      seen.push(lead.ip_hash);
      return 1;
    },
  };
  const plain = createContactHandler({ env, fetch: okFetch([]), store });
  const keyed = createContactHandler({ env: { ...env, IP_HASH_SECRET: "s3cret" }, fetch: okFetch([]), store });
  await plain(fakeRequest({ body: valid }), fakeResponse());
  await keyed(fakeRequest({ body: valid }), fakeResponse());
  assert.notEqual(seen[0], seen[1]);
  assert.equal(seen[1], createHmac("sha256", "s3cret").update("203.0.113.5").digest("hex").slice(0, 32));
});

test("CONTACT_MAX_PER_IP_PER_HOUR falls back to 5 unless it is a positive number", async () => {
  await quiet(() => {
    assert.equal(parseMaxPerHour(undefined), 5);
    assert.equal(parseMaxPerHour(""), 5);
    assert.equal(parseMaxPerHour("abc"), 5);
    assert.equal(parseMaxPerHour("0"), 5);
    assert.equal(parseMaxPerHour("-3"), 5);
    assert.equal(parseMaxPerHour("Infinity"), 5);
    assert.equal(parseMaxPerHour("7"), 7);
  });
  const calls = [];
  const handle = await quiet(() => createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "abc" }, fetch: okFetch(calls) }));
  for (let i = 0; i < 5; i += 1) {
    const res = fakeResponse();
    await handle(fakeRequest({ body: valid }), res);
    assert.equal(res.statusCode, 200);
  }
  const res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 429);
});

test("missing configuration returns 503 instead of pretending", async () => {
  const handle = createContactHandler({ env: {}, fetch: okFetch([]) });
  const res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 503);
});

test("email provider failure returns 502", async () => {
  const handle = createContactHandler({ env, fetch: async () => ({ ok: false, status: 500 }) });
  const res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 502);
});

test("non-object JSON bodies are treated as empty and return 400, not 500", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  for (const raw of ["null", '"a string"', "123", "[1,2]", "true"]) {
    const res = fakeResponse();
    await handle(fakeRequest({ body: raw }), res);
    assert.equal(res.statusCode, 400, `raw body ${raw}`);
    assert.match(JSON.parse(res.body).message, /Please fill in/);
  }
  for (const parsed of [[], [valid], 42, true]) {
    const res = fakeResponse();
    await handle(fakeRequest({ body: parsed }), res);
    assert.equal(res.statusCode, 400, `pre-parsed body ${JSON.stringify(parsed)}`);
  }
  assert.equal(calls.length, 0);
});

test("malformed JSON returns 400", async () => {
  const handle = createContactHandler({ env, fetch: okFetch([]) });
  const res = fakeResponse();
  await handle(fakeRequest({ body: "{not json" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).message, /Could not read the form/);
});

test("plain form posts redirect to /thanks and are stored when a store is present", async () => {
  const inserted = [];
  const store = {
    async countRecent() {
      return 0;
    },
    async insertLead(lead) {
      inserted.push(lead);
      return 42;
    },
  };
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls), store });
  const res = fakeResponse();
  const form = new URLSearchParams(valid).toString();
  await handle(fakeRequest({ body: form, headers: formHeaders }), res);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/thanks");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].email, "ada@example.com");
  assert.match(calls[0].init.text, /Lead: 42/);
});

test("plain form posts that fail redirect back to the form with a reason", async () => {
  const form = new URLSearchParams(valid).toString();

  let handle = createContactHandler({ env: {}, fetch: okFetch([]) });
  let res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: form, headers: formHeaders }), res));
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/about?sent=0&why=config#contact");

  handle = createContactHandler({ env, fetch: okFetch([]) });
  res = fakeResponse();
  await handle(fakeRequest({ body: "name=Ada", headers: { ...formHeaders, referer: "https://soldenai.com/about" } }), res);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/about?sent=0&why=invalid#contact");

  res = fakeResponse();
  await handle(fakeRequest({ body: "name=Ada", headers: { ...formHeaders, referer: "https://soldenai.com/" } }), res);
  assert.equal(res.headers.location, "/?sent=0&why=invalid#invite");

  // A foreign or odd Referer never becomes an off-site redirect.
  res = fakeResponse();
  await handle(fakeRequest({ body: "name=Ada", headers: { ...formHeaders, referer: "https://evil.example//evil.example/x" } }), res);
  assert.equal(res.headers.location, "/about?sent=0&why=invalid#contact");

  handle = createContactHandler({ env, fetch: async () => ({ ok: false, status: 500 }) });
  res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: form, headers: formHeaders }), res));
  assert.equal(res.headers.location, "/about?sent=0&why=delivery#contact");

  handle = createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "1" }, fetch: okFetch([]) });
  await handle(fakeRequest({ body: form, headers: formHeaders }), fakeResponse());
  res = fakeResponse();
  await handle(fakeRequest({ body: form, headers: formHeaders }), res);
  assert.equal(res.headers.location, "/about?sent=0&why=limit#contact");
});

test("a hanging or failing store never blocks the email", async () => {
  const calls = [];
  const hanging = {
    countRecent: () => new Promise(() => {}),
    insertLead: () => new Promise(() => {}),
  };
  let handle = createContactHandler({ env, fetch: okFetch(calls), store: hanging, storeTimeoutMs: 20 });
  let res = fakeResponse();
  const startedAt = Date.now();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].init.text, /Lead:/);
  assert.ok(Date.now() - startedAt < 1000);

  const failing = {
    async countRecent() {
      throw new Error("connection refused");
    },
    async insertLead() {
      throw new Error("connection refused");
    },
  };
  handle = createContactHandler({ env, fetch: okFetch(calls), store: failing });
  res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 4);

  // A store factory that hangs on connect is raced too.
  handle = createContactHandler({ env, fetch: okFetch(calls), getStore: () => new Promise(() => {}), storeTimeoutMs: 20 });
  res = fakeResponse();
  await quiet(() => handle(fakeRequest({ body: valid }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 6);
});

test("the store's recent count enforces the limit when it answers in time", async () => {
  const store = {
    async countRecent() {
      return 99;
    },
    async insertLead() {
      return 1;
    },
  };
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls), store });
  const res = fakeResponse();
  await handle(fakeRequest({ body: valid }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(calls.length, 0);
});

test("GET is rejected with JSON whatever the client accepts", async () => {
  const handle = createContactHandler({ env, fetch: okFetch([]) });
  let res = fakeResponse();
  await handle(fakeRequest({ body: {}, method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  res = fakeResponse();
  await handle(fakeRequest({ body: undefined, method: "GET", headers: { accept: "*/*", "content-type": "" } }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
  assert.match(res.headers["content-type"], /application\/json/);
});

test("Postgres TLS verifies by default, with a documented opt-out and CA override", () => {
  assert.equal(sslOptionsFromEnv({}), undefined);
  assert.equal(sslOptionsFromEnv({ DB_SSL: "true" }), true);
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL: "true", DB_SSL_NO_VERIFY: "true" }), { rejectUnauthorized: false });
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL_NO_VERIFY: "true" }), { rejectUnauthorized: false });
  const ca = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL_CA: ca, DB_SSL_NO_VERIFY: "true" }), { ca, rejectUnauthorized: true });
  assert.deepEqual(sslOptionsFromEnv({ DB_SSL_CA: ca.replace(/\n/g, "\\n") }), { ca, rejectUnauthorized: true });
});

test("a browser post from another site is refused before anything is read or sent", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  let res = fakeResponse();
  await handle(fakeRequest({ body: valid, headers: { origin: "https://evil.example", host: "soldenai.com" } }), res);
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).message, /hello@soldenai\.com/);
  res = fakeResponse();
  await handle(fakeRequest({ body: valid, headers: { origin: "null", host: "soldenai.com" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);

  // The site's own origin, and a client that sends no Origin, both go through.
  res = fakeResponse();
  await handle(fakeRequest({ body: valid, headers: { origin: "https://soldenai.com", host: "soldenai.com" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
});

test("the confirmation never mails back what was typed, and greets only a plain first name", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  const spam = { ...valid, name: "http://spam.example/win Now", company: "Visit spam.example", message: "Cheap pills at spam.example" };
  await handle(fakeRequest({ body: spam }), fakeResponse());
  const confirmation = calls[1].init;
  assert.deepEqual(confirmation.to, ["ada@example.com"]);
  for (const part of [confirmation.html, confirmation.text, confirmation.subject]) {
    assert.doesNotMatch(part, /spam\.example|pills/, "nothing submitted is echoed");
  }
  assert.match(confirmation.text, /Thanks, there\./);
  assert.match(confirmation.text, /company number 16823002/, "the trading disclosure is in the email");
});

test("confirmations stop site-wide after the hourly cap, while team emails keep going", async () => {
  const calls = [];
  const handle = createContactHandler({ env: { ...env, CONTACT_MAX_PER_IP_PER_HOUR: "50", CONTACT_MAX_CONFIRMATIONS_PER_HOUR: "2" }, fetch: okFetch(calls) });
  await quiet(async () => {
    for (let i = 0; i < 3; i += 1) {
      await handle(fakeRequest({ body: valid, ip: `203.0.113.${10 + i}` }), fakeResponse());
    }
  });
  const toTeam = calls.filter((c) => c.init.to.includes("founders@example.com")).length;
  const toProspect = calls.filter((c) => c.init.to.includes("ada@example.com")).length;
  assert.equal(toTeam, 3);
  assert.equal(toProspect, 2);
});

test("the message keeps its line breaks in the team email", async () => {
  const calls = [];
  const handle = createContactHandler({ env, fetch: okFetch(calls) });
  await handle(fakeRequest({ body: { ...valid, message: "NetSuite, four entities.\r\n\r\n\r\nWe close   on day 9." } }), fakeResponse());
  assert.match(calls[0].init.text, /NetSuite, four entities\.\n\nWe close on day 9\./);
  assert.match(calls[0].init.html, /NetSuite, four entities\.<br><br>We close on day 9\./);
});

test("a plain form post from an unknown page returns to /about, never to a page that does not exist", async () => {
  const handle = createContactHandler({ env, fetch: okFetch([]) });
  let res = fakeResponse();
  await handle(fakeRequest({ body: "name=Ada&t=", headers: { ...formHeaders, referer: "https://soldenai.com/phish" } }), res);
  assert.equal(res.headers.location, "/about?sent=0&why=invalid#contact");
  res = fakeResponse();
  await handle(fakeRequest({ body: "name=Ada&t=", headers: { ...formHeaders, referer: "https://soldenai.com/how-it-works" } }), res);
  assert.equal(res.headers.location, "/how-it-works?sent=0&why=invalid#contact");
});
