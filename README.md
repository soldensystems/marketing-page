# Solden marketing site

The public site at [soldenai.com](https://soldenai.com). Static HTML, CSS and one small script, no framework, no build step, plus one serverless function that delivers the invite form to a founder inbox.

Content follows the marketing site brief (17 September 2026) and the founder-locked language in [`soldensystems/solden`](https://github.com/soldensystems/solden) (`AGENTS.md`, `docs/SOLDEN_FOUNDER_MEMO.md`). `npm test` enforces the language rules and the site's structure on every page.

## Pages

Everything the visitor can fetch lives in `public/`. The server serves that directory and nothing else, so `lib/`, `tests/`, this README and the config files are never public.

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `public/index.html` | Hero with the animated close frame, the systems diagram (`#connects`), what you are hiring (`#hiring`), the close end to end (`#close`), access and controls (`#controls`), the buying test (`#test`), invite form (`#invite`) |
| `/how-it-works` | `public/how-it-works.html` | What Solden takes on (`#work`), the five stages and the buying test (`#stages`), the pack (`#pack`), who decides (`#who-decides`), the controls register (`#controls`, also `#security`), what happens when it is wrong (`#when-wrong`), invite form (`#contact`) |
| `/about` | `public/about.html` | Why Solden (`#why`), the order of functions (`#order`), invite form (`#contact`) |
| `/privacy`, `/terms` | `public/privacy.html`, `public/terms.html` | Legal |
| `/thanks` | `public/thanks.html` | Success page for a form post made without JavaScript. `noindex`, no canonical |
| any other path | `public/404.html` | Not found. `noindex`, no canonical |

Redirects, all permanent (308), from `routes.json`:

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
  - **Type.** Fraunces for display (`h1`, `h2`, the serif voice), Inter for body, Geist Mono for the record: eyebrow keys, run-log lines, table figures and tokens. All three are self-hosted variable fonts in `public/assets/fonts/`, subset to Latin, Latin Extended, punctuation and currency, declared at the top of `site.css` with metric-matched local fallbacks so the swap does not move layout. Fraunces and Inter are preloaded from every page. Font files are cached for a year and never change in place: a rebuilt font ships under a new file name (Inter is `InterVariable-latin.woff2`, trimmed on 2 October 2026 from 157 to 91 KB with both of its axes kept).
  - **Type scale (2 October 2026).** One Fraunces weight, 500, at 60, 48, 32 and 22px for headlines, the demo's title and its figures. Inter at 400 and 500 only, at 18 (ledes), 15 (body, tables, buttons), 13 (small text and the demo) and 11 (micro), plus 26 for figures on the paper illustrations. Geist Mono only as the 11px uppercase label and stamp style, letter-spacing 0.1em. Signatures in Fraunces italic at 20. Headings step rather than slide: 60 / 48 / 32 / 22 above 1024px, 48 / 32 / 22 up to 1024px, and a 40px h1 on phones. Display Fraunces is set at optical size 96; the demo's figures use optical size 48, because at display size its "1" reads as an "l". Do not add sizes, weights or tracking values; the founder read the earlier 45 combinations as a dozen fonts.
  - **Colour.** Warm paper canvas, navy ink. Teal has one job: it marks what Solden owns (the `tag-solden` tag, the done segment of the progress bar, the write path in the diagram). Amber marks a decision waiting on a human. The invite form sits in a dark block.
  - **Devices.** Cards (`.card`, `.card-solden`) for two-column comparisons; tiles (`.mini` inside `.mini-grid`, `.tile`) for the inner pages, which use short tiles and cards rather than long walls of rows; strips (`.strip-cell`) for the Prepared / Reviewed / Attested line and the buying test; the stage rail (`.stages`). Soft shadows (`--shadow-card`, `--shadow-soft`) and motion are accepted parts of the system.
  - **The hero frame** (`.frame`, `data-demo`) is a product-like close workspace: window chrome, a sidebar, the workstream table (`data-row` per workstream), a progress bar whose fill is a `p-<done>-<review>-<call>` class, a run log and a side panel with three views (`activity`, `case`, `pack`). Three camera states (`wide`, `main`, `panel`) are `data-camera` attributes. There is no visible pause control: the demo holds (`.held` on the frame) while the pointer is over it or it has keyboard focus (the frame body takes focus for this), while it is off-screen and while the tab is hidden; the diagram's lines hold while the pointer is over them. On phones the side panel becomes a sheet that rises over the work for the judgement call and the locked pack.
  - **The connections diagram** (`#connects`, `.stack-svg`) is an inline SVG with real vendor marks from `public/assets/logos/`, the ERP as the system of record, Solden beneath it, and animated dashed read lines. Under 720px it becomes a plain list.
  - **Reduced motion.** `prefers-reduced-motion: reduce` removes the reveal transitions, the flowing lines, the spinners and the smooth scroll; the demo renders its finished state once (April locked, pack open) and never loops.
- **`public/assets/site.js`** is progressive enhancement. Every page reads and every form provides an email alternative without it. It does four things:
  1. **Reveal.** Adds `.in` to `.reveal` sections as they enter the viewport (`IntersectionObserver`, with a no-observer fallback that shows everything).
  2. **Demo.** Runs the hero frame's timeline: reset, the opening papers, all sixteen workstreams, one judgement call raised with a proposal, the controller's approval, flux, statements, attest and lock, then reset. It halts when scrolled out of view and resumes when it returns. Under reduced motion it plays the finished state statically. A thrown error stops the loop and logs it rather than freezing the frame half-way.
  3. **Form.** Submits the invite form as JSON to `/api/contact`, marks the button `aria-busy`, writes the result into the `role="status"` region (switched to `role="alert"` on failure) and moves focus to it. It sends the elapsed time since page load and a single-use Cloudflare Turnstile token, never a timestamp. Verification expiry, interrupted requests and retries reset the widget. Without JavaScript, visitors use the explicit email alternative. If a script-blocked post failed and redirected back with `?sent=0&why=…`, it explains why.
  4. **Menu.** The mobile menu is a `<details>` element and needs no script; the script only closes it on Escape (returning focus to its summary) and on a click outside.
- **`api/contact.js`** is the handler for `POST /api/contact`, mounted by `server.js`. The logic lives in `lib/contact.js` so it is testable and host-independent: it validates the exact allowed origin, fields, elapsed-time signal and Turnstile token, then atomically reserves durable per-IP/per-recipient quotas and delivery state in Postgres (`lib/store.js`). Only after admission does it email the founder inbox through Resend with the prospect as reply-to and the subject `Invite request: <company>`. Missing configuration, failed verification or unavailable storage fails closed with an email alternative.
- **`routes.json`** holds the routing rules the server applies: clean URLs, the redirects above (including `www` to the apex), a strict content security policy (no inline scripts or styles anywhere), security headers and cache headers (one year, immutable, for the versioned CSS, JS and fonts; one day for images).
- **`server.js`** is the production server. Railway runs it with `npm start`; the same file is the local preview. It serves `public/` with clean URLs, applies `routes.json`, hosts the contact handler, blocks dotfiles, serves the 404 page and answers `/healthz` for the platform's health check. Behind Railway it trusts one proxy hop so the rate limit sees the visitor's address.

## Analytics

Umami Cloud, free tier, with the website in the EU region (Frankfurt). Cookieless, so no consent banner. Umami serves one script host for every region and stores the data where the website is registered, so the tag below is correct for an EU site. The content security policy allows `https://cloud.umami.is` for the script and `https://gateway.umami.is` for the events it posts, and `track()` in `site.js` forwards events to `window.umami` when the script is present and does nothing otherwise.

The site is registered on the account; this tag sits after `site.js` on every page:

```html
<script defer src="https://cloud.umami.is/script.js" data-website-id="99baca41-1d1e-4286-8ea0-66d90959767c"></script>
```

Besides page views the pages send two custom events:

| Event | Data | Fired when |
| --- | --- | --- |
| `cta_click` | `cta`: `header`, `menu`, `hero`, `mid`, `product-footer`, `how-footer`, `contact-submit` | any element with `data-cta` is clicked |
| `contact_submitted` | `source`: `home` or `about` | the JSON submission returned 2xx |

To switch provider, change the script tag on every page, the `track()` function in `site.js`, and the host in `script-src` and `connect-src` in `routes.json`; the CSP blocks anything else.

Without JavaScript, visitors use the email alternative. Those emails are not recorded as form conversions.

## Local development

```bash
npm install
npm test          # language rules, site structure, contact handler
npm start         # http://localhost:8080
```

The contact form requires Turnstile, Postgres and Resend configuration below. Use test doubles and a disposable database for automated testing; never point tests at production or use real recipients. `PORT` changes the local preview port. Unconfigured previews show the email alternative.

### Tests

- `tests/site_language.test.mjs`: the founder-locked language on every page, in `site.js` and in `site.css` (banned phrases, competitor devices, demo language, apologetic copy, the retired vision line); one `h1`, title, description and canonical per indexable page; internal links; every statistic sourced in its own block; all three invite forms ask only for name, work email, company and message.
- `tests/site_structure.test.mjs`: every fragment link and redirect resolves to an id; the shared `<head>` block and script tags are identical on all eight pages; the footer line and the header CTA are on every page and every tracked CTA reads "Request an invite"; all three forms carry the honeypot, the timer and the status region; every `data-*` hook `site.js` queries exists in `index.html` and every progress class the demo can emit has a rule; no inline styles, scripts or handlers; every logo and PNG under `public/assets` is referenced; the sitemap matches the indexable pages.
- `tests/contact_api.test.mjs`: the contact handler with strict verification/Resend fakes and a store contract fake, including service outages, invalid/replayed challenges, concurrent attempts and ambiguous delivery retries.
- `tests/contact_frontend.test.mjs`: the three form pages, CSP and browser-like widget lifecycle.
- `tests/contact_store.test.mjs` / `tests/contact_store.integration.test.mjs`: transaction failures and real PostgreSQL concurrency/admission tests. The integration suite uses only `TEST_DATABASE_URL`, creates an isolated random schema and drops that schema when done. It never uses `DATABASE_URL`.

Cache tokens (`?v=`) on the CSS and JS links are a hash of `site.css` and `site.js`: run `npm run stamp` after editing either. The suite fails while any page carries a stale token, since both files are cached for a year.

## Deploying to Railway

The site runs on Railway in the project **Solden AI**, as the service **solden**, from the `main` branch of `soldensystems/marketing-page`. That service already owns the custom domains `soldenai.com` and `www.soldenai.com` and already holds the Resend key and the inbox, so a deploy to it brings the domain back without any DNS change. (The service called **marketing** in the same project is a different product's site, clearledgr.com; leave it alone.) Every push to `main` redeploys. `railway.json` sets the start command, the `/healthz` health check and the restart policy; Nixpacks detects Node from `package.json` and runs `npm ci`.

1. The service's source is the GitHub repo `soldensystems/marketing-page`, branch `main`, with the root directory left empty (a value of `/` or the old `/soldenai-landing` makes the build fail with "prefix not found"). No build command. Both were set on 1 October 2026 and need no further action; this step matters only if the service is ever recreated.
2. Variables on the service:

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `RESEND_API_KEY` | yes | Sends the lead email. Mint a fresh key in Resend rather than reusing the retired service's |
   | `LEAD_NOTIFY_TO` | yes | `hello@soldenai.com`, the same inbox the previous site used. Comma-separate for several |
   | `LEAD_NOTIFY_FROM` | no | Verified sender. Defaults to `Solden <leads@soldenai.com>` |
   | `IP_HASH_SECRET` | recommended | Long random string. Rate-limit keys and the stored `ip_hash` become an HMAC of the visitor's IP instead of a plain hash, so the column cannot be reversed to an address. Rotate occasionally; rotation only resets the hourly counters |
   | `CONTACT_MAX_PER_IP_PER_HOUR` | no | Durable new admissions per IP per sliding hour, defaults to 5; positive integers only |
   | `CONTACT_MAX_PER_RECIPIENT_PER_HOUR` | no | Durable new admissions for one normalised email per hour, defaults to 3 |
   | `CONTACT_MAX_ATTEMPTS_PER_IP_PER_HOUR` | no | Process-local pre-verification attempt brake, defaults to 30; durable delivery quotas still apply across replicas |
   | `CONTACT_MAX_CONFIRMATIONS_PER_HOUR` | no | Durable site-wide confirmation reservations per hour, defaults to 20; 0 disables prospect mail. One confirmation per recipient per 24 hours |
   | `TURNSTILE_SITE_KEY` | yes | Public managed-widget site key, exposed through `/api/contact-config` |
   | `TURNSTILE_SECRET_KEY` | yes | Server-only Siteverify secret. Configure securely; never commit it |
   | `CONTACT_ALLOWED_ORIGINS` | no | Exact comma-separated origins. Defaults to `https://soldenai.com,https://www.soldenai.com`. Hostnames are also required to match Siteverify; action is fixed to `contact` |
   | `DATABASE_URL` | yes | Postgres for lead history, durable admission and delivery state. In the same project use the private reference `${{leads-db.DATABASE_URL}}`: no TLS needed on the private network |
   | `DB_SSL` | no | `true` to connect over TLS and verify the server certificate against the public CAs |
   | `DB_SSL_CA` | no | PEM certificate authority to verify against instead. Paste the certificate, newlines as `\n` are accepted. Implies TLS |
   | `DB_SSL_NO_VERIFY` | no | `true` to encrypt without verifying the certificate. Only for Railway's public TCP proxy from outside the project. Implies TLS |
   | `TRUST_PROXY` | no | Set automatically to one hop on Railway. Set it by hand (`1` or `loopback`) only on another host behind a known proxy |

   Store calls are bounded at 2.5 seconds in the handler; the pool also bounds connection, lock, statement and idle-transaction time. Any admission failure stops delivery. A failed connection is retried on the next request. Verification is bounded at 5 seconds, each Resend request at 6 seconds.

3. Verify on the service's `*.up.railway.app` URL: pages, redirects, `/healthz` answers `ok`, `/api/contact` answers `405` to a GET, `/README.md` and `/lib/contact.js` answer `404`, and one real form submission reaches `hello@soldenai.com`.
4. The custom domains `soldenai.com` and `www.soldenai.com` are already on the service, and Namecheap already points at their Railway targets (the apex as an `ALIAS`, `www` as a `CNAME`). Nothing to add.
5. Only if a domain is ever moved to another service: at Namecheap, change ONLY two records: the apex record for `soldenai.com` (an `ALIAS` record to the Railway target; Namecheap supports `ALIAS` at the apex) and the `CNAME` for `www`, to the values Railway shows. Keep every other record exactly as it is. The zone carries the Microsoft 365 mail records (`MX`, the SPF `TXT`, DKIM `CNAME`s, the `_dmarc` `TXT`) and the Resend sending records (DKIM and return-path `TXT`/`MX`); deleting or replacing any of them stops founder mail or lead delivery. The `www` host redirects to the apex in `server.js`.
6. Keep **leads-db**. Nothing else in the project serves this site.

## Lead history

The previous site stored submissions in the `leads-db` Postgres in the same Railway project. It is still online, so point `DATABASE_URL` at it with the private reference and history stays in one place: the handler writes the same `leads` table, a subset of the old columns.

From outside the project, Railway's public TCP proxy presents a self-signed certificate, so with the public connection URL set `DB_SSL_NO_VERIFY=true` (encrypted, unverified). With a provider that offers a real certificate chain use `DB_SSL=true`, or `DB_SSL_CA` with the provider's CA, so the connection is verified. The original `leads` table remains intact. Additive `contact_submissions` schema and indexes are created lazily inside a serialised initialization transaction. The application database role therefore needs table/index creation rights; verify that in staging before rollout.

## Contact protection rollout and recovery

This change is review-only until deployment is explicitly approved. Railway tracks `main`; do not merge merely to preview this work.

1. Create/configure a managed Cloudflare Turnstile widget for `soldenai.com` and `www.soldenai.com` through an approved secure setup flow. Review Cloudflare terms/privacy requirements. Set its public site key and server secret securely in staging, then production only after approval. Do not permit arbitrary production hostnames or use public test keys in production (the handler rejects known dummy keys on Railway/production).
2. Verify `DATABASE_URL` is present and the role can create the additive schema. Set an `IP_HASH_SECRET` securely if not already configured. Preserve the established Railway one-hop proxy topology; never set `TRUST_PROXY=true` on an internet-facing direct server. Outside that topology, use trusted proxy addresses/subnets or leave trust disabled. The handler ignores raw forwarding headers when Express has not resolved an IP.
3. Run `npm ci && npm test`. For actual PostgreSQL concurrency checks, run `TEST_DATABASE_URL=postgres://... npm test` against a disposable test database. CI provisions PostgreSQL 16 and runs the full suite with that variable. No separate lint/typecheck/build scripts exist; JavaScript is served directly. Run `npm run stamp` after any CSS/JS change, then rerun tests.
4. Verify all three forms, keyboard focus, small-screen widget layout, expiry, retry and the email alternative in staging. Cloudflare dummy keys are for non-production visual testing only. API tests use controlled Siteverify fixtures so hostname/action mismatch checks stay enforced; never add a test-key bypass to the production validator. Do not submit to real inboxes without approval.
5. Review the privacy notice for Cloudflare browser verification before enabling it. Confirm production configuration and stage a controlled, approved end-to-end delivery test before authorising deployment. Missing Turnstile/database configuration deliberately makes the form unavailable instead of accepting unprotected submissions.

Admission is serialised across workers using a short PostgreSQL advisory transaction lock. It creates the lead, checks sliding-hour IP/recipient limits, reserves confirmation budgets and persists both email payloads together. Before each prospect send, another atomic permit checks the current hourly site-wide and 24-hour recipient budgets; delayed retries cannot bunch old reservations into an unbounded send burst. Each permitted attempt refreshes its timestamp while retaining the same payload and idempotency key. Normalised name/email/company/message make the dedup key; page source, IP and challenge token do not. Identical requests share one delivery for 24 hours. In-flight duplicates return 409 with a retry hint; completed duplicates succeed without more email. Delivery failures keep their quota reservation and immutable payloads.

A delivery lease lasts 30 seconds. Team and prospect requests use distinct stable Resend idempotency keys based on the durable submission ID. Each successful delivery flag is persisted before the next step. A timeout or lost database acknowledgement may leave delivery uncertain: retries use the stored payload and key, never a newly rendered message. Automatic retries stop after 23 hours, before [Resend's 24-hour key retention](https://resend.com/docs/dashboard/emails/idempotency-keys). Unresolved team deliveries stay blocked for the same content after that deadline until an operator reviews provider receipts. A failed optional confirmation never changes a successful team delivery into a failed invite, and expired optional confirmations are not retried.

There is no background mail worker in this change. A fresh verified browser retry resumes pending delivery; an abandoned failed request remains recorded for operator review. Monitor the sanitized `contact:` failure categories and pending rows. Use a read-only query selecting `id`, `lead_id`, `created_at`, `team_sent`, `confirmation_sent`, `retry_until` and `lease_until` to identify overdue work; do not log message payloads or tokens. Reconcile uncertain delivery in Resend before any manual resend. Keep the existing 24-month lead-retention policy for the added payload records too; delete dependent delivery records before their lead if running retention cleanup.

Rollback requires an approved deployment. Prefer restoring the previous code while temporarily disabling form submissions at the application/edge and keeping the email link available, rather than restoring the old unprotected delivery path. The additive table can remain; do not drop delivery state or reset sent flags during rollback/redeploy, as that can resend messages. Never work around a database or verification outage by failing open.

References: [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), [Cloudflare Turnstile privacy](https://www.cloudflare.com/turnstile-privacy-policy/).

## Content rules

- Solden is the **AI finance department**. Never "AI finance team".
- **Growing companies**, never "modern companies".
- No em-dashes. Use commas or colons.
- Outcomes pricing: one monthly price for the close, set by entities and transaction volume, quoted after the replay. Never per-seat, per-action, hours or credit language.
- Agents are workers inside the department, never the product.
- The CTA is **Request an invite**. No demo language, no design-partner language, no careers page.
- Honesty is kept by not overclaiming, never by apologetic copy. Never announce what is missing or its build status (no "planned", "not yet", "pre-build", "illustrative", "specified").
- No invented customer results, logos or testimonials. Vendor marks in the diagram are the real marks of systems Solden connects to; the only other mark is Solden's own. Never a substitute letter or icon.
- NetSuite, Sage Intacct and QuickBooks Online are the first ERPs Solden goes live on (QuickBooks Online added by the founder on 3 October 2026). The promise on the page is "your ERP" and "the systems you already run"; the go-live ERPs are never named on the page or presented as a limit.
- Solden's reviewers are qualified, experienced accountants and controllers, and the site says so.
- Hosting location, retention schedules and contract terms such as the DPA, subprocessors and data-protection law belong in the terms and the customer agreement, never on the marketing pages. For the agreement: hosting is in the UK and EU, with other regions served as local law requires.
- The animated hero frame is an accepted device: a directed sequence inside a product-like close workspace, with no visible pause control (removed by the founder on 2 October 2026; none of the competitor sites has one). For WCAG 2.2.2 it holds still while pointed at or focused, off-screen and in a hidden tab, and shows a static finished state under reduced motion. It shows how the work runs, not a customer's numbers.
- The demo's systems match a UK operation: ADP runs payroll, and payables and accruals read NetSuite (and Excel schedules). Gusto and Bill.com stay in the connections diagram, which shows the breadth of systems Solden reads, not the scenario.
- Every statistic names its source in the same sentence or block.
- British spelling. Never copy a competitor's lines or devices.

These are enforced by `tests/site_language.test.mjs` and `tests/site_structure.test.mjs`. Keep them green.

## Founder decisions, settled

- Vision line: "The finance department becomes infrastructure. Always running, always proven." Chosen by the founder on 1 October 2026 (the earlier "The CFO stays. The grunt work goes." line was judged not visionary), placed as the heading of the order section on About and, from the same day, as the footer line on every page. The schema.org description carries the hero line.
- ERP writes follow one model everywhere: the controller signs a single write activation; after it, every post passes Solden's review and is read back from the ERP, and material journals still wait for the controller's decision. Never write it as the controller signing each entry. Decided 1 October 2026.
- "Review time" is the customer controller's own time, written "your review time". The hero demo keeps it at 0 min while Solden works and moves it only when the controller decides a judgement call and reviews the pack before attesting. Solden's own review hours are an internal margin metric and stay off the site. Decided 1 October 2026.
- The ERP box keeps every ERP it shows, and the site does not name the go-live ERPs. Reaffirmed by the founder on 1 October 2026.
- No marketing page states hosting, retention or contracting terms; they live in the terms and the customer agreement. Decided by the founder on 1 October 2026 ("You don't plaster this all over").
- One scenario everywhere: the April 2026 close (three entities, attested 8 May) in the hero demo, the close-section cards, the controls card and the deck stills.
- The hero demo is Solden's own composition, never a competitor's layout: the top row is the sign-off chain (Prepared by Solden, Reviewed by J. Mensah, Attested by your controller) with its numbers, the work is a ruled register with an accountant's tick and results in the record font, the signature and attestation stamp land when the period locks, and the sidebar keeps the Close and Department groups. Decided 2 October 2026, after the founder rejected a version that copied Hyphenate's dashboard. From 2 October 2026 it opens with the period's evidence arriving as papers and filing into the register, the register shows all sixteen workstreams with the systems each reads, who prepared and reviewed it and its workpaper, and the loop resets into the opening (the founder wants it to reset, not settle).
- Team: no team section, names, bios or photos on About for now, and nothing on the page promises people ("don't name us yet"). The About heading is "The finance department, done properly." and the lede describes the team in one sentence. Decided by the founder on 1 and 2 October 2026.
- About, section 01 is the why as the big picture, not discovery: how finance departments have been built for decades, how each wave changed the tools and not the model, and how AI changes the model, so Solden is built as a finance department. Heading "Finance has changed its tools many times. Not its model." Closing line "Most companies will stop building a finance department. They will run on one." hands over to the vision line in 02. Asked for by the founder on 1 October 2026 ("the big picture of what has been the norm for ages and how it's evolved and where it is headed"). Settled on 2 October 2026 after two rewrites: the story is how finance has scaled, in the founder's words "when work increased, companies hired more, bought more software, etc". Heading "As the work grew, so did the department. It no longer has to." Each addition (hires, software, firms) solved this month's problem and added to next month's; AI breaks the link between more work and more people, tools and firms; Solden takes on the work as it grows. Do not frame the why around results or handing over. The About page tells the whole department, not the close: the lede is "building the finance department, one function at a time", the why speaks of the books, the forecast, the audit and the board pack, and the close appears only as the first function in the order and in the invite (what a company can buy today). Founder note, 2 October 2026: "it seems more about close than the vision".
- Analytics: Umami Cloud, free tier, EU region (Frankfurt), chosen by the founder on 1 October 2026 and live the same day (see Analytics). The tag carries `data-domains="soldenai.com"`, so local and preview visits are not counted.
- Company details (from the Companies House record, 2 October 2026): SOLDEN SYSTEMS LTD., company number 16823002, registered in England and Wales; formerly Clearledgr Ltd, renamed 23 June 2026. Every footer and both emails carry the name, place of registration and number. Keep the full stop in "Ltd.": it is part of the registered name. The registered office is kept off the site by founder decision (2 October 2026) because the current one is residential; once the registered-office service address is filed at Companies House, add it to the privacy policy (section 1 and 11), the terms (sections 1 and 13) and `COMPANY` in `lib/email.js`. A test blocks the old address.
- Legal pages: invite requests are kept for 24 months after the last contact, then deleted. The privacy policy names its processors (Resend, Railway, Umami), its legal bases per purpose, the transfer safeguards and the right to complain to the ICO. The terms keep the carve-out English law requires (death or injury from negligence, fraud), cap liability at the greater of £100 and twelve months' fees, and choose the law and courts of England and Wales. Set on 2 October 2026 on the founder's instruction to fix the review's legal findings; worth a solicitor's read before the first paid engagement.
- How it works is headed "From read-only to a live close, one stage at a time." Never "responsibility transfers": the terms keep statutory responsibility with the customer, and the founder rejected the handover framing. Decided 2 October 2026.
- The invite form's confirmation email never repeats what was typed, greets only a plain first name and stops site-wide after 20 an hour (`CONTACT_MAX_CONFIRMATIONS_PER_HOUR`); browser posts from another origin are refused. The team email is independent of the confirmation cap but still requires verification and durable admission.
