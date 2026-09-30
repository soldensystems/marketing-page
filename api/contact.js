// Vercel serverless function: POST /api/contact
//
// The handler is built immediately so a request never waits on Postgres. The store is
// attached lazily on the first request that needs it; a failed connection is logged,
// forgotten, and retried on the next request rather than memoised for the instance.
import { createContactHandler } from "../lib/contact.js";
import { createPgStore, sslOptionsFromEnv } from "../lib/store.js";

let storePromise = null;

function getStore() {
  if (!process.env.DATABASE_URL) return null;
  if (!storePromise) {
    storePromise = createPgStore(process.env.DATABASE_URL, { ssl: sslOptionsFromEnv(process.env) }).catch((error) => {
      console.error("contact: could not connect to Postgres, continuing without storage", error?.message || error);
      storePromise = null;
      return null;
    });
  }
  return storePromise;
}

const handle = createContactHandler({ getStore });

export default function handler(req, res) {
  return handle(req, res);
}
