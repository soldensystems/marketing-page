import assert from "node:assert/strict";
import test from "node:test";
import { createStore, createPgStore } from "../lib/store.js";

const at = new Date("2026-10-05T12:00:00Z");
const limits = { ipPerHour: 5, recipientPerHour: 5, confirmationsPerHour: 20 };
const lead = {
  name: "Ada Lovelace", email: " ADA@example.com ", company: "Analytical Engines",
  message: "Four entities", source: "home", ip_hash: "hashed-ip", user_agent: "test",
};
const payloads = { team: { to: ["team@example.com"], text: "Lead 42" }, confirmation: { to: ["ada@example.com"], text: "Received" } };
const row = {
  id: "09f5d4c4-b849-41b1-b16c-2b4040fa8a21", lease_token: "b196de5a-0626-4fe4-ac7a-c8f8c4f93934",
  team_payload: payloads.team, confirmation_payload: payloads.confirmation,
  team_sent: false, confirmation_sent: false, leased: false, expired: false,
};

// Deliberately only a query/transaction double. Real PostgreSQL locking and
// concurrency are covered separately by contact_store.integration.test.mjs.
function fakePool({ existing, counts = {}, fail, rollbackFailure, rowCount = 1 } = {}) {
  const calls = [];
  const releases = [];
  const pool = {
    calls, releases, ended: false,
    async connect() { return { query: pool.query, release(error) { releases.push(error); } }; },
    async end() { pool.ended = true; },
    async query(sql, values) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: text, values });
      if (rollbackFailure && text === "ROLLBACK") throw rollbackFailure;
      if (fail?.(text)) throw new Error("simulated database failure");
      if (text === "SELECT clock_timestamp() AS at") return { rows: [{ at }] };
      if (text.startsWith("SELECT *,")) return { rows: existing ? [existing] : [] };
      if (text.startsWith("SELECT (SELECT count")) {
        return { rows: [{ ip: 0, recipient: 0, confirmations: 0, recipient_confirmed: false, attempts: 0, recipient_attempted: false, ...counts }] };
      }
      if (text.startsWith("INSERT INTO leads")) return { rows: [{ id: "42" }] };
      if (text.startsWith("INSERT INTO contact_submissions")) {
        return { rows: [{
          ...row, id: values[0], lease_token: values[8],
          team_payload: JSON.parse(values[6]), confirmation_payload: values[7] === null ? null : JSON.parse(values[7]),
        }] };
      }
      if (text.startsWith("UPDATE contact_submissions SET lease_token = $2")) {
        return { rows: [{ ...existing, lease_token: values[1] }] };
      }
      return { rows: [], rowCount };
    },
  };
  return pool;
}

function input(overrides = {}) {
  return { dedupKey: "request-hash", lead, limits, buildMessages: () => payloads, ...overrides };
}

function statements(pool, prefix) { return pool.calls.filter((call) => call.sql.startsWith(prefix)); }

test("store initialization preserves lead history and applies transaction bounds and lock", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  assert.equal(pool.calls[0].sql, "BEGIN");
  assert.match(pool.calls[1].sql, /statement_timeout = '3000ms'/);
  assert.match(pool.calls[1].sql, /lock_timeout = '2000ms'/);
  assert.match(pool.calls[1].sql, /idle_in_transaction_session_timeout = '5000ms'/);
  assert.match(pool.calls[2].sql, /pg_advisory_xact_lock/);
  const ddl = pool.calls[3].sql;
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS leads/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS contact_submissions/);
  assert.doesNotMatch(ddl, /DROP |TRUNCATE |DELETE /i);
  assert.equal(pool.calls.at(-1).sql, "COMMIT");
  assert.equal(pool.releases.length, 1);
  await store.close();
  assert.equal(pool.ended, true);
});

test("fresh admission persists one normalized lead and immutable email payload pair before returning claim", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  let built = 0;
  const claim = await store.claimSubmission(input({ buildMessages(id) { built += 1; assert.equal(id, "42"); return payloads; } }));
  assert.equal(claim.status, "claimed");
  assert.match(claim.id, /^[0-9a-f-]{36}$/);
  assert.match(claim.leaseToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual(claim.team, payloads.team);
  assert.deepEqual(claim.confirmation, payloads.confirmation);
  assert.equal(claim.teamSent, false);
  assert.equal(claim.confirmationSent, false);
  assert.equal(built, 1);
  assert.equal(statements(pool, "INSERT INTO leads").length, 1);
  assert.equal(statements(pool, "INSERT INTO leads")[0].values[1], "ada@example.com");
  const admission = statements(pool, "INSERT INTO contact_submissions")[0];
  assert.equal(admission.values[2], at);
  assert.equal(admission.values[4], "ada@example.com");
  assert.match(admission.sql, /interval '24 hours'/);
  assert.match(admission.sql, /interval '23 hours'/);
  assert.match(admission.sql, /interval '30 seconds'/);
  assert.equal(pool.calls.at(-1).sql, "COMMIT");
});

for (const counts of [{ ip: 5 }, { recipient: 5 }]) {
  test(`admission cap is atomic and creates no lead: ${JSON.stringify(counts)}`, async () => {
    const pool = fakePool({ counts });
    const store = await createStore(pool);
    assert.deepEqual(await store.claimSubmission(input({ buildMessages() { assert.fail("must not build rejected messages"); } })), { status: "limited" });
    assert.equal(statements(pool, "INSERT INTO").length, 0);
    assert.equal(pool.calls.at(-1).sql, "COMMIT");
  });
}

for (const counts of [{ confirmations: 20 }, { recipient_confirmed: true }]) {
  test(`confirmation budget suppresses only the prospect email: ${JSON.stringify(counts)}`, async () => {
    const pool = fakePool({ counts });
    const store = await createStore(pool);
    const claim = await store.claimSubmission(input());
    assert.equal(claim.status, "claimed");
    assert.deepEqual(claim.team, payloads.team);
    assert.equal(claim.confirmation, null);
    assert.equal(statements(pool, "INSERT INTO contact_submissions")[0].values[7], null);
  });
}

test("zero confirmation budget supports disabling prospect emails", async () => {
  const store = await createStore(fakePool());
  const claim = await store.claimSubmission(input({ limits: { ...limits, confirmationsPerHour: 0 } }));
  assert.equal(claim.confirmation, null);
});

for (const [status, existing] of [
  ["complete", { ...row, team_sent: true, confirmation_sent: true, expired: true, leased: true }],
  ["complete", { ...row, team_sent: true, confirmation_payload: null }],
  ["busy", { ...row, leased: true }],
  ["expired", { ...row, expired: true }],
  ["expired", { ...row, expired: true, leased: true }],
  ["complete", { ...row, team_sent: true, expired: true }],
]) {
  test(`deduplicated ${status} submission is not readmitted or rebuilt (${JSON.stringify(existing)})`, async () => {
    const pool = fakePool({ existing });
    const store = await createStore(pool);
    const result = await store.claimSubmission(input({ buildMessages() { assert.fail("duplicate payload must not change"); } }));
    assert.deepEqual(result, { status });
    assert.equal(statements(pool, "INSERT INTO").length, 0);
    assert.equal(statements(pool, "UPDATE contact_submissions").length, 0);
    assert.equal(statements(pool, "SELECT (SELECT count").length, 0);
    assert.match(statements(pool, "SELECT *,")[0].sql, /dedup_until > \$2::timestamptz OR team_sent = false/);
  });
}

test("retry keeps submission ID, payload and per-email flags but replaces the lease token", async () => {
  const existing = { ...row, team_sent: true };
  const pool = fakePool({ existing, counts: { ip: 999 } });
  const store = await createStore(pool);
  const claim = await store.claimSubmission(input({ buildMessages() { assert.fail("retry must use the original snapshot"); } }));
  assert.equal(claim.status, "claimed");
  assert.equal(claim.id, row.id);
  assert.notEqual(claim.leaseToken, row.lease_token);
  assert.deepEqual(claim.team, row.team_payload);
  assert.deepEqual(claim.confirmation, row.confirmation_payload);
  assert.equal(claim.teamSent, true);
  assert.equal(claim.confirmationSent, false);
  assert.equal(statements(pool, "INSERT INTO").length, 0);
});

test("payload construction failure rolls back the lead and always releases the client", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  await assert.rejects(store.claimSubmission(input({ buildMessages() { throw new Error("render failed"); } })), /render failed/);
  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
  assert.equal(statements(pool, "COMMIT").length, 1, "only initialization committed");
  assert.equal(pool.releases.length, 2);
});

test("asynchronous payload builders cannot silently persist a different retry payload", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  await assert.rejects(store.claimSubmission(input({ buildMessages: async () => payloads })), /synchronous email payloads/);
  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
});

test("database errors and uncertain commits fail closed", async () => {
  for (const prefix of ["SELECT clock_timestamp", "SELECT *,", "SELECT (SELECT count", "INSERT INTO leads", "INSERT INTO contact_submissions", "COMMIT"]) {
    let reject = false;
    const pool = fakePool({ fail: (sql) => reject && sql.startsWith(prefix) });
    const store = await createStore(pool);
    reject = true;
    await assert.rejects(store.claimSubmission(input()), /simulated database failure/);
    assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
    assert.equal(pool.releases.length, 2);
  }
});

test("rollback failure discards the client instead of returning a poisoned connection to the pool", async () => {
  const rollbackError = new Error("connection lost");
  const pool = fakePool({ fail: (sql) => sql.startsWith("CREATE TABLE"), rollbackFailure: rollbackError });
  await assert.rejects(createStore(pool), /simulated database failure/);
  assert.deepEqual(pool.releases, [rollbackError]);
});

test("markSent checks ownership, expiry, kind and team delivery ordering", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  assert.equal(await store.markSent(row.id, row.lease_token, "team"), true);
  let query = pool.calls.at(-1);
  assert.match(query.sql, /SET team_sent = true/);
  assert.match(query.sql, /lease_token = \$2 AND lease_until > clock_timestamp\(\)/);
  assert.deepEqual(query.values, [row.id, row.lease_token]);
  assert.equal(await store.markSent(row.id, row.lease_token, "confirmation"), true);
  query = pool.calls.at(-1);
  assert.match(query.sql, /confirmation_payload IS NOT NULL AND team_sent = true/);
  await assert.rejects(store.markSent(row.id, row.lease_token, "team_sent; DROP TABLE leads"), /Unknown contact email kind/);
  const stale = await createStore(fakePool({ rowCount: 0 }));
  assert.equal(await stale.markSent(row.id, row.lease_token, "team"), false);
  assert.equal(await stale.finishSubmission(row.id, row.lease_token), false);
});

test("finishSubmission releases only the owned lease without clearing per-email flags", async () => {
  const pool = fakePool();
  const store = await createStore(pool);
  assert.equal(await store.finishSubmission(row.id, row.lease_token), true);
  const query = pool.calls.at(-1);
  assert.match(query.sql, /SET lease_token = NULL, lease_until = NULL WHERE id = \$1 AND lease_token = \$2/);
  assert.doesNotMatch(query.sql, /team_sent|confirmation_sent/);
});

test("invalid store input and missing database URL fail closed", async () => {
  const store = await createStore(fakePool());
  for (const invalid of [
    { dedupKey: "" }, { lead: { ...lead, ip_hash: "" } }, { lead: { ...lead, email: "" } },
    { limits: { ...limits, ipPerHour: 0 } }, { limits: { ...limits, recipientPerHour: NaN } },
    { limits: { ...limits, confirmationsPerHour: Infinity } }, { limits: { ...limits, confirmationsPerHour: -1 } },
  ]) await assert.rejects(store.claimSubmission(input(invalid)), /Invalid contact admission/);
  await assert.rejects(createPgStore(""), /DATABASE_URL is required/);
});

test("createPgStore bounds pool operations and closes its pool after initialization failure", async () => {
  const { default: pg } = await import("pg");
  const OriginalPool = pg.Pool;
  const pool = fakePool({ fail: (sql) => sql.startsWith("CREATE TABLE") });
  let options;
  let idleErrorHandler;
  pg.Pool = class {
    constructor(config) {
      options = config;
      Object.assign(this, pool);
    }
    on(name, handler) { if (name === "error") idleErrorHandler = handler; }
  };
  try {
    await assert.rejects(createPgStore("postgresql://test.invalid/test", { ssl: true }), /simulated database failure/);
    assert.equal(pool.ended, true);
    assert.equal(options.connectionTimeoutMillis, 2000);
    assert.equal(options.statement_timeout, 3000);
    assert.equal(options.query_timeout, 4000);
    assert.equal(options.idle_in_transaction_session_timeout, 5000);
    assert.equal(options.ssl, true);
    const originalError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args.join(" "));
    try {
      idleErrorHandler(new Error("postgresql://username:DO_NOT_LOG@example.test/db"));
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(logs, ["contact: idle Postgres client errored"]);
  } finally {
    pg.Pool = OriginalPool;
  }
});

test("confirmation dispatch acquires a shared transaction and refreshes an existing permit", async () => {
  for (const recent_attempt of [false, true]) {
    const pool = fakePool({ existing: { ...row, team_sent: true, leased: true, recent_attempt, normalized_email: "ada@example.com" } });
    const store = await createStore(pool);
    assert.equal(await store.authorizeConfirmation(row.id, row.lease_token, 20), true);
    const update = statements(pool, "UPDATE contact_submissions SET confirmation_attempted_at")[0];
    assert.deepEqual(update.values, [row.id, row.lease_token, at]);
    assert.match(update.sql, /lease_until > clock_timestamp\(\)/);
    assert.match(update.sql, /retry_until > clock_timestamp\(\)/);
    assert.equal(statements(pool, "SELECT (SELECT count").length, recent_attempt ? 0 : 1);
    assert.equal(pool.calls.at(-1).sql, "COMMIT");
  }
});

for (const counts of [{ attempts: 20 }, { recipient_attempted: true }]) {
  test(`dispatch-time cap leaves the confirmation pending: ${JSON.stringify(counts)}`, async () => {
    const pool = fakePool({ existing: { ...row, team_sent: true, leased: true, recent_attempt: false }, counts });
    const store = await createStore(pool);
    assert.equal(await store.authorizeConfirmation(row.id, row.lease_token, 20), false);
    assert.equal(statements(pool, "UPDATE contact_submissions").length, 0);
  });
}

test("dispatch refuses stale, expired, unsent-team or already-sent confirmation leases and honours an off switch", async () => {
  for (const existing of [
    undefined, { ...row, leased: true }, { ...row, team_sent: true, leased: false },
    { ...row, team_sent: true, leased: true, expired: true },
    { ...row, team_sent: true, leased: true, confirmation_sent: true },
    { ...row, team_sent: true, leased: true, confirmation_payload: null },
  ]) {
    const pool = fakePool({ existing });
    const store = await createStore(pool);
    assert.equal(await store.authorizeConfirmation(row.id, row.lease_token, 20), false);
    assert.equal(statements(pool, "UPDATE contact_submissions").length, 0);
  }
  const pool = fakePool({ existing: { ...row, team_sent: true, leased: true, recent_attempt: true } });
  const store = await createStore(pool);
  assert.equal(await store.authorizeConfirmation(row.id, row.lease_token, 0), false);
  assert.equal(statements(pool, "UPDATE contact_submissions").length, 0);
  await assert.rejects(store.authorizeConfirmation(row.id, row.lease_token, -1), /Invalid confirmation dispatch limit/);
});
