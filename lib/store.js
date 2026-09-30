// Optional Postgres persistence for contact submissions.
// Uses the same `leads` table the previous site created, so history stays continuous.
// Only loaded when DATABASE_URL is set.
//
// Every timeout is short on purpose: the store is a record of the lead, not its
// delivery path, and the handler must never wait on a slow database.

const CONNECTION_TIMEOUT_MS = 2000;
const IDLE_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 3000;

// TLS settings from the environment:
// - DB_SSL=true            encrypt and verify the server certificate (default when TLS is on)
// - DB_SSL_CA=<PEM>        verify against this certificate authority (implies TLS)
// - DB_SSL_NO_VERIFY=true  encrypt but skip verification, for providers that present a
//                          self-signed certificate such as Railway's public TCP proxy (implies TLS)
export function sslOptionsFromEnv(env = process.env) {
  const ca = String(env.DB_SSL_CA || "").trim();
  if (ca) return { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  if (env.DB_SSL_NO_VERIFY === "true") return { rejectUnauthorized: false };
  if (env.DB_SSL === "true") return true;
  return undefined;
}

export async function createPgStore(databaseUrl, { ssl } = {}) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    max: 2,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error("contact: idle Postgres client errored", error?.message || error);
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      message TEXT,
      source TEXT NOT NULL DEFAULT 'soldenai.com',
      ip_hash TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS leads_ip_hash_created_at_idx ON leads (ip_hash, created_at);
  `);

  return {
    async insertLead(lead) {
      const result = await pool.query(
        `INSERT INTO leads (name, email, company, message, source, ip_hash, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [lead.name, lead.email, lead.company, lead.message, lead.source, lead.ip_hash, lead.user_agent]
      );
      return result.rows[0].id;
    },
    async countRecent(ipHash) {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM leads WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
        [ipHash]
      );
      return result.rows[0].n;
    },
    async close() {
      await pool.end();
    },
  };
}
