import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createStore } from "../lib/store.js";

// Intentionally never falls back to DATABASE_URL or reads deployment secrets.
// Use a disposable test database. Each case owns a random schema and drops only
// that schema. No production tables, database names or provider APIs are used.
const databaseUrl = process.env.TEST_DATABASE_URL;
const limits = { ipPerHour: 50, recipientPerHour: 50, confirmationsPerHour: 20 };

function submission(index, options = {}) {
  return {
    dedupKey: `dedup-${index}`,
    lead: {
      name: "Test Visitor", email: `visitor-${index}@example.test`, company: "Test Company",
      message: `Request ${index}`, source: "integration-test", ip_hash: `hashed-ip-${index}`, user_agent: "integration-test",
      ...options.lead,
    },
    limits: { ...limits, ...options.limits },
    buildMessages: options.buildMessages || ((id) => ({
      team: { to: ["team@example.test"], subject: "Request", text: `Lead ${id}` },
      confirmation: { to: ["visitor@example.test"], text: "Received" },
    })),
  };
}

async function isolatedDatabase(t, { legacy = false } = {}) {
  const { default: pg } = await import("pg");
  const schema = `contact_test_${randomUUID().replaceAll("-", "")}`;
  const settings = {
    connectionString: databaseUrl, connectionTimeoutMillis: 2000,
    statement_timeout: 3000, query_timeout: 4000, idle_in_transaction_session_timeout: 5000,
  };
  const admin = new pg.Pool({ ...settings, max: 1 });
  const pools = [];
  t.after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const makePool = () => {
    const pool = new pg.Pool({ ...settings, max: 8, options: `-c search_path=${schema},pg_catalog` });
    pool.on("error", () => {}); // Individual queries retain and assert failures.
    pools.push(pool);
    return pool;
  };
  const a = makePool();
  const b = makePool();
  if (legacy) {
    await a.query(`
      CREATE TABLE leads (
        id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        name TEXT NOT NULL, email TEXT NOT NULL, company TEXT, message TEXT,
        source TEXT NOT NULL DEFAULT 'soldenai.com', ip_hash TEXT, user_agent TEXT,
        legacy_extra TEXT DEFAULT 'preserved'
      );
      INSERT INTO leads (name, email) VALUES ('Existing lead', 'history@example.test');
    `);
  }
  const stores = await Promise.all([createStore(a), createStore(b)]);
  return { stores, pool: a, makePool };
}

const enabled = typeof databaseUrl === "string" && databaseUrl.trim() !== "";
test("Postgres contact admission and delivery integration", {
  skip: enabled ? false : "Set TEST_DATABASE_URL to a dedicated disposable Postgres database",
  timeout: 120_000,
}, async (t) => {
  await t.test("concurrent schema initialization preserves previous leads and extra columns", async (t) => {
    const { stores, pool } = await isolatedDatabase(t, { legacy: true });
    const before = await pool.query("SELECT * FROM leads");
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].email, "history@example.test");
    assert.equal(before.rows[0].legacy_extra, "preserved");
    assert.equal((await stores[0].claimSubmission(submission(1))).status, "claimed");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 2);
  });

  await t.test("independent workers admit an identical burst exactly once", async (t) => {
    const { stores, pool } = await isolatedDatabase(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(1))));
    assert.equal(results.filter((r) => r.status === "claimed").length, 1);
    assert.equal(results.filter((r) => r.status === "busy").length, 19);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM contact_submissions")).rows[0].n, 1);
  });

  await t.test("independent workers cannot exceed the shared per-IP sliding-hour cap", async (t) => {
    const { stores, pool } = await isolatedDatabase(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(i, {
      lead: { ip_hash: "one-source" }, limits: { ipPerHour: 3 },
    }))));
    assert.equal(results.filter((r) => r.status === "claimed").length, 3);
    assert.equal(results.filter((r) => r.status === "limited").length, 17);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 3);
  });

  await t.test("rotated IPs and letter casing cannot exceed the shared recipient cap", async (t) => {
    const { stores } = await isolatedDatabase(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(i, {
      lead: { email: i % 2 ? " SAME@example.test " : "same@example.test" }, limits: { recipientPerHour: 3 },
    }))));
    const claims = results.filter((r) => r.status === "claimed");
    assert.equal(claims.length, 3);
    assert.equal(results.filter((r) => r.status === "limited").length, 17);
    assert.equal(claims.filter((r) => r.confirmation !== null).length, 1);
  });

  await t.test("global confirmation reservation is atomic without suppressing team deliveries", async (t) => {
    const { stores, pool } = await isolatedDatabase(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(i, {
      limits: { confirmationsPerHour: 3 },
    }))));
    assert.ok(results.every((r) => r.status === "claimed" && r.team));
    assert.equal(results.filter((r) => r.confirmation !== null).length, 3);
    const reserved = await pool.query("SELECT count(*)::int AS n FROM contact_submissions WHERE confirmation_reserved_at IS NOT NULL");
    assert.equal(reserved.rows[0].n, 3);
  });

  await t.test("sliding-hour caps expire but one-recipient confirmation protection lasts 24 hours", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const options = { lead: { email: "same@example.test", ip_hash: "same-ip" }, limits: { ipPerHour: 1, recipientPerHour: 1, confirmationsPerHour: 1 } };
    const first = await store.claimSubmission(submission(1, options));
    assert.ok(first.confirmation);
    assert.equal((await store.claimSubmission(submission(2, options))).status, "limited");
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '65 minutes', confirmation_reserved_at = now() - interval '65 minutes' WHERE id = $1", [first.id]);
    const second = await store.claimSubmission(submission(2, options));
    assert.equal(second.status, "claimed");
    assert.equal(second.confirmation, null);
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '25 hours', confirmation_reserved_at = CASE WHEN confirmation_payload IS NULL THEN NULL ELSE now() - interval '25 hours' END");
    const third = await store.claimSubmission(submission(3, options));
    assert.equal(third.status, "claimed");
    assert.ok(third.confirmation);
  });

  await t.test("fresh worker retries the original payload and only the pending email after partial success", async (t) => {
    const { stores: [store], pool, makePool } = await isolatedDatabase(t);
    const request = submission(1);
    const first = await store.claimSubmission(request);
    assert.equal(await store.markSent(first.id, first.leaseToken, "confirmation"), false, "team must be recorded first");
    assert.equal(await store.markSent(first.id, first.leaseToken, "team"), true);
    assert.equal(await store.finishSubmission(first.id, first.leaseToken), true);
    const restarted = await createStore(makePool());
    const retry = await restarted.claimSubmission({ ...request, buildMessages() { assert.fail("must keep exact original messages after restart"); } });
    assert.equal(retry.status, "claimed");
    assert.equal(retry.id, first.id);
    assert.notEqual(retry.leaseToken, first.leaseToken);
    assert.equal(retry.teamSent, true);
    assert.equal(retry.confirmationSent, false);
    assert.deepEqual(retry.team, first.team);
    assert.deepEqual(retry.confirmation, first.confirmation);
    assert.equal(await restarted.markSent(retry.id, retry.leaseToken, "confirmation"), true);
    assert.equal(await restarted.finishSubmission(retry.id, retry.leaseToken), true);
    assert.deepEqual(await store.claimSubmission(request), { status: "complete" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 1);
  });

  await t.test("expired leases can be reclaimed once and stale workers cannot mark or release them", async (t) => {
    const { stores, pool } = await isolatedDatabase(t);
    const first = await stores[0].claimSubmission(submission(1));
    await pool.query("UPDATE contact_submissions SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [first.id]);
    assert.equal(await stores[0].markSent(first.id, first.leaseToken, "team"), false);
    const results = await Promise.all(stores.map((store) => store.claimSubmission(submission(1))));
    const second = results.find((result) => result.status === "claimed");
    assert.ok(second);
    assert.equal(results.filter((result) => result.status === "busy").length, 1);
    assert.equal(second.id, first.id);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(await stores[0].markSent(first.id, first.leaseToken, "team"), false);
    assert.equal(await stores[0].finishSubmission(first.id, first.leaseToken), false);
    assert.equal(await stores[1].markSent(second.id, second.leaseToken, "team"), true);
  });

  await t.test("uncertain deliveries never restart beyond the provider idempotency safety window", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const first = await store.claimSubmission(submission(1));
    await pool.query("UPDATE contact_submissions SET lease_until = now() - interval '1 second', retry_until = now() - interval '1 second' WHERE id = $1", [first.id]);
    assert.deepEqual(await store.claimSubmission(submission(1)), { status: "expired" });
    // Even after all normal dedup/rate windows, an uncertain team send must
    // never receive a fresh provider key merely because the browser retries.
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '25 hours', dedup_until = now() - interval '1 hour', confirmation_reserved_at = now() - interval '25 hours' WHERE id = $1", [first.id]);
    assert.deepEqual(await store.claimSubmission(submission(1)), { status: "expired" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 1);
  });

  await t.test("expired optional confirmations do not reopen a recorded team delivery", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const first = await store.claimSubmission(submission(1));
    await store.markSent(first.id, first.leaseToken, "team");
    await store.finishSubmission(first.id, first.leaseToken);
    await pool.query("UPDATE contact_submissions SET retry_until = now() - interval '1 second' WHERE id = $1", [first.id]);
    assert.deepEqual(await store.claimSubmission(submission(1)), { status: "complete" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 1);
  });

  await t.test("completed admissions deduplicate for 24 hours, then accept a fresh request", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const first = await store.claimSubmission(submission(1));
    await store.markSent(first.id, first.leaseToken, "team");
    await store.markSent(first.id, first.leaseToken, "confirmation");
    await store.finishSubmission(first.id, first.leaseToken);
    assert.deepEqual(await store.claimSubmission(submission(1)), { status: "complete" });
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '25 hours', dedup_until = now() - interval '1 hour', retry_until = now() - interval '2 hours', confirmation_reserved_at = now() - interval '25 hours' WHERE id = $1", [first.id]);
    const next = await store.claimSubmission(submission(1));
    assert.equal(next.status, "claimed");
    assert.notEqual(next.id, first.id);
    assert.ok(next.confirmation);
  });

  await t.test("a rendering failure rolls back the lead and every reserved budget", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    await assert.rejects(store.claimSubmission(submission(1, { buildMessages() { throw new Error("render failed"); } })), /render failed/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM contact_submissions")).rows[0].n, 0);
    assert.equal((await store.claimSubmission(submission(1))).status, "claimed");
  });
  await t.test("old reservations and fresh requests share the actual dispatch-hour budget", async (t) => {
    const { stores, pool } = await isolatedDatabase(t);
    const old = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(i))));
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '2 hours', confirmation_reserved_at = now() - interval '2 hours'");
    const fresh = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claimSubmission(submission(20 + i))));
    const claims = [...old, ...fresh];
    assert.ok(claims.every((claim) => claim.status === "claimed" && claim.confirmation));
    await Promise.all(claims.map((claim, i) => stores[i % 2].markSent(claim.id, claim.leaseToken, "team")));
    const allowed = await Promise.all(claims.map((claim, i) => stores[i % 2].authorizeConfirmation(claim.id, claim.leaseToken, 3)));
    assert.equal(allowed.filter(Boolean).length, 3);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM contact_submissions WHERE confirmation_attempted_at IS NOT NULL")).rows[0].n, 3);
  });

  await t.test("idempotent retries refresh their dispatch slot and expired permits must requalify", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const [first, second, third] = await Promise.all([1, 2, 3].map((i) => store.claimSubmission(submission(i))));
    for (const claim of [first, second, third]) await store.markSent(claim.id, claim.leaseToken, "team");
    assert.equal(await store.authorizeConfirmation(first.id, first.leaseToken, 2), true);
    assert.equal(await store.authorizeConfirmation(second.id, second.leaseToken, 2), true);
    await pool.query("UPDATE contact_submissions SET confirmation_attempted_at = now() - interval '55 minutes' WHERE id = $1", [first.id]);
    assert.equal(await store.authorizeConfirmation(first.id, first.leaseToken, 2), true);
    const refreshed = (await pool.query("SELECT confirmation_attempted_at > now() - interval '5 seconds' AS recent FROM contact_submissions WHERE id = $1", [first.id])).rows[0];
    assert.equal(refreshed.recent, true);
    assert.equal(await store.authorizeConfirmation(third.id, third.leaseToken, 2), false);
    assert.equal(await store.authorizeConfirmation(first.id, first.leaseToken, 0), false);
    await pool.query("UPDATE contact_submissions SET confirmation_attempted_at = now() - interval '61 minutes' WHERE id = $1", [first.id]);
    assert.equal(await store.authorizeConfirmation(first.id, first.leaseToken, 1), false);
  });

  await t.test("recipient dispatch protection follows delivery time after a delayed first attempt", async (t) => {
    const { stores: [store], pool } = await isolatedDatabase(t);
    const first = await store.claimSubmission(submission(1, { lead: { email: "same@example.test" } }));
    await store.markSent(first.id, first.leaseToken, "team");
    assert.equal(await store.authorizeConfirmation(first.id, first.leaseToken, 20), true);
    // Model the later point when the initial reservation is more than a day
    // old, but a delayed actual delivery attempt was only three hours ago.
    await pool.query("UPDATE contact_submissions SET created_at = now() - interval '25 hours', confirmation_reserved_at = now() - interval '25 hours', confirmation_attempted_at = now() - interval '3 hours' WHERE id = $1", [first.id]);
    const second = await store.claimSubmission(submission(2, { lead: { email: "same@example.test" } }));
    assert.ok(second.confirmation);
    await store.markSent(second.id, second.leaseToken, "team");
    assert.equal(await store.authorizeConfirmation(second.id, second.leaseToken, 20), false);
    const saved = (await pool.query("SELECT confirmation_sent, confirmation_attempted_at FROM contact_submissions WHERE id = $1", [second.id])).rows[0];
    assert.equal(saved.confirmation_sent, false);
    assert.equal(saved.confirmation_attempted_at, null);
  });

});
