import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runContactPreflight } from "../scripts/contact-preflight.mjs";

const env = {
  TURNSTILE_SITE_KEY: "test-site", TURNSTILE_SECRET_KEY: "test-secret",
  DATABASE_URL: "postgres://test-only", RESEND_API_KEY: "test-only", LEAD_NOTIFY_TO: "team@example.test",
};

test("release preflight initializes and closes the durable store without any email operation", async () => {
  let closed = false;
  await runContactPreflight({ env, createStore: async (url, options) => {
    assert.equal(url, env.DATABASE_URL); assert.deepEqual(options, { ssl: undefined });
    return { close: async () => { closed = true; } };
  } });
  assert.equal(closed, true);
});

test("release preflight blocks incomplete or invalid configuration before opening the database", async () => {
  for (const name of Object.keys(env)) {
    let connected = false;
    await assert.rejects(runContactPreflight({ env: { ...env, [name]: "" }, createStore: async () => { connected = true; } }));
    assert.equal(connected, false);
  }
  await assert.rejects(runContactPreflight({ env: { ...env, CONTACT_ALLOWED_ORIGINS: "http://soldenai.com" } }));
  await assert.rejects(runContactPreflight({ env: { ...env, NODE_ENV: "production", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" } }));
});

test("release preflight propagates connection, schema and close failures to block deployment", async () => {
  for (const createStore of [
    async () => { throw new Error("connection failed"); },
    async () => { throw new Error("schema permission denied"); },
    async () => ({ close: async () => { throw new Error("close failed"); } }),
  ]) await assert.rejects(runContactPreflight({ env, createStore }));
});

test("Railway executes preflight before starting the service, with a sanitized failure result", () => {
  const railway = JSON.parse(readFileSync(new URL("../railway.json", import.meta.url)));
  assert.deepEqual(railway.deploy.preDeployCommand, ["node scripts/contact-preflight.mjs"]);
  const result = spawnSync(process.execPath, ["scripts/contact-preflight.mjs"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", env: { PATH: process.env.PATH, TURNSTILE_SECRET_KEY: "must-not-appear" }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment blocked/);
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-appear/);
});
