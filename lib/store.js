// Durable admission and delivery state for contact submissions. Every worker uses
// the same short Postgres transaction to reserve rate limits, deduplication and
// confirmation budgets. A database failure must never turn into an email send.
import { randomUUID } from "node:crypto";

const CONNECTION_TIMEOUT_MS = 2000;
const IDLE_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 3000;
const QUERY_TIMEOUT_MS = 4000;
const IDLE_TRANSACTION_TIMEOUT_MS = 5000;
// Stable, application-specific pair. This serialises only this low-volume form.
const ADMISSION_LOCK = [1936681068, 1129270868];

// TLS settings from the environment:
// - DB_SSL=true            encrypt and verify the server certificate
// - DB_SSL_CA=<PEM>        verify against this certificate authority (implies TLS)
// - DB_SSL_NO_VERIFY=true  encrypt without verification, for a self-signed proxy
export function sslOptionsFromEnv(env = process.env) {
  const ca = String(env.DB_SSL_CA || "").trim();
  if (ca) return { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  if (env.DB_SSL_NO_VERIFY === "true") return { rejectUnauthorized: false };
  if (env.DB_SSL === "true") return true;
  return undefined;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    // Set these here as well as on the production pool: injected pools and each
    // new transaction get the same bounded lock/statement/idle behaviour.
    await client.query(`
      SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms';
      SET LOCAL lock_timeout = '${CONNECTION_TIMEOUT_MS}ms';
      SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TRANSACTION_TIMEOUT_MS}ms';
    `);
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", ADMISSION_LOCK);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function claimed(row) {
  return {
    status: "claimed",
    id: row.id,
    leaseToken: row.lease_token,
    team: row.team_payload,
    confirmation: row.confirmation_payload,
    teamSent: row.team_sent,
    confirmationSent: row.confirmation_sent,
  };
}

function validateClaim({ dedupKey, lead, buildMessages, limits }) {
  if (typeof dedupKey !== "string" || !dedupKey ||
      typeof lead?.email !== "string" || !lead.email.trim() ||
      typeof lead?.ip_hash !== "string" || !lead.ip_hash ||
      typeof buildMessages !== "function") {
    throw new TypeError("Invalid contact admission request");
  }
  for (const key of ["ipPerHour", "recipientPerHour", "confirmationsPerHour"]) {
    const minimum = key === "confirmationsPerHour" ? 0 : 1;
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < minimum) {
      throw new TypeError(`Invalid contact admission limit: ${key}`);
    }
  }
}

// Accept an injected pg-compatible pool for integration tests. The caller owns
// the pool if initialization fails; createPgStore below always cleans up its own.
export async function createStore(pool) {
  await transaction(pool, async (client) => {
    // Keep the original table and its history. Delivery state has its own table.
    await client.query(`
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
      CREATE TABLE IF NOT EXISTS contact_submissions (
        id UUID PRIMARY KEY,
        lead_id BIGINT NOT NULL REFERENCES leads(id),
        created_at TIMESTAMPTZ NOT NULL,
        dedup_key TEXT NOT NULL,
        dedup_until TIMESTAMPTZ NOT NULL,
        retry_until TIMESTAMPTZ NOT NULL,
        normalized_email TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        team_payload JSONB NOT NULL,
        confirmation_payload JSONB,
        confirmation_reserved_at TIMESTAMPTZ,
        confirmation_attempted_at TIMESTAMPTZ,
        team_sent BOOLEAN NOT NULL DEFAULT false,
        confirmation_sent BOOLEAN NOT NULL DEFAULT false,
        lease_token UUID,
        lease_until TIMESTAMPTZ,
        CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
        CHECK ((confirmation_payload IS NULL) = (confirmation_reserved_at IS NULL))
      );
      ALTER TABLE contact_submissions
        ADD COLUMN IF NOT EXISTS confirmation_attempted_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS contact_submissions_attempted_idx
        ON contact_submissions (confirmation_attempted_at)
        WHERE confirmation_attempted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS contact_submissions_recipient_attempted_idx
        ON contact_submissions (normalized_email, confirmation_attempted_at)
        WHERE confirmation_attempted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS contact_submissions_dedup_idx
        ON contact_submissions (dedup_key, dedup_until);
      CREATE INDEX IF NOT EXISTS contact_submissions_ip_created_idx
        ON contact_submissions (ip_hash, created_at);
      CREATE INDEX IF NOT EXISTS contact_submissions_email_created_idx
        ON contact_submissions (normalized_email, created_at);
      CREATE INDEX IF NOT EXISTS contact_submissions_confirmation_idx
        ON contact_submissions (confirmation_reserved_at)
        WHERE confirmation_reserved_at IS NOT NULL;
    `);
  });

  return {
    async claimSubmission(input) {
      validateClaim(input);
      const { dedupKey, lead, buildMessages, limits } = input;
      const email = lead.email.trim().toLowerCase();
      return transaction(pool, async (client) => {
        // Capture server time after waiting for the lock. Browser clocks and
        // different workers' clocks cannot reset or shift admission windows.
        const { rows: [clock] } = await client.query("SELECT clock_timestamp() AS at");
        const at = clock.at;
        const { rows: [existing] } = await client.query(
          `SELECT *, lease_until > $2::timestamptz AS leased,
                     retry_until <= $2::timestamptz AS expired
           FROM contact_submissions
           WHERE dedup_key = $1 AND (dedup_until > $2::timestamptz OR team_sent = false)
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [dedupKey, at]
        );
        if (existing) {
          if (existing.team_sent && (!existing.confirmation_payload || existing.confirmation_sent)) {
            return { status: "complete" };
          }
          // A team delivery with an uncertain outcome must not be given a new
          // provider key after the safe retry window. Optional confirmations
          // may expire once the team delivery is already recorded.
          if (existing.expired) return { status: existing.team_sent ? "complete" : "expired" };
          if (existing.leased) return { status: "busy" };
          const { rows: [row] } = await client.query(
            `UPDATE contact_submissions
             SET lease_token = $2, lease_until = $3::timestamptz + interval '30 seconds'
             WHERE id = $1 RETURNING *`,
            [existing.id, randomUUID(), at]
          );
          return claimed(row);
        }

        // Admissions, rather than successful sends, consume each budget. A
        // provider outage or crash cannot make fresh submissions free to retry.
        const { rows: [counts] } = await client.query(
          `SELECT
             (SELECT count(*)::int FROM contact_submissions
              WHERE ip_hash = $1 AND created_at > $3::timestamptz - interval '1 hour') AS ip,
             (SELECT count(*)::int FROM contact_submissions
              WHERE normalized_email = $2 AND created_at > $3::timestamptz - interval '1 hour') AS recipient,
             (SELECT count(*)::int FROM contact_submissions
              WHERE confirmation_reserved_at > $3::timestamptz - interval '1 hour') AS confirmations,
             EXISTS (SELECT 1 FROM contact_submissions
                     WHERE normalized_email = $2
                       AND confirmation_reserved_at > $3::timestamptz - interval '24 hours') AS recipient_confirmed`,
          [lead.ip_hash, email, at]
        );
        if (counts.ip >= limits.ipPerHour || counts.recipient >= limits.recipientPerHour) {
          return { status: "limited" };
        }
        const { rows: [savedLead] } = await client.query(
          `INSERT INTO leads (name, email, company, message, source, ip_hash, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [lead.name, email, lead.company, lead.message, lead.source, lead.ip_hash, lead.user_agent]
        );
        const messages = buildMessages(savedLead.id);
        if (!messages || typeof messages.then === "function" ||
            !messages.team || typeof messages.team !== "object" || Array.isArray(messages.team) ||
            (messages.confirmation != null && (typeof messages.confirmation !== "object" || Array.isArray(messages.confirmation)))) {
          throw new TypeError("Contact messages must be synchronous email payloads");
        }
        const confirmation = !counts.recipient_confirmed && counts.confirmations < limits.confirmationsPerHour
          ? messages.confirmation ?? null : null;
        const { rows: [row] } = await client.query(
          `INSERT INTO contact_submissions
             (id, lead_id, created_at, dedup_key, dedup_until, retry_until,
              normalized_email, ip_hash, team_payload, confirmation_payload,
              confirmation_reserved_at, lease_token, lease_until)
           VALUES ($1, $2, $3, $4, $3::timestamptz + interval '24 hours',
                   $3::timestamptz + interval '23 hours', $5, $6, $7::jsonb, $8::jsonb,
                   CASE WHEN $8::jsonb IS NULL THEN NULL ELSE $3::timestamptz END,
                   $9, $3::timestamptz + interval '30 seconds') RETURNING *`,
          [randomUUID(), savedLead.id, at, dedupKey, email, lead.ip_hash,
            JSON.stringify(messages.team), confirmation === null ? null : JSON.stringify(confirmation), randomUUID()]
        );
        return claimed(row);
      });
    },

    async authorizeConfirmation(id, leaseToken, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Invalid confirmation dispatch limit");
      if (limit === 0) return false;
      return transaction(pool, async (client) => {
        const { rows: [clock] } = await client.query("SELECT clock_timestamp() AS at");
        const at = clock.at;
        const { rows: [row] } = await client.query(
          `SELECT *, lease_until > $3::timestamptz AS leased,
                     retry_until <= $3::timestamptz AS expired,
                     confirmation_attempted_at > $3::timestamptz - interval '1 hour' AS recent_attempt
           FROM contact_submissions WHERE id = $1 AND lease_token = $2 FOR UPDATE`,
          [id, leaseToken, at]
        );
        if (!row || !row.leased || row.expired || !row.team_sent ||
            row.confirmation_sent || !row.confirmation_payload) return false;
        if (!row.recent_attempt) {
          const { rows: [counts] } = await client.query(
            `SELECT
               (SELECT count(*)::int FROM contact_submissions
                WHERE id <> $1 AND confirmation_attempted_at > $3::timestamptz - interval '1 hour') AS attempts,
               EXISTS (SELECT 1 FROM contact_submissions
                       WHERE id <> $1 AND normalized_email = $2
                         AND confirmation_attempted_at > $3::timestamptz - interval '24 hours') AS recipient_attempted`,
            [id, row.normalized_email, at]
          );
          if (counts.attempts >= limit || counts.recipient_attempted) return false;
        }
        // Refresh even a reused permit: a delayed retry at minute 59 still
        // occupies its slot for the full hour after that delivery attempt.
        const result = await client.query(
          `UPDATE contact_submissions SET confirmation_attempted_at = $3
           WHERE id = $1 AND lease_token = $2 AND lease_until > clock_timestamp()
             AND retry_until > clock_timestamp() RETURNING id`,
          [id, leaseToken, at]
        );
        return result.rowCount === 1;
      });
    },

    async markSent(id, leaseToken, kind) {
      if (kind !== "team" && kind !== "confirmation") throw new TypeError("Unknown contact email kind");
      // Only these two constant column names can be interpolated.
      const column = kind === "team" ? "team_sent" : "confirmation_sent";
      const result = await pool.query(
        `UPDATE contact_submissions SET ${column} = true
         WHERE id = $1 AND lease_token = $2 AND lease_until > clock_timestamp()
           ${kind === "confirmation" ? "AND confirmation_payload IS NOT NULL AND team_sent = true" : ""}
         RETURNING id`,
        [id, leaseToken]
      );
      return result.rowCount === 1;
    },

    async finishSubmission(id, leaseToken) {
      const result = await pool.query(
        `UPDATE contact_submissions SET lease_token = NULL, lease_until = NULL
         WHERE id = $1 AND lease_token = $2 RETURNING id`,
        [id, leaseToken]
      );
      return result.rowCount === 1;
    },

    async close() {
      await pool.end();
    },
  };
}

export async function createPgStore(databaseUrl, { ssl } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new TypeError("DATABASE_URL is required for durable contact admission");
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    max: 2,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_TRANSACTION_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  pool.on("error", () => {
    console.error("contact: idle Postgres client errored");
  });
  try {
    return await createStore(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
