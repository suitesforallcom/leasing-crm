# Kiwi Rentals Lease — DocuSign Template Setup Guide

This guide walks you through turning `Kiwi-Rentals-Lease-TEMPLATE.html` into a live
DocuSign template that the SuitesForAll app can send with one click.

Total setup time: **~10 minutes.**

---

## What you'll end up with

A DocuSign template that:

- Contains the full Office Services Agreement (all 16 sections + Schedule A + Exhibits B, C, D)
- Has the **landlord side pre-signed** (script font + "Pre-signed" badge), so tenants receive an already-executed document
- Has **five client signature blocks** (main body, Schedule A, Exhibit B, Exhibit C, Exhibit D) that the tenant signs with one DocuSign session
- Auto-populates from the SuitesForAll app using merge fields (tenant name, rent, dates, suite, company, etc.)

---

## Step 1 — Prepare the document for upload

DocuSign accepts HTML and Word documents, but PDF gives the most predictable rendering.

**Easiest path: open the HTML in Word, export as PDF.**

1. Open `Kiwi-Rentals-Lease-TEMPLATE.html` in Microsoft Word
   - File → Open → select the .html file
   - Word imports the formatting
2. Review: page breaks, fonts, signature blocks
3. File → Save As → **PDF**
4. Save as `Kiwi-Rentals-Lease-TEMPLATE.pdf`

**Alternative: upload HTML directly.** DocuSign also accepts .html — if Word isn't
available, upload the HTML file. Formatting may shift slightly.

---

## Step 2 — Create the DocuSign template

1. Log in to DocuSign → **Templates** → **New** → **Create Template**
2. Name: `Kiwi Rentals — Office Services Agreement`
3. Description: `Standard office lease template — landlord pre-signed, tenant signs`
4. **Upload** the PDF from Step 1

---

## Step 3 — Add the recipient role

Only one role is needed because the landlord is pre-signed.

1. Click **Add Recipient**
2. **Role name:** `Tenant` (exactly — case-sensitive, the app sends this role name)
3. **Action:** Needs to Sign
4. **Routing order:** 1
5. Leave Name/Email blank (the app fills these per envelope)

---

## Step 4 — Place signature and date fields

The HTML template has **anchor markers** — short strings DocuSign auto-detects to
place fields. This saves you from dragging fields onto each page manually.

### Enable Auto-Place (Anchor Tagging)

1. In the template editor, go to **Custom Fields** → **Standard Fields**
2. Drag a **Signature** field onto the document near the first signature line
3. Right-click the field → **Advanced Options** → enable **Anchor Text**
4. Set anchor text to `\s1\` (including backslashes)
5. DocuSign will auto-find all matches — verify the preview

**Repeat for each of the five signature blocks:**

| Anchor | Location |
|--------|----------|
| `\s1\` | Main body (end of Section 16) |
| `\s2\` | Schedule A |
| `\s3\` | Exhibit B |
| `\s4\` | Exhibit C |
| `\s5\` | Exhibit D |

**Then for date-signed fields:**

| Anchor | Location |
|--------|----------|
| `\d1\` | Main body |
| `\d2\` | Schedule A |
| `\d3\` | Exhibit B |
| `\d4\` | Exhibit C |
| `\d5\` | Exhibit D |

Drag a **Date Signed** field, set anchor to `\d1\`, repeat for `\d2\`–`\d5\`.

**Tip:** You can also use DocuSign's "Auto-Place" feature — paste all anchors at once
into the anchor field if the editor supports bulk entry.

---

## Step 5 — Set up text merge fields

The template uses `{{field_name}}` placeholders that the app fills per tenant. Each
needs a **Text** field with the exact **Data Label** matching the field name.

### Required merge fields

| Data Label | What it is | Example |
|------------|------------|---------|
| `tenant_name` | Client signer name | Jane Doe |
| `client_company` | Client company (optional) | Acme Corp |
| `client_title` | Client title (optional) | CEO |
| `tenant_email` | Client email | jane@acme.com |
| `tenant_phone` | Client phone | (555) 123-4567 |
| `suite` | Suite number | 205 |
| `building_name` | Building name (from state.buildings) | Kiwi Rentals Plaza |
| `building_address` | **Building street address — auto-filled from the unit's building** | 6698 68th Ave N, Pinellas Park, FL 33781 |
| `headcount` | Authorized headcount | 4 |
| `lease_start` | Lease start date | 2026-05-01 |
| `lease_end` | Lease end date | 2027-04-30 |
| `term` | Term length | 12 months |
| `renewal_term` | Renewal terms | Monthly, market-adjusted |
| `rent` | Monthly rent (number) | 2500 |
| `deposit` | Security deposit (number) | 2500 |
| `landlord_name` | Landlord legal name | SuitesForAll, LLC |
| `landlord_title` | Landlord title | Authorized Signatory |
| `landlord_signed_date` | Pre-sign date | April 21, 2026 |

### Lease Defaults fields (from Settings → Lease Defaults)

These populate policy/pricing clauses throughout the contract. All live in
app Settings → Lease Defaults — change there once and every future lease
automatically picks up the new value. No DocuSign template edit needed.

**Provider Info:**

| Data Label | What it is | Default |
|------------|------------|---------|
| `provider_legal_name` | Provider's legal entity name (appears in 8+ places) | KIWI RENTALS LLC |
| `provider_entity_type` | Entity type / state of formation | Delaware limited liability company |
| `provider_legal_address` | Provider's registered / principal address | 108 West 13th Street, Wilmington, Delaware |

**Jurisdiction:**

| Data Label | What it is | Default |
|------------|------------|---------|
| `governing_state` | State whose law governs the agreement (Section XV) | Florida |
| `venue_county` | County where disputes / arbitration are venued | Pinellas County |

**Financial Terms:**

| Data Label | What it is | Default |
|------------|------------|---------|
| `late_fee_pct` | Late fee % on unpaid amounts | 8 |
| `interest_rate_pct` | Annual interest % on unpaid amounts | 12 |
| `nsf_fee` | Returned-check / NSF fee ($) | 30 |
| `renewal_adjustment_pct` | Renewal market-rate adjustment cap (%) | 3 |
| `non_renewal_notice_days` | Days of notice required to opt out of auto-renewal | 60 |
| `early_term_notice_days` | Early-termination notice period (days) | 90 |
| `liability_cap_pct` | Liability cap as % of prior 12-month Base Fees | 125 |
| `confidentiality_years` | Post-termination confidentiality period (years) | 3 |

**Exhibit C — Price Guide:**

| Data Label | What it is | Default |
|------------|------------|---------|
| `price_bw_copy` | Black-and-white copy ($ per page) | 1.00 |
| `price_color_copy` | Color copy ($ per page) | 1.75 |
| `price_scan` | Scanning ($ per job) | 2 |
| `price_card_replacement` | Access card / key replacement ($) | 50 |
| `price_rekey` | Lock rekey ($) | 50 |
| `fee_returned_payment` | Returned-payment fee ($) | 30 |
| `fee_assignment_review` | Assignment review fee ($) | 100 |
| `price_virtual_office` | Virtual office ($/month, blank if not offered) | *(blank)* |

### How to configure each field

1. Drag a **Text** field onto the document over the blue `{{field_name}}` placeholder
2. Right-click → **Advanced Options**
3. **Data Label:** set to the exact field name (e.g., `tenant_name`)
4. **Read Only:** ✅ check (prevents tenant from editing landlord data)
5. **Required:** uncheck (empty fields render blank, which is acceptable)
6. Size the field to match the placeholder

**Faster approach — anchor-based text fields:**

Instead of dragging each field, use text anchor tagging:

1. Drag one Text field
2. Set **Anchor Text** to `{{tenant_name}}`
3. Enable **Anchor Match Whole Word**
4. Set **Data Label** to `tenant_name`
5. DocuSign auto-places the field on every match

Repeat for each merge field. Total time: ~5 minutes.

---

## Step 6 — Finalize the template

1. Click **Save and Close** in the template editor
2. Copy the **Template ID** from the template's URL or details panel
   - Format: `12345678-1234-1234-1234-123456789012` (36-char UUID)

---

## Step 7 — Connect the template to SuitesForAll

1. Open the SuitesForAll app
2. Click the gear icon → **Settings** → scroll to **DocuSign Integration**
3. Click **Connect DocuSign** (complete OAuth if not done)
4. **Landlord Name** field: enter the name that should appear as pre-signed (e.g. "Tony Smith")
5. **Landlord Title** field: enter title (e.g. "Managing Member")
6. **Template ID** field: paste the UUID from Step 6
7. Click **Save**

---

## Step 8 — Test before going live

1. Create a test tenant in the app:
   - Name: `Test Tenant`
   - Email: **your own email** (so you receive the test)
   - Suite: pick any vacant unit
   - Term: 12 months
   - Fill in rent, deposit, lease start
2. Click **Send Lease** in the right panel
3. Check your inbox — you should receive the DocuSign envelope within a minute
4. Open it:
   - ✅ Landlord signature line shows script-font signature with "Pre-signed" badge
   - ✅ Tenant signature fields are empty and clickable (5 total)
   - ✅ Tenant name, rent, dates are filled in from the app
5. Sign all 5 signature blocks, complete
6. Confirm in DocuSign dashboard that the envelope shows as completed

**If any field renders as literally `{{field_name}}`:** the Data Label doesn't match.
Go back to the template editor and verify spelling.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Tenant name shows as `{{tenant_name}}` | Data Label typo | Edit field, confirm Data Label matches exactly (no spaces, lowercase) |
| Multiple signature blocks not auto-placed | Anchor text mismatch | Verify anchor includes backslashes: `\s1\` not `s1` |
| Landlord section shows as empty | `landlord_name` not merged | Confirm Landlord Name is filled in Settings, template uses `landlord_name` Data Label |
| Envelope sends but recipient gets "template error" | Role name mismatch | Role must be exactly `Tenant` |
| Extra fields appear as empty | Template has unused merge fields | Remove them, or leave as optional (renders blank) |

---

## Going to production

After test passes:

1. In DocuSign, mark the template as **Shared** if multiple users need access
2. Set your brand logo in DocuSign → **Branding** (optional, looks more professional)
3. In SuitesForAll, all new tenant leases now auto-send using this template
4. If you later change **policy values** (late fee %, jurisdiction, copy prices, etc.),
   edit them in **Settings → Lease Defaults** in the app — no template re-upload required
5. If you change **clause wording** (new sections, rephrased rules, etc.), edit the
   HTML template, regenerate the PDF, and re-upload as a new version — DocuSign
   preserves your field positions

## Changing policy values without re-uploading the template

One-time setup: configure every `{{field_name}}` in the template as a Text tab with
matching Data Label (per Step 5).

From then on, **all policy values are edited in the app, not DocuSign**:

1. Open the app → Settings → scroll to **Lease Defaults**
2. Edit: Provider Info, Jurisdiction, Financial Terms, or Price Guide
3. Click **Save Lease Defaults**
4. The next lease you send automatically uses the new values

This means a price hike, jurisdiction change, or entity restructuring only takes
~30 seconds in Settings — not a multi-hour template edit cycle.

---

## How the pre-signed pattern works

Traditional DocuSign flow: both parties sign via DocuSign.

Our flow: **landlord pre-signs in the document itself** (by rendering the landlord's
name in a script font during template preparation), and DocuSign is used only for the
**tenant** side. This is valid under E-Sign Act as long as:

- The landlord has authorized the template (you did, by configuring it)
- The landlord's name appears clearly on the document
- An audit trail exists (DocuSign's envelope history covers this)

This pattern is common for standardized leases and service agreements.

---

## Sending additional tenant-specific fields

The app currently auto-sends these fields from the tenant/unit record:

- Tenant: name, email, phone, company
- Lease: start date, end date, term, rent, deposit, suite
- Landlord: name, title, pre-signed date

Fields the template supports but the app doesn't yet prompt for:

- `client_title` — tenant's job title (e.g., "CEO")
- `headcount` — authorized employee count per Section 1

If these are required on every lease, add them as inputs in Quick Add or the right panel.
Ask Claude to wire them in — it's a 5-minute change.

---

**Questions?** The template is in
`/Users/diskc/Documents/Claude/Projects/Office map/Kiwi-Rentals-Lease-TEMPLATE.html`
— open it in a browser to preview before uploading.
