// POST /api/contact, mounted by server.js
//
// The handler is built immediately. Durable admission is attached lazily; a failed
// connection is forgotten and retried on the next request. No store means no email.
import { createContactHandler } from "../lib/contact.js";
import { createPgStore, sslOptionsFromEnv } from "../lib/store.js";

let storePromise = null;

function getStore() {
  if (!process.env.DATABASE_URL) return null;
  if (!storePromise) {
    storePromise = createPgStore(process.env.DATABASE_URL, { ssl: sslOptionsFromEnv(process.env) }).catch((error) => {
      console.error("contact: could not connect to Postgres; form unavailable");
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
