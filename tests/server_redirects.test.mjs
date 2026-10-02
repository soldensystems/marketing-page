import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 18000 + Math.floor(Math.random() * 1000);

async function withServer(fn) {
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(port), RAILWAY_ENVIRONMENT: "" }, stdio: ["ignore", "pipe", "pipe"] });
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
