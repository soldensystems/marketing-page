// Railway runs this inside the deployment, using its existing private environment.
// Fail before traffic switches if required contact settings or additive schema setup fail.
// Never print configuration values, database errors, challenge tokens or email payloads.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contactConfiguration } from "../lib/contact.js";
import { createPgStore, sslOptionsFromEnv } from "../lib/store.js";

export async function runContactPreflight({ env = process.env, createStore = createPgStore } = {}) {
  if (!contactConfiguration(env) || !env.DATABASE_URL || !env.RESEND_API_KEY ||
      !String(env.LEAD_NOTIFY_TO || "").split(",").some((value) => value.trim())) {
    throw new Error("Required contact configuration is missing or invalid");
  }
  // createPgStore performs the same idempotent, additive initialization as runtime.
  // This creates no leads, sends no emails and does not read existing lead content.
  const store = await createStore(env.DATABASE_URL, { ssl: sslOptionsFromEnv(env) });
  await store.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const watchdog = setTimeout(() => {
    console.error("contact preflight: timed out; deployment blocked");
    process.exit(1);
  }, 30000);
  try {
    await runContactPreflight();
    console.log("contact preflight: required configuration and database schema ready");
  } catch {
    console.error("contact preflight: configuration or database unavailable; deployment blocked");
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
