# Solden marketing site

The public site at [soldenai.com](https://soldenai.com). Static HTML, CSS and one small script, no framework, no build step, plus one serverless function that delivers the invite form to a founder inbox.

Content follows the marketing site brief (17 September 2026) and the founder-locked language in [`soldensystems/solden`](https://github.com/soldensystems/solden) (`AGENTS.md`, `docs/SOLDEN_FOUNDER_MEMO.md`). `npm test` enforces the language rules and the site's structure on every page.

## Pages

Everything the visitor can fetch lives in `public/`. Vercel serves that directory and nothing else (`outputDirectory` in `vercel.json`), so `lib/`, `tests/`, `server.js`, the config files and this README are never public.

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `public/index.html` | Hero with the animated close frame, the systems diagram (`#connects`), what you are hiring (`#hiring`), the close end to end (`#close`), the boundary (`#boundary`), access and controls (`#controls`), the buying test (`#test`), invite form (`#invite`) |
| `/how-it-works` | `public/how-it-works.html` | What Solden takes on (`#work`), the pack (`#pack`), who decides (`#who-decides`), the controls register (`#controls`, also `#security`), what happens when it is wrong (`#when-wrong`) |
| `/about` | `public/about.html` | Team (`#team`), the story so far (`#story`), the order of functions (`#order`), invite form (`#contact`) |
| `/privacy`, `/terms` | `public/privacy.html`, `public/terms.html` | Legal |
| `/thanks` | `public/thanks.html` | Success page for a form post made without JavaScript. `noindex`, no canonical |
| any other path | `public/404.html` | Not found. `noindex`, no canonical |

Redirects, all permanent (308), from `vercel.json`:

| From | To |
| --- | --- |
| `www.soldenai.com/*` | `https://soldenai.com/*` |
| `/request-demo` | `/about#contact` |
| `/security` | `/how-it-works#security` |
| `/careers` | `/about` (there is no careers page) |
| `/product` | `/how-it-works` (the product content lives there now) |

`public/robots.txt` allows everything except `/api/`; `public/sitemap.xml` lists the six indexable pages. Both are checked by the tests.

## Architecture

- **Pages** are hand-written HTML in `public/`. The header, mobile menu, footer and `<head>` block are duplicated per page on purpose: eight pages, no templating dependency, and a test that keeps the shared parts identical.
- **`public/assets/site.css`** is the whole design system (v5, consolidated). Tokens sit at the top; every media query sits at the end so no appended base rule can defeat it.
  - **Type.** Fraunces for display (`h1`, `h2`, the serif voice), Inter for body, Geist Mono for the record: eyebrow keys, run-log lines, table figures and tokens. All three are self-hosted variable fonts in `public/assets/fonts/`, subset to Latin, Latin Extended, punctuation and currency, declared in `solden-fonts.css` with metric-matched local fallbacks so the swap does not move layout. Fraunces and Inter are preloaded from every page.
  - **Colour.** Warm paper canvas, navy ink. Teal has one job: it marks what Solden owns (the `tag-solden` tag, the done segment of the progress bar, the write path in the diagram). Amber marks a decision waiting on a human. The invite form sits in a dark block.
  - **Devices.** Cards (`.card`, `.card-solden`) for two-column comparisons; tiles (`.mini` inside `.mini-grid`, `.tile`) for the inner pages, which use short tiles and cards rather than long walls of rows; strips (`.strip-cell`) for the Prepared / Reviewed / Attested line and the buying test; the stage rail (`.stages`). Soft shadows (`--shadow-card`, `--shadow-soft`) and motion are accepted parts of the system.
  - **The hero frame** (`.frame`, `data-demo`) is a product-like close workspace: window chrome, a sidebar, the workstream table (`data-row` per workstream), a progress bar whose fill is a `p-<done>-<review>-<call>` class, a run log and a side panel with three views (`activity`, `case`, `pack`). Three camera states (`wide`, `main`, `panel`) are `data-camera` attributes. A real Pause button (`data-demo-pause`) sets `data-paused` on the frame and on the diagram, which holds every animation.
  - **The connections diagram** (`#connects`, `.stack-svg`) is an inline SVG with real vendor marks from `public/assets/logos/`, the ERP as the system of record, Solden beneath it, and animated dashed read lines. Under 720px it becomes a plain list.
  - **Reduced motion.** `prefers-reduced-motion: reduce` removes the reveal transitions, the flowing lines, the spinners and the smooth scroll; the demo renders its finished state once (April locked, pack open) and never loops.
- **`public/assets/site.js`** is progressive enhancement. Every page reads and every form submits without it. It does four things:
  1. **Reveal.** Adds `.in` to `.reveal` sections as they enter the viewport (`IntersectionObserver`, with a no-observer fallback that shows everything).
  2. **Demo.** Runs the hero frame's timeline: reset, seven workstreams, one exception raised as a case with a proposal, the controller's approval, flux, statements, attest and lock, then reset. It pauses when scrolled out of view or when the Pause button is pressed, and under reduced motion it plays the finished state statically. A thrown error stops the loop and logs it rather than freezing the frame half-way.
  3. **Form.** Submits the invite form as JSON to `/api/contact`, marks the button `aria-busy`, writes the result into the `role="status"` region (switched to `role="alert"` on failure) and moves focus to it. It sends the elapsed time since page load, never a timestamp. If a script-blocked post failed and redirected back with `?sent=0&why=…`, it explains why.
  4. **Menu.** The mobile menu is a `<details>` element and needs no script; the script only closes it on Escape (returning focus to its summary) and on a click outside.
- **`api/contact.js`** is the Vercel Node function for `POST /api/contact`. The logic lives in `lib/contact.js` so it is testable and host-independent: it validates, traps bots with a honeypot and a minimum fill time, rate limits per hashed IP, optionally records the lead in Postgres (`lib/store.js`) and emails the founder inbox through Resend with the prospect as reply-to and the subject `Invite request: <company>`. The store is attached lazily and every database call is capped, so a slow or dead database never blocks the email.
- **`vercel.json`** sets the output directory, clean URLs, the redirects above, a strict content security policy (`script-src 'self'; style-src 'self'`, so no inline scripts, no inline styles, no event handler attributes; `application/ld+json` is data and is allowed) and cache headers.
- **`server.js`** is the local preview server. It mirrors the Vercel config (clean URLs, redirects, headers, the 404 page, an empty analytics script so consoles stay clean) and is a working host if the site ever runs on a plain Node server again. Set `TRUST_PROXY` only behind a known reverse proxy.

## Analytics

Every page loads `/_vercel/insights/script.js` (cookieless Vercel Web Analytics). Page views plus two events:

| Event | Data | Fired when |
| --- | --- | --- |
| `cta_click` | `cta`: `header`, `menu`, `hero`, `mid`, `product-footer`, `how-footer`, `contact-submit` | any element with `data-cta` is clicked |
| `contact_submitted` | `source`: `home` or `about` | the JSON submission returned 2xx |

A form post made without JavaScript lands on `/thanks`, so that page view is the no-script conversion. Nothing else is tracked.

## Local development

```bash
npm install
npm test          # language rules, site structure, contact handler
npm start         # http://localhost:8080
```

Set `RESEND_API_KEY` and `LEAD_NOTIFY_TO` to test real email delivery locally. Without them the form returns a 503 with a plain message rather than a false success. `PORT` changes the port.

### Tests

- `tests/site_language.test.mjs`: the founder-locked language on every page, in `site.js` and in `site.css` (banned phrases, competitor devices, demo language, apologetic copy, the retired vision line); one `h1`, title, description and canonical per indexable page; internal links; every statistic sourced in its own block; both invite forms ask only for name, work email, company and message.
- `tests/site_structure.test.mjs`: every fragment link and redirect resolves to an id; the shared `<head>` block and script tags are identical on all eight pages; the footer line and the header CTA are on every page and every tracked CTA reads "Request an invite"; both forms carry the honeypot, the timer and the status region; every `data-*` hook `site.js` queries exists in `index.html` and every progress class the demo can emit has a rule; no inline styles, scripts or handlers; every logo and PNG under `public/assets` is referenced; the sitemap matches the indexable pages.
- `tests/contact_api.test.mjs`: the contact handler end to end with fakes for Resend and the store.

Cache tokens (`?v=`) on the CSS and JS links are bumped by hand when those files change; the parity test ignores them so all pages can move together.

## Deploying to Vercel

Production deploys from `main`. Every push to `main` becomes the live site; other branches get preview URLs.

1. In Vercel, import `soldensystems/marketing-page`. Framework preset: **Other**. No build command. `vercel.json` sets `outputDirectory` to `public`, so only the pages and assets are served; `api/contact.js` becomes a function and `lib/`, `tests/`, this README and the config files are never public.
2. Environment variables (Production):

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `RESEND_API_KEY` | yes | Sends the lead email |
   | `LEAD_NOTIFY_TO` | yes | Founder inbox. Comma-separate for several |
   | `LEAD_NOTIFY_FROM` | no | Verified sender. Defaults to `Solden <leads@soldenai.com>` |
   | `IP_HASH_SECRET` | recommended | Long random string. Rate-limit keys and the stored `ip_hash` become an HMAC of the visitor's IP instead of a plain hash, so the column cannot be reversed to an address. Rotate occasionally; rotation only resets the hourly counters |
   | `CONTACT_MAX_PER_IP_PER_HOUR` | no | Defaults to 5. Anything that is not a positive number falls back to 5 |
   | `DATABASE_URL` | no | Postgres for lead history and durable rate limits |
   | `DB_SSL` | no | `true` to connect over TLS and verify the server certificate against the public CAs (Neon, Supabase, RDS) |
   | `DB_SSL_CA` | no | PEM certificate authority to verify against instead. Paste the certificate, newlines as `\n` are accepted. Implies TLS |
   | `DB_SSL_NO_VERIFY` | no | `true` to encrypt without verifying the certificate. Only for providers that present a self-signed certificate, such as Railway's public TCP proxy. Implies TLS |

   The function never waits on the database: connecting, the recent-count check and the insert are each capped at two seconds, and on a timeout or error the lead is emailed anyway and the failure is logged. A failed connection is retried on the next request.

3. Verify on the `*.vercel.app` URL: pages, redirects, `/api/contact` answers `405` to a GET, `/README.md` and `/lib/contact.js` answer `404`, and one real form submission.
4. Enable **Web Analytics** on the Vercel project. The pages already load `/_vercel/insights/script.js`; it is cookieless and counts page views and the `cta_click` and `contact_submitted` events described above. Nothing else is tracked.
5. Add the domains `soldenai.com` and `www.soldenai.com` to the project. Vercel will show the DNS records it needs.
6. At Namecheap, change ONLY two records: the apex `A` (or `ALIAS`) record for `soldenai.com`, and the `CNAME` for `www`, to the values Vercel shows. Keep every other record exactly as it is. The zone carries the Microsoft 365 mail records (`MX`, the SPF `TXT`, DKIM `CNAME`s, the `_dmarc` `TXT`) and the Resend sending records (DKIM and return-path `TXT`/`MX`); deleting or replacing any of them stops founder mail or lead delivery. The `www` host redirects to the apex via `vercel.json`.

## Lead history

The previous site stored submissions in the `leads-db` Postgres on Railway (project "Solden Non-Production"). That database is still online. Either point `DATABASE_URL` at it or export it and import into a new provider before retiring Railway. The new function writes the same `leads` table, a subset of the old columns, so history stays in one place.

Railway's public TCP proxy presents a self-signed certificate, so with the public connection URL set `DB_SSL_NO_VERIFY=true` (encrypted, unverified). With a provider that offers a real certificate chain use `DB_SSL=true`, or `DB_SSL_CA` with the provider's CA, so the connection is verified. The table and index are created on the first request of each function instance with `CREATE ... IF NOT EXISTS`, so no migration step is needed.

## Content rules

- Solden is the **AI finance department**. Never "AI finance team".
- **Growing companies**, never "modern companies".
- No em-dashes. Use commas or colons.
- Outcomes pricing: one monthly price for the close, set by entities and transaction volume, quoted after the replay. Never per-seat, per-action, hours or credit language.
- Agents are workers inside the department, never the product.
- The CTA is **Request an invite**. No demo language, no design-partner language, no careers page.
- Honesty is kept by not overclaiming, never by apologetic copy. Never announce what is missing or its build status (no "planned", "not yet", "pre-build", "illustrative", "specified").
- No invented customer results, logos or testimonials. Vendor marks in the diagram are the real marks of systems Solden connects to; the only other mark is Solden's own. Never a substitute letter or icon.
- NetSuite and Sage Intacct are the first ERPs Solden goes live on. The promise on the page is "your ERP" and "the systems you already run"; the first two are never presented as a limit.
- Solden's reviewers are qualified, experienced accountants and controllers, and the site says so.
- Hosting is in the UK and EU, with other regions served as local law requires.
- The animated hero frame is an accepted device: a directed sequence inside a product-like close workspace, with a pause control and a static finished state under reduced motion. It shows how the work runs, not a customer's numbers.
- Every statistic names its source in the same sentence or block.
- British spelling. Never copy a competitor's lines or devices.

These are enforced by `tests/site_language.test.mjs` and `tests/site_structure.test.mjs`. Keep them green.

## Founder decisions still open

- Contact routing: confirm the inbox for `LEAD_NOTIFY_TO`.
- Vision line: "The CFO stays. The grunt work goes. Solden becomes the department under them." is not on the site and is not approved for external use. Approve it or replace it.
- Team visibility: names and one-line bios are on About. No photos.
- Launch timing: ship before outreach references the site.
