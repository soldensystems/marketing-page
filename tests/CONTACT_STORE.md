# Testing durable contact admission

The regular `npm test` run includes `contact_store.test.mjs`, a deterministic
query/transaction test suite. It checks decisions, exact-payload reuse, rollback,
lease fencing and fail-closed error paths. A query double does not prove actual
Postgres locking or SQL compatibility.

`contact_store.integration.test.mjs` supplies the real Postgres checks. It is
skipped unless `TEST_DATABASE_URL` is explicitly set. It never reads
`DATABASE_URL`, Railway variables or deployment credentials and never sends
email. Use a dedicated disposable Postgres database with a role permitted to
create schemas. The suite creates a random `contact_test_<uuid>` schema for each
case, uses independent pools/workers and drops only those schemas afterwards.
Do not point this variable at a production database.

For an already-running local Postgres instance:

```sh
createdb solden_contact_test
TEST_DATABASE_URL=postgresql://localhost/solden_contact_test \
  node --test tests/contact_store.integration.test.mjs
```

Or use a disposable local Docker instance, if Docker is installed:

```sh
docker run --rm --name solden-contact-tests \
  -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=solden_contact_test \
  -p 127.0.0.1:55432:5432 -d postgres:16
# Wait for: docker exec solden-contact-tests pg_isready -U postgres
TEST_DATABASE_URL=postgresql://postgres:local-test-only@127.0.0.1:55432/solden_contact_test \
  node --test tests/contact_store.integration.test.mjs
docker stop solden-contact-tests
```

The integration suite verifies:

- Concurrent initialization preserves previous `leads` rows and extra columns
- Twenty identical concurrent requests create one lead and one delivery claim
- Per-IP and normalized-recipient admission caps hold across independent pools
- Global confirmation reservations are atomic; one recipient receives at most
  one reservation in 24 hours, even with rotated IPs and email letter casing
- Rate limits expire on sliding hour boundaries without prematurely resetting
  the 24-hour recipient confirmation guard
- A new worker retains the exact original payload, submission ID and sent flags
- An expired lease can be reclaimed once; stale workers cannot mark or release it
- Unresolved team deliveries cannot retry after the 23-hour safety window, even
  past deduplication expiry; optional confirmations expire without reopening team
  delivery. This keeps retries inside Resend's 24-hour idempotency lifetime
- Completed duplicates are suppressed for 24 hours
- Failed payload rendering rolls back leads and all admission budgets
- A dispatch-time guard prevents old reservations and new submissions from
  combining into a burst when a provider outage ends
- Same-ID retries refresh their dispatch-hour slot, and the per-recipient
  24-hour guard follows actual attempts rather than just admission time

## Operational details

`lib/store.js` deliberately uses one transaction-level advisory lock for this
low-volume form. The transaction contains only database reads/writes and
synchronous payload rendering. No provider network calls run under this lock.
All deployed workers must use the same database and this admission path.

Production pool bounds are a 2-second connection timeout, 3-second SQL statement
timeout, 4-second client query timeout and 5-second idle-in-transaction timeout.
Transactions also set local SQL/lock/idle limits. The database owns the admission
clock. A pool initialization failure closes its newly created pool.

The store retains old lead history and adds `contact_submissions`. The latter
holds 24-hour deduplication windows, 23-hour retry deadlines, 30-second fenced
leases, exact JSON email payloads and separate team/confirmation delivery flags.
Immediately before a confirmation send, `authorizeConfirmation` reserves its
actual dispatch window under the same shared lock. Same-ID retries reuse and
refresh an active slot; older retries must obtain a new one. This closes the
provider-outage burst gap that admission-time reservations alone would leave.
Zero is an explicit confirmation off switch, including retries.
Contact data remains private server-side. Apply the site's existing retention
policy to both tables; reference `contact_submissions.lead_id` when deleting an
old lead. No automatic retention deletion or new background email worker is
installed by this change. Retries come from a repeated form submission.

For an unresolved record whose `retry_until` has elapsed, do not reset the
flags/deadline or silently resend: check provider delivery history using its
`contact-team/<submission UUID>` and `contact-confirmation/<submission UUID>`
idempotency keys first. An unresolved team delivery continues to block its exact
duplicate indefinitely until reviewed; never clear it merely to force a retry. A
request after the full 24-hour deduplication window can be a fresh admission only
when the previous team delivery was recorded as sent.
