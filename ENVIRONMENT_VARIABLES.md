# ENVIRONMENT_VARIABLES.md

> Inventory of env vars referenced anywhere in the project. **No real values.** This file is documentation only.

## Where env vars are loaded from

| Layer | Source | When loaded |
|---|---|---|
| **Cloud Functions** | `functions/.env` (local emulator) + Firebase Functions secrets (production) | At function cold-start |
| **Browser app** | None — Firebase Web SDK config is inline in `floor-map-editor.html` | At page load |
| **Tests** | `PW_BASE_URL` (Playwright), and any other Playwright env config | At `npx playwright test` invocation |

## Cloud Functions env vars (`functions/.env` — gitignored)

The file exists at `functions/.env` and is gitignored via `functions/.gitignore`. Claude must NOT read it (per SECURITY_AND_SECRETS.md). The variables below are the ones referenced by `functions/index.js` based on past inspection — exact list may evolve; Tony confirms via direct file read.

| Variable | Purpose | Mode | Required? |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key for invoice creation, customer ops | live or test | ✓ for billing |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhook signatures | live or test | ✓ for webhook handler |
| `STRIPE_MODE` | `live` or `test` — determines which set of keys is in use | both | recommended |
| `DOCUSIGN_INTEGRATION_KEY` | DocuSign integration (client) ID | live | ✓ for lease envelopes |
| `DOCUSIGN_USER_ID` | DocuSign user ID for JWT auth | live | ✓ |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account ID | live | ✓ |
| `DOCUSIGN_PRIVATE_KEY` | RSA private key for JWT auth (multi-line; quote-escaped) | live | ✓ |
| `DOCUSIGN_BASE_URL` | DocuSign API base (sandbox vs prod) | live | ✓ |
| `UNIFI_HOST` | UniFi controller IP/hostname | live | optional (Phase 4) |
| `UNIFI_USER` | UniFi controller username | live | optional |
| `UNIFI_PASS` | UniFi controller password | live | optional |
| `SENTRY_DSN_FUNCTIONS` | Sentry DSN for server-side error tracking (Functions) | both | optional |
| `LATE_FEE_DEFAULT_PCT` | Default late-fee percentage (overridable per building) | both | optional |
| `LATE_FEE_GRACE_DAYS` | Default grace period in days | both | optional |

**Do NOT** create `functions/.env.example` with stub values either — the real `.env` is the canonical source. If a new function needs a new env var, Tony adds it manually to both local `.env` AND production via `firebase functions:secrets:set`.

## Browser app config (inline in `floor-map-editor.html`)

The Firebase Web SDK config is inline in the HTML. It's semi-public (gated by Firebase Auth + Firestore Rules) but treated as configuration, not a secret. Verified 2026-05-11 — these constants exist in the file:

| Constant (in code) | Purpose |
|---|---|
| `FIREBASE_HARDCODED_CONFIG` | Inline `{ apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId }` |
| `WORKSPACE_ID` | Firestore workspace document ID for current install |
| `SENTRY_DSN` | Sentry DSN for client-side error tracking |
| `STRIPE_PUBLISHABLE_KEY` | Stripe `pk_*` for client-side Stripe.js (read from Settings, NOT inline by default) |

**These are intentionally inline.** Don't move them to env vars without Tony's approval — would break the single-file philosophy AND require a build step.

## Tests env vars

| Variable | Purpose | Default | Used by |
|---|---|---|---|
| `PW_BASE_URL` | Playwright base URL — what to test against | `https://suitesforall.web.app` (production) | `tests/playwright.config.ts` |
| `PW_HEADED` | Run Playwright with browser visible (debugging) | unset (headless) | `tests/specs/*.spec.ts` (if used) |
| `PW_SLOW_MO` | Slow each Playwright action by N ms (debugging) | unset | (if used) |

To run against local server:
```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94"
python3 -m http.server 5577 &
cd tests
PW_BASE_URL=http://localhost:5577 npx playwright test
```

## Shell env vars Claude must NOT modify

- `~/.zshrc` / `~/.bashrc` / `~/.profile` — Tony's shell config
- `FIREBASE_TOKEN` — used to be set globally for CI; per past incident (2026-05-03 in legacy logs), `~/.zshrc` had a literal `"ВСТАВЬ_СЮДА_ТОКЕН"` placeholder breaking deploys. **Don't write to `~/.zshrc`.**
- `PATH` — never extend
- `FIREBASE_PROJECT` — Tony manages

If a deploy fails due to env vars, **stop and tell Tony** — don't try to fix the shell config.

## Per-developer env vars

If Tony has multiple machines or developers later:
- `functions/.env` differs per machine (test mode keys)
- Production uses `firebase functions:secrets:get` (server-side only)
- No `.env.development` / `.env.production` split files exist; not worth introducing in single-file architecture

## .env file template (for reference only — do NOT create real)

If Tony asks "what should `functions/.env` look like for a fresh install":

```bash
# functions/.env — local emulator config (DO NOT COMMIT)
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
STRIPE_MODE=test

DOCUSIGN_INTEGRATION_KEY=REPLACE_ME
DOCUSIGN_USER_ID=REPLACE_ME
DOCUSIGN_ACCOUNT_ID=REPLACE_ME
DOCUSIGN_BASE_URL=https://demo.docusign.net/restapi
DOCUSIGN_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
PUT-MULTILINE-KEY-HERE
-----END RSA PRIVATE KEY-----"

UNIFI_HOST=192.168.1.1
UNIFI_USER=admin
UNIFI_PASS=REPLACE_ME

SENTRY_DSN_FUNCTIONS=https://REPLACE@oXXX.ingest.sentry.io/XXX
LATE_FEE_DEFAULT_PCT=10
LATE_FEE_GRACE_DAYS=5
```

⚠️ **Don't create this file with these literal values.** This is documentation only. Real values come from Tony.

## How to verify env vars are loaded

In a Cloud Functions emulator session (only if Tony approves):

```bash
cd functions
firebase emulators:start --only functions
# In another terminal, hit a function endpoint and check logs:
firebase functions:log
# Look for early-startup log messages indicating which secrets are present.
```

Don't grep `functions/.env` directly — that exposes secrets to the chat.

## CORS environment

`cors.json` at the project root configures Firebase Storage CORS. Currently allows `https://suitesforall.web.app`. If Tony wants `localhost:5577` added for local dev, **ask first** — modifying `cors.json` and applying it via `gsutil cors set cors.json gs://<bucket>` is a production-side change.

## When env vars change

Update this file's table within the same commit. Don't let inventory drift from reality. If an env var is removed, mark it `(removed YYYY-MM-DD)` in the table for one revision, then delete from a future commit.
