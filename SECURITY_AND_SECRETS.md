# SECURITY_AND_SECRETS.md

> Where secrets live, how to handle them, what NEVER to do.

## Top-line rule

**Claude must never write real secrets to any file in this repo.** Not in code, not in docs, not in commit messages, not in `.env`, not in chat output.

If Tony provides a secret in chat, Claude must:
1. Acknowledge receipt
2. NOT echo the secret back
3. NOT save it to any file
4. Direct Tony to the proper storage location (Firebase Console, GitHub Secrets, password manager, etc.)
5. Treat the chat message as ephemeral (do NOT include it in any future file or code)

## What counts as a secret

- API keys (Stripe `sk_live_*`, `sk_test_*`, `pk_live_*`, `pk_test_*`)
- Webhook signing secrets (`whsec_*`)
- Firebase Admin service account JSON contents (private key)
- Firebase Web SDK config — public-ish but still gated; treat conservatively
- DocuSign integration key, user ID, account ID (and especially the RSA private key)
- UniFi controller credentials
- OAuth client secrets
- Database connection strings with passwords
- Bank credentials (Plaid items, account/routing numbers)
- Personal data: tenant SSN, full bank info, ID document scans
- Session cookies, JWT tokens
- Sentry DSN (semi-public; OK in client code, but DO NOT echo in commit messages with full URL)

## Where secrets live (verified 2026-05-11)

| Secret | Location | Who manages |
|---|---|---|
| **Stripe API keys** | `functions/.env` (server-side) + Firebase Functions secrets | Tony — via `firebase functions:secrets:set` or `.env` for emulator |
| **Stripe webhook secret** | `functions/.env` (`STRIPE_WEBHOOK_SECRET`) | Tony |
| **Firebase Admin SDK** | Default service-account auto-injected into Functions runtime | Firebase platform |
| **Firebase Web SDK config** | Inline in `floor-map-editor.html` — `apiKey`, `authDomain`, `projectId` etc. (public-ish; gated by Firebase Auth + Firestore Rules) | Code, but rotate via Firebase Console if compromised |
| **DocuSign integration key + account ID + JWT key** | Tony's environment / `functions/.env` | Tony |
| **Sentry DSN** | Inline in `floor-map-editor.html` (public-ish; client SDK requires DSN) | Code |
| **UniFi controller** | `functions/.env` (host, user, pass) | Tony |

## What's in `functions/.env` right now

Per inspection 2026-05-11: file exists at `functions/.env`, ~805 bytes, NOT gitignored at the root level (functions has its own `.gitignore` that ignores `.env`). **Claude must not read this file.**

If the file's contents are ever needed for debugging (e.g. to check which Stripe mode is active), ask Tony to read it AND redact secrets before showing.

## What NEVER goes in git (even with .gitignore protection)

- Real `.env` files (`functions/.env`, root `.env`, anywhere)
- Real `serviceAccountKey.json` files
- Real private keys (`*.pem`, `*.p12`, `*.pfx` with private material)
- Sensitive customer data exports (CSV with tenant SSN, bank info)

## What's safe to commit

- Test-mode config flags (`STRIPE_MODE=test`)
- Public config (Firebase Web SDK config — already inline in `floor-map-editor.html`)
- Sentry DSN — client-side anyway
- API URL constants
- Feature flags

## When Tony says "store this key"

**Wrong response**: write it to `.env` or any file.
**Right response**: walk Tony through storing it in:
- **Firebase Functions secrets** (`firebase functions:secrets:set STRIPE_SECRET_KEY`)
- **Firebase Functions config** (legacy: `firebase functions:config:set stripe.secret=...`)
- **`functions/.env`** for local emulator (with `.gitignore` protection — verify before storing)
- **macOS Keychain** for personal dev secrets

In local-only mode, Claude does NOT run any of these `firebase functions:secrets` commands. Tony does, manually.

## When Tony asks Claude to read a secret

**Wrong response**: `cat functions/.env` and paste.
**Right response**: refuse and explain why:

> Я не должен читать `functions/.env` — он содержит реальные ключи (Stripe / DocuSign / UniFi). Если нужно проверить какой ключ там — открой его сам в редакторе или используй `grep` сам в терминале. Скажи мне результат БЕЗ секретов (например «Stripe в test-mode» вместо самого ключа).

## When Tony shares a secret in chat by mistake

If Tony pastes a real secret in the chat:

1. **Don't** save it to any file
2. **Don't** quote it back in your response
3. **Don't** include it in commit messages or code
4. Tell Tony immediately:

   > ⚠️ Ты только что вставил в чат что выглядит как `<TYPE OF SECRET>`. Я НЕ буду сохранять это никуда. Если этот ключ реальный и live — рекомендую немедленно отозвать его и сгенерировать новый в `<provider console>`. Если test/dev — всё равно лучше избегать в чате.

5. Continue the task without using the secret value

## Sentry release tag (semi-secret)

Production deploys use `<meta name="sfa-release" content="<commit-hash>">` — this is the Git commit hash of the deployed code. Not a secret per se, but it should match a real deploy.

In local-only mode: don't bake commit hashes into release tags. The `scripts/stamp-release.sh` script is OK to read, but don't run it as part of an unauthorized deploy.

## Firestore Security Rules (`firestore.rules`)

Source of truth for server-side authorization. Mirrors the role matrix in DECISIONS.md § 2 and `currentRole()` in JS. **Do not edit without Tony's approval** — this is the last line of defense if the UI gates fail.

If asked to review the rules:
- Read `firestore.rules` (no secrets in it; it's metadata)
- Verify each `allow read/write` matches the documented role matrix
- Report any discrepancy to Tony

## Cloud Storage CORS (`cors.json`)

Controls which origins can read uploaded files (receipts, lease PDFs, blueprints) directly from `firebasestorage.googleapis.com`. Currently configured for `https://suitesforall.web.app`. **Don't edit** without Tony's approval.

## How to handle "Cloud sync failed" banner

The banner has two action buttons (added 2026-05-10):
- **↑ Force push** — adopts cloud `_rev` and pushes local. Destructive.
- **↓ Pull cloud** — discards local. Destructive in opposite direction.

These are the operator's tools. **Claude doesn't click them automatically.** If Tony asks Claude to debug a sync issue:
1. Use Playwright (read-only) to inspect the page state + console
2. Read `state._rev` via JS (no secrets exposed)
3. Suggest the right action; let Tony click it

## Browser automation against production

If Tony approves browser automation (Chrome MCP, Playwright):
- **Read-only inspection** is OK (navigate, read DOM, read console, screenshot)
- **DO NOT** trigger destructive actions:
  - Submit payment forms
  - Send invoices
  - Change tenant data
  - Mark leases signed/voided
  - Click "Force push" sync buttons
  - Delete anything

Per CLAUDE.md and the safety rules in the system prompt, financial actions ALWAYS require Tony's explicit click — Claude observes, doesn't act.

## Secrets in commit messages

Don't paste:
- API keys
- Webhook URLs with embedded secrets
- Stripe invoice IDs from production (semi-sensitive: links a specific tenant to an amount)
- Customer email addresses (PII)
- Tenant names from production data (PII)

Do paste:
- Test-mode IDs (`in_test_*`)
- Anonymized examples (`Suite 101 → tenant <X>`)
- Public release tags (commit hashes)

## Audit log

Any time Claude potentially exposes a secret (even by accident), record it in SESSION_LOG.md with `⚠️` marker and timestamp. Tony reviews and rotates if needed.

## Escalation

If Tony asks Claude to do something that would expose a secret OR break security policy, REFUSE and explain:

> Я не могу `<action>` потому что это `<rule violation>`. Альтернативы: `<safer-path-1>`, `<safer-path-2>`. Хочешь чтобы я сделал альтернативу?

Don't compromise security policy "just this once". The whole point of these docs is that Tony can trust the rules to be applied uniformly.
