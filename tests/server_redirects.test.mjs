import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 18000 + Math.floor(Math.random() * 1000);

async function withServer(fn, env = {}) {
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(port), RAILWAY_ENVIRONMENT: "", NODE_ENV: "test", DATABASE_URL: "", RESEND_API_KEY: "", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

test("every redirect stays on the site, whatever the path looks like", async () => {
  await withServer(async (base) => {
    for (const p of ["//evil.example/", "/%2Fevil.example/", "//evil.example/x.html", "/%5Cevil.example/", "/\\\\evil.example/", "///evil.example/a/", "/about/", "/about.html"]) {
      const res = await fetch(base + p, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") || "";
        assert.match(loc, /^\/(?![\/\\])/, `${p} redirects to ${loc}, which must be a path on this site`);
      }
    }
    const about = await fetch(base + "/about/", { redirect: "manual" });
    assert.equal(about.headers.get("location"), "/about", "a trailing slash still redirects to the clean URL");
  });
});


test("public contact config returns only a public key/action and fails closed when missing", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/contact-config");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
  await withServer(async (base) => {
    const res = await fetch(base + "/api/contact-config");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { siteKey: "test-public-site", action: "contact" });
    const malformed = await fetch(base + "/api/contact", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://soldenai.com" },
      body: JSON.stringify({ name: { toString: 0 }, email: "test@example.com", company: "Test", message: "Test only", t: "8500" }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(base + "/healthz")).status, 200, "host survives malformed field objects");
    const invalidJson = await fetch(base + "/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    assert.equal(invalidJson.status, 400);
    assert.match(invalidJson.headers.get("content-type"), /application\/json/);
  }, { TURNSTILE_SITE_KEY: "test-public-site", TURNSTILE_SECRET_KEY: "server-only-test-secret" });
});
