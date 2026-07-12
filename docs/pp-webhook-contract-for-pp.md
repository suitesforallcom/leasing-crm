# SuitesForAll → PropertyPulse Webhook Contract (v1)

> Hand this document to the PropertyPulse team. It is the complete receiver-side
> contract for the `building.changed` webhook. SuitesForAll (SFA) is the source
> of truth; the webhook carries **identifiers only** — PropertyPulse (PP) pulls
> actual data via the existing authenticated export endpoint.

## 1. Architecture: notify + pull

1. Something changes in SFA (building / unit / tenant / payment).
2. SFA POSTs a small signed **signal** to your webhook URL (≤1 notification per
   building per 60 s; bursts are coalesced — you get the latest).
3. On receipt, PP calls the existing export endpoint to fetch current data:
   `GET https://us-central1-suitesforall.cloudfunctions.net/ppOfficeExport?buildingId=<payload.buildingId>`
   with your existing `Authorization: Bearer <PP_EXPORT_API_KEY>` auth.
   Use `buildingId` from the payload (immune to an empty `excelId`).

The webhook is a freshness hint, **never** a data carrier. Order of arrival
carries no meaning — always pull current state.

## 2. Request format

```
POST <your webhook URL>            (HTTPS only)
Content-Type: application/json
X-Signature: t=<unixSeconds>,v1=<hex hmac-sha256>
```

Body (raw bytes are signed — see §3):

```json
{
  "event": "building.changed",
  "buildingId": "b1717862400000",
  "excelId": "217.1",
  "changedAt": "2026-06-09T18:42:11.000Z",
  "schemaVersion": 1,
  "source": "suitesforall",
  "workspaceId": "default",
  "sentAt": "2026-06-09T18:43:10.000Z",
  "deliveryId": "0b7c9a4e-...-uuid",
  "deleted": true
}
```

| Field | Notes |
|---|---|
| `event` | Always `building.changed` in v1. |
| `buildingId` | SFA building id. **Authoritative key for the pull.** |
| `excelId` | PP crosswalk id, or `null`. Untrusted routing hint (≤64 chars) — the authoritative crosswalk is whatever the authenticated pull returns. |
| `changedAt` | Time of the LAST coalesced change (may predate `sentAt` by up to ~2 min due to debounce). |
| `sentAt` | Send time. |
| `deliveryId` | UUID, constant across retries of one delivery. **Dedup key.** |
| `deleted` | Present (`true`) ONLY when the building was deleted in SFA. Absent otherwise. |
| `schemaVersion` | Payload schema version; additive changes won't bump it. |

## 3. Signature verification (REQUIRED)

`X-Signature: t=<unixSeconds>,v1=<hex>` where
`hex = HMAC_SHA256(PP_WEBHOOK_SECRET, "<t>" + "." + rawBody)`.

Verify in THIS order, all failures → respond `401` with empty body:

```js
// Node.js reference implementation
const crypto = require('node:crypto');

function verify(rawBodyBuffer, headerValue, secrets /* array — see rotation */) {
  const m = /^t=(\d+),(.+)$/.exec(headerValue || '');
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isInteger(t)) return false;
  // 1. Timestamp window BEFORE crypto: reject |now − t| > 300 s (replay guard).
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  // 2. Collect every v1=<hex> entry (there may be several during key rotation).
  const sigs = m[2].split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!sigs.length) return false;
  // 3. Compare against EVERY active secret; accept if ANY matches.
  for (const secret of secrets) {
    const expect = crypto.createHmac('sha256', secret)
      .update(`${t}.`).update(rawBodyBuffer).digest('hex');
    const a = Buffer.from(expect, 'utf8');
    for (const sig of sigs) {
      const b = Buffer.from(sig, 'utf8');
      // timingSafeEqual THROWS on length mismatch — length-check first.
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}
```

Critical traps:
- **Verify over the raw received bytes BEFORE JSON-parsing.** Re-serializing the
  parsed body will not round-trip byte-identically.
- `crypto.timingSafeEqual` throws on length mismatch — check lengths first.
- Parse the header strictly: missing `t`, non-integer `t`, or zero `v1` entries → reject.

## 4. Dedup, retries, ordering

- SFA retries failed deliveries up to 4 attempts (≈5/15/30 s backoff). Each
  attempt re-signs with a **fresh `t`**; `deliveryId` stays constant.
  **Dedup by `deliveryId` for ≥15 minutes** (a 500-then-200 sequence will
  otherwise double-process).
- Delivery is **at-least-once**; duplicates and out-of-order arrivals are
  normal. Since you always pull current state, both are harmless.
- Respond `2xx` fast (<10 s; SFA aborts the attempt at 10 s). Do the pull
  asynchronously after acking — do not make SFA wait on your pull.
- A non-2xx/timeout after 4 attempts = the notification is **dropped** on the
  SFA side (logged there, not re-queued).

## 5. Periodic full pull — REQUIRED, not optional

Because give-up drops notifications and delivery is at-most-once after the
retry budget, PP MUST run a periodic catch-up full pull (recommended: hourly):
`GET …/ppOfficeExport` (no filter) and reconcile everything. The webhook only
makes the mirror *fresh*, the periodic pull makes it *complete*.

## 6. `deleted: true` handling

Honor `deleted` only after the full verification chain (signature → timestamp
window → deliveryId dedup), and ideally confirm with a pull: `?buildingId=…`
returning `buildingCount: 0` confirms the building is gone. Never hard-delete
PP-side data on the webhook alone if a soft-delete/flag is available.

## 7. Key rotation

`PP_WEBHOOK_SECRET` is a 256-bit hex string shared out-of-band. Rotation:

1. PP adds the NEW key to its verifier key list (now accepts both — §3 loops all secrets).
2. SFA switches Secret Manager to the new key and redeploys its functions.
3. After 24 h of clean deliveries, PP removes the old key.

Your verifier looping over a key array (step §3.3) is what makes this
zero-downtime.

## 8. What triggers a notification (and what doesn't)

Fires: any PP-visible building/floor/unit/tenant/lease change; payment
recorded / voided / Stripe-paid; building created or deleted.
Does NOT fire: map geometry edits (unit drag/resize), SFA-internal metadata,
no-op rewrites. If nothing PP-visible changed, no webhook is sent.

## 9. Test vector

```
secret  = "test-secret"
t       = 1700000000
rawBody = {"event":"building.changed"}
v1      = HMAC_SHA256("test-secret", "1700000000.{\"event\":\"building.changed\"}")
        = 95afc749d304a9b17965aa77435a6c9c402eebc30fa97f9a68394f8b166199b5
```

Compute this in your implementation and compare with SFA's reference test
(functions/pp-webhook.test.js, «sig: regression vector») before going live.
