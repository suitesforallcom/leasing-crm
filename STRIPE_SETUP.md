# Stripe Integration — Setup Runbook

> **Status:** Phase 1 of 4 — Cloud Functions scaffold is done. Customer /
> Invoice / Auto-pay logic ships in the next sprints.

## Why Cloud Functions

Stripe has a strict rule: secret keys must NEVER live in client code. A
browser bundle that touches `stripe.customers.create(...)` with `sk_live_...`
is an immediate breach. So we run Stripe calls from Firebase Cloud Functions
(Node.js), which keep the secret server-side and get called from the browser
over authenticated HTTPS.

```
Browser (floor-map-editor.html)
    │    signed-in user calls httpsCallable(...)
    ▼
Cloud Function (functions/index.js)
    │    uses sk_live_… from Firebase Secrets
    ▼
Stripe API  →  sends invoice/receipt email  →  tenant pays
                                                    │
                                             Stripe Webhook
                                                    ▼
                                    Cloud Function writes paid=true
                                            to Firestore
                                                    ▼
                                    Payments matrix updates in real time
```

## One-time setup (do this once)

### 1. Install Firebase CLI (if you don't have it)

```bash
npm install -g firebase-tools
firebase login
```

### 2. Initialize the project link

```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map"
firebase use --add       # pick your project, alias "default"
```

### 3. Set Stripe secrets

Get your **live** secret key from
<https://dashboard.stripe.com/apikeys> (starts with `sk_live_...`).

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
# Paste the key when prompted; it won't echo.
```

The webhook signing secret is set AFTER first deploy (you need the
function's URL to create the webhook in Stripe). See step 6.

### 4. Install function dependencies

```bash
cd functions
npm install
cd ..
```

### 5. First deploy

```bash
firebase deploy --only functions
```

After this, Firebase prints URLs for your functions. Save the URL for
`stripeWebhook` — you'll need it in step 6.

Example:
```
Function URL (stripeWebhook):
  https://us-central1-your-project.cloudfunctions.net/stripeWebhook
```

Verify the deploy:

```bash
curl https://us-central1-your-project.cloudfunctions.net/ping
# Expected: {"ok":true,"service":"suitesforall-functions","time":"..."}
```

### 6. Register the webhook in Stripe

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. Endpoint URL: paste the `stripeWebhook` URL from step 5
3. Events to send — subscribe to:
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Create endpoint → copy the **Signing secret** (starts with `whsec_...`)

```bash
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
# Paste the whsec_... value.
```

### 7. Redeploy to pick up the webhook secret

```bash
firebase deploy --only functions
```

Done. From here on, the client UI will wire into these functions.

## Daily operations

### View function logs
```bash
firebase functions:log --only stripeWebhook
firebase functions:log --only ensureStripeCustomer
```

Or in the Firebase Console → Functions → Logs.

### Rotate a secret
```bash
firebase functions:secrets:set STRIPE_SECRET_KEY   # enter new value
firebase deploy --only functions                   # picks up new version
# After verifying, delete the old version:
firebase functions:secrets:destroy STRIPE_SECRET_KEY@<old-version>
```

### Test locally with the emulator

```bash
# In one terminal — start emulator
cd functions && npm run serve

# In another — forward Stripe webhooks to localhost
# (requires stripe-cli: https://stripe.com/docs/stripe-cli)
stripe listen --forward-to localhost:5001/YOUR-PROJECT/us-central1/stripeWebhook
```

## Cost expectations

For a ~50-tenant portfolio:
- Cloud Functions invocations: <1,000/mo → **free tier**
- Firestore reads/writes: ~10k/mo → **~$0.06/mo**
- Outbound networking: negligible
- **Stripe fees** — separate, paid to Stripe: **ACH 0.8% (capped $5)** or
  **2.9% + $0.30 for cards**

Expected total: **< $5/mo** Firebase-side for this scale.

## Security notes

- Never commit `.env` or keys. `functions/.gitignore` handles this.
- Every callable checks `requireEditor(auth, workspaceId)` — root admins
  (`ROOT_ADMINS` list in `functions/index.js`) plus workspace members with
  role `admin | manager | mapeditor` can invoke. Readers and TeamViewers
  cannot.
- The webhook endpoint verifies Stripe's signature before processing — a
  random HTTP request from the internet will fail immediately with 400.
- All secrets are fetched at function runtime from Firebase Secrets Manager
  (backed by Google Secret Manager). They're not visible in the function's
  source code or logs.

## What's built vs what's pending

| Task | Status |
|---|---|
| Scaffold Cloud Functions project | DONE |
| Webhook endpoint with signature verify | DONE (stubs inside) |
| `ensureStripeCustomer` callable | DONE |
| Data model: `u.stripe` / `state.stripeCustomers` | Next sprint |
| `createStripeInvoice` callable | Next sprint |
| Webhook → update `u.payments` on paid | Next sprint |
| `startAutoPay` (Subscription) callable | Sprint after |
| UI: Connect / Send / Auto-pay buttons | Sprint after |
| Paid-cell badge + Dashboard link | Sprint after |
| End-to-end test with test cards | Final |
