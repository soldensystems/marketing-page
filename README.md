# Solden marketing page

Standalone production marketing site for [soldenai.com](https://soldenai.com).

This repository was extracted from the former `soldensystems/solden-legacy` repository so the public marketing site has its own deployment lifecycle.

## Architecture

- Express serves the approved public pages and assets.
- `POST /api/contact` stores demo/contact submissions in a dedicated PostgreSQL database.
- Resend sends the required internal lead notification and prospect confirmation.
- Slack is optional.
- The marketing database is intentionally isolated from the Solden product database.

## Vercel deployment

Vercel supports Express deployments with zero configuration. The repository root is the application root.

Required environment variables:

- `DATABASE_URL`
- `RESEND_API_KEY`
- `LEAD_NOTIFY_TO`
- `LEAD_NOTIFY_FROM` if the default `leads@soldenai.com` is not used

Optional:

- `SLACK_WEBHOOK_URL`
- `DB_SSL=true` for external PostgreSQL providers that require TLS
- `EMAIL_FETCH_TIMEOUT_MS`
- `EMAIL_MAX_ATTEMPTS`
- `CONTACT_MAX_PER_IP_PER_HOUR`
- `CONTACT_MAX_PER_EMAIL_PER_HOUR`
- `BLOCKED_EMAIL_DOMAINS`

Do not configure the production custom domain until the Vercel deployment has been verified on its `.vercel.app` domain.

## Database migration

The existing Railway PostgreSQL database must be preserved and migrated before Railway is retired. The schema is created idempotently by `server.js`, but existing lead records should be copied into the new PostgreSQL provider rather than starting from an empty database.

## Local development

```bash
npm install
export DATABASE_URL="postgresql://you@localhost:5432/soldenai_landing"
npm start
```

The site listens on `PORT` when supplied, otherwise `8080`.

## Operations

```bash
npm run leads
npm run email:recover -- --submission-id=<uuid> --operator=<name> --reason=<reason> --confirm
```

## Public routes

- `/`
- `/request-demo`
- `/security`
- `/privacy`
- `/terms`
- `/healthz`
- `/readyz`

Legacy public URLs are redirected to their canonical destinations.

## Important

The hero close-film MP4 is the one binary asset that could not be transferred through the GitHub connector because the connector does not expose binary repository downloads. The source repository still contains the original asset. The poster assets and all application code are already present here. Before production launch, add `assets/media/solden-july-close.mp4` from the source repository so the desktop hero animation remains identical.

