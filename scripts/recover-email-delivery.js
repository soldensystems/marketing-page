/**
 * Explicit operator recovery for a dead-lettered contact email channel.
 *
 * Usage:
 *   npm run email:recover -- --submission-id=<uuid> \
 *     --operator=<name> --reason=<reason> --confirm
 *
 * The command never touches an accepted channel. It resets only dead-lettered
 * channels to retryable work and makes the row immediately due for the running
 * landing service's delivery worker.
 */
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL || '';
const submissionArg = process.argv.find((argument) =>
  argument.startsWith('--submission-id=')
);
const submissionId = String(submissionArg || '').split('=', 2)[1] || '';
const argumentValue = (name) => {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  return String(argument || '').slice(name.length + 1).trim();
};
const operatorReference = argumentValue('--operator');
const recoveryReason = argumentValue('--reason');
const confirmed = process.argv.includes('--confirm');

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    submissionId
  )
) {
  console.error('A valid --submission-id=<uuid> is required.');
  process.exit(1);
}
if (!confirmed) {
  console.error('Add --confirm after verifying the exact submission ID.');
  process.exit(1);
}
if (
  !operatorReference ||
  operatorReference.length > 200 ||
  /[\u0000-\u001f\u007f]/.test(operatorReference)
) {
  console.error('A safe --operator=<name> of at most 200 characters is required.');
  process.exit(1);
}
if (
  !recoveryReason ||
  recoveryReason.length > 500 ||
  /[\u0000-\u001f\u007f]/.test(recoveryReason)
) {
  console.error('A safe --reason=<reason> of at most 500 characters is required.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
});

let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`
    CREATE TABLE IF NOT EXISTS contact_email_recovery_events (
      id BIGSERIAL PRIMARY KEY,
      recovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submission_id UUID NOT NULL,
      operator_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      prior_internal_status TEXT NOT NULL,
      prior_internal_attempts INTEGER NOT NULL,
      prior_internal_error TEXT,
      prior_internal_provider_id TEXT,
      prior_prospect_status TEXT NOT NULL,
      prior_prospect_attempts INTEGER NOT NULL,
      prior_prospect_error TEXT,
      prior_prospect_provider_id TEXT
    )
  `);
  const selected = await client.query(
    `SELECT *,
       (email_lease_until IS NOT NULL AND email_lease_until > now())
         AS lease_active
     FROM leads
     WHERE submission_id = $1
     FOR UPDATE`,
    [submissionId.toLowerCase()]
  );
  const prior = selected.rows[0];
  if (
    !prior ||
    (prior.internal_email_status !== 'dead_letter' &&
      prior.prospect_email_status !== 'dead_letter')
  ) {
    await client.query('ROLLBACK');
    console.error('No dead-lettered delivery found for that submission ID.');
    process.exitCode = 1;
  } else if (prior.lease_active) {
    await client.query('ROLLBACK');
    console.error(
      'Recovery refused because an email delivery lease is still active. Try again after it expires.'
    );
    process.exitCode = 1;
  } else {
    await client.query(
      `INSERT INTO contact_email_recovery_events (
         submission_id, operator_reference, reason,
         prior_internal_status, prior_internal_attempts,
         prior_internal_error, prior_internal_provider_id,
         prior_prospect_status, prior_prospect_attempts,
         prior_prospect_error, prior_prospect_provider_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        submissionId.toLowerCase(),
        operatorReference,
        recoveryReason,
        prior.internal_email_status,
        prior.internal_email_attempts,
        prior.internal_email_error,
        prior.internal_email_provider_id,
        prior.prospect_email_status,
        prior.prospect_email_attempts,
        prior.prospect_email_error,
        prior.prospect_email_provider_id,
      ]
    );
    const result = await client.query(
      `UPDATE leads SET
       internal_email_status = CASE
         WHEN internal_email_status = 'dead_letter' THEN 'failed'
         ELSE internal_email_status END,
       internal_email_attempts = CASE
         WHEN internal_email_status = 'dead_letter' THEN 0
         ELSE internal_email_attempts END,
       internal_email_error = CASE
         WHEN internal_email_status = 'dead_letter' THEN NULL
         ELSE internal_email_error END,
       prospect_email_status = CASE
         WHEN prospect_email_status = 'dead_letter' THEN 'failed'
         ELSE prospect_email_status END,
       prospect_email_attempts = CASE
         WHEN prospect_email_status = 'dead_letter' THEN 0
         ELSE prospect_email_attempts END,
       prospect_email_error = CASE
         WHEN prospect_email_status = 'dead_letter' THEN NULL
         ELSE prospect_email_error END,
       email_next_retry_at = now(),
       email_lease_token = NULL,
       email_lease_until = NULL
     WHERE submission_id = $1
       AND (internal_email_status = 'dead_letter'
         OR prospect_email_status = 'dead_letter')
     RETURNING submission_id, internal_email_status, prospect_email_status,
       email_next_retry_at`,
      [submissionId.toLowerCase()]
    );
    await client.query('COMMIT');
    const row = result.rows[0];
    console.log(
      JSON.stringify({
        submission_id: String(row.submission_id),
        internal_email_status: row.internal_email_status,
        prospect_email_status: row.prospect_email_status,
        email_next_retry_at: row.email_next_retry_at,
      })
    );
  }
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {});
  console.error('Recovery failed:', error.message);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
