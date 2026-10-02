# Solden marketing site

The public site at [soldenai.com](https://soldenai.com). Static HTML, CSS and one small script, no framework, no build step, plus one serverless function that delivers the invite form to a founder inbox.

Content follows the marketing site brief (17 September 2026) and the founder-locked language in [`soldensystems/solden`](https://github.com/soldensystems/solden) (`AGENTS.md`, `docs/SOLDEN_FOUNDER_MEMO.md`). `npm test` enforces the language rules and the site's structure on every page.

## Pages

Everything the visitor can fetch lives in `public/`. The server serves that directory and nothing else, so `lib/`, `tests/`, this README and the config files are never public.

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `public/index.html` | Hero with the animated close frame, the systems diagram (`#connects`), what you are hiring (`#hiring`), the close end to end (`#close`), access and controls (`#controls`), the buying test (`#test`), invite form (`#invite`) |
| `/how-it-works` | `public/how-it-works.html` | What Solden takes on (`#work`), the pack (`#pack`), who decides (`#who-decides`), the controls register (`#controls`, also `#security`), what happens when it is wrong (`#when-wrong`) |
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
- **`api/contact.js`** is the handler for `POST /api/contact`, mounted by `server.js`. The logic lives in `lib/contact.js` so it is testable and host-independent: it validates, traps bots with a honeypot and a minimum fill time, rate limits per hashed IP, optionally records the lead in Postgres (`lib/store.js`) and emails the founder inbox through Resend with the prospect as reply-to and the subject `Invite request: <company>`. The store is attached lazily and every database call is capped, so a slow or dead database never blocks the email.
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
   | `CONTACT_MAX_PER_IP_PER_HOUR` | no | Defaults to 5. Anything that is not a positive number falls back to 5 |
   | `DATABASE_URL` | no | Postgres for lead history and durable rate limits. In the same project use the private reference `${{leads-db.DATABASE_URL}}`: no TLS needed on the private network |
   | `DB_SSL` | no | `true` to connect over TLS and verify the server certificate against the public CAs |
   | `DB_SSL_CA` | no | PEM certificate authority to verify against instead. Paste the certificate, newlines as `\n` are accepted. Implies TLS |
   | `DB_SSL_NO_VERIFY` | no | `true` to encrypt without verifying the certificate. Only for Railway's public TCP proxy from outside the project. Implies TLS |
   | `TRUST_PROXY` | no | Set automatically to one hop on Railway. Set it by hand (`1` or `loopback`) only on another host behind a known proxy |

   The handler never waits on the database: connecting, the recent-count check and the insert are each capped at two seconds, and on a timeout or error the lead is emailed anyway and the failure is logged. A failed connection is retried on the next request.

3. Verify on the service's `*.up.railway.app` URL: pages, redirects, `/healthz` answers `ok`, `/api/contact` answers `405` to a GET, `/README.md` and `/lib/contact.js` answer `404`, and one real form submission reaches `hello@soldenai.com`.
4. The custom domains `soldenai.com` and `www.soldenai.com` are already on the service, and Namecheap already points at their Railway targets (the apex as an `ALIAS`, `www` as a `CNAME`). Nothing to add.
5. Only if a domain is ever moved to another service: at Namecheap, change ONLY two records: the apex record for `soldenai.com` (an `ALIAS` record to the Railway target; Namecheap supports `ALIAS` at the apex) and the `CNAME` for `www`, to the values Railway shows. Keep every other record exactly as it is. The zone carries the Microsoft 365 mail records (`MX`, the SPF `TXT`, DKIM `CNAME`s, the `_dmarc` `TXT`) and the Resend sending records (DKIM and return-path `TXT`/`MX`); deleting or replacing any of them stops founder mail or lead delivery. The `www` host redirects to the apex in `server.js`.
6. Keep **leads-db**. Nothing else in the project serves this site.

## Lead history

The previous site stored submissions in the `leads-db` Postgres in the same Railway project. It is still online, so point `DATABASE_URL` at it with the private reference and history stays in one place: the handler writes the same `leads` table, a subset of the old columns.

From outside the project, Railway's public TCP proxy presents a self-signed certificate, so with the public connection URL set `DB_SSL_NO_VERIFY=true` (encrypted, unverified). With a provider that offers a real certificate chain use `DB_SSL=true`, or `DB_SSL_CA` with the provider's CA, so the connection is verified. The table and index are created on the first request with `CREATE ... IF NOT EXISTS`, so no migration step is needed.

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
- Hosting location, retention schedules and contract terms such as the DPA, subprocessors and data-protection law belong in the terms and the customer agreement, never on the marketing pages. For the agreement: hosting is in the UK and EU, with other regions served as local law requires.
- The animated hero frame is an accepted device: a directed sequence inside a product-like close workspace, with a pause control and a static finished state under reduced motion. It shows how the work runs, not a customer's numbers.
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
- About, section 01 is the why as the big picture, not discovery: how finance departments have been built for decades, how each wave changed the tools and not the model, and how AI changes the model, so Solden is built as a finance department. Heading "Finance has changed its tools many times. Not its model." Closing line "Most companies will stop building a finance department. They will run on one." hands over to the vision line in 02. Asked for by the founder on 1 October 2026 ("the big picture of what has been the norm for ages and how it's evolved and where it is headed"). Rewritten on 2 October 2026 as an argument rather than a timeline, guided by how Hyphenate wrote its story but never copying its lines or sentence patterns: heading "Finance has been staffed for decades. It has never been handed over."; each hire took a piece of the work and none took the result; the steps got faster, the month did not; what no company could buy was someone else to answer for the result; every figure traces back through its workpaper to its source document.
- Analytics: Umami Cloud, free tier, EU region (Frankfurt), chosen by the founder on 1 October 2026 and live the same day (see Analytics).
