# QA_CHECKLIST.md

> Pre-change and post-change checks. Use this as a literal checklist — do not skip steps. Active mode: **auto-deploy + auto-push** (CLAUDE.md § "Project Mode (active)").

## Before any change

- [ ] **Read CLAUDE.md** § Project Mode at top — confirm active mode (currently auto-deploy + auto-push)
- [ ] **`git status`** — working tree clean (or only untracked screenshots / `.claude/` / `.playwright-mcp/`)
- [ ] **`git rev-parse HEAD`** — capture the rollback target
- [ ] **`git branch --show-current`** — confirm correct branch
- [ ] **Read DECISIONS.md** § 6 — re-read latent bugs / pitfalls list
- [ ] **Read SESSION_LOG.md** tail-50 — what's recent context, what's open
- [ ] **Identified target functions** via `grep -n "function targetName"` (don't guess line numbers)
- [ ] **Decided whether change requires Tony's approval** (see CLAUDE.md "Tony Approval Required" + RISK_MATRIX.md)

If approval needed → STOP and ask. If not → proceed.

## During the change

- [ ] **Edit one logical thing** — don't bundle unrelated tweaks
- [ ] **Comments in Russian**, identifiers English
- [ ] **Touch ≤ 3-5 files** per pass (legacy CLAUDE.md § 9), unless Tony explicitly approved more
- [ ] **No new dependencies** — `package.json` files are frozen
- [ ] **No `.env` mutations** — secrets handling per SECURITY_AND_SECRETS.md
- [ ] **No deletes/renames** of important files without approval
- [ ] **`Edit` tool, not `Write`** — preserves existing content; `Write` is only for net-new files

## Mandatory post-change checks

### A) Parse-check (after every edit to `floor-map-editor.html`)

```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94"
node -e "
const fs = require('fs');
const html = fs.readFileSync('floor-map-editor.html', 'utf8');
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0, errs = 0;
while ((m = re.exec(html))) {
  idx++;
  const body = m[1];
  if (!body.trim()) continue;
  const tag = m[0].slice(0, m[0].indexOf('>') + 1);
  if (/type\s*=\s*[\"']text\/(?!javascript)/i.test(tag)) continue;
  try { new Function(body); } catch (e) { errs++; console.error('Block', idx, ':', e.message); }
}
console.log('Parsed', idx, 'blocks,', errs, 'errors.');
process.exit(errs ? 1 : 0);
"
```

✅ Expected: `Parsed 3 blocks, 0 errors.`
❌ Anything else → fix syntax error before committing.

### B) Identifier sanity (after function-add or rename)

```bash
grep -n "function _yourNewHelper\b" floor-map-editor.html
grep -n "_yourNewHelper(" floor-map-editor.html | head -5
```

Confirm the new identifier is defined exactly once and called from where you expect.

### C) Sentry-equivalent: console.errors check

⚠️ **DOM-attribute exceptions don't reach Sentry**. Check browser console manually for the affected page.

If Tony has Chrome MCP available and approves browser inspection:

```javascript
// in browser console, on the page after the change:
console.errors_seen_so_far  // (no such API; check the Console panel manually)
```

For Playwright equivalent:
```bash
cd tests
PW_BASE_URL=http://localhost:5577 npx playwright test --headed --grep "app-loads"
# Watch the spec output for [ERROR] lines from console.
```

(Past incident: `_labelFontFor Infinity → tspan dy SVG parse failure` was invisible to Sentry; only Playwright `console.errors` caught it. See DECISIONS.md § 6.)

### D) Playwright smoke (when behavior of boot / auth / render changed)

```bash
cd tests
npx playwright test          # default = production target
# OR
PW_BASE_URL=http://localhost:5577 npx playwright test
```

Specs:
- `app-loads.spec.ts` — page renders, Sentry inits, no console errors, release tag valid
- `auth-gate.spec.ts` — unauth visitors see login

✅ All specs pass → safe to commit.
❌ Spec fails → diagnose, fix, re-run. Don't disable a spec without Tony's approval.

### E) Manual visual check (when UI changed)

Open the affected screen in the browser:

```bash
open "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94/floor-map-editor.html"
```

Or via local server if testing auth/sync:

```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94"
python3 -m http.server 5577
# then open http://localhost:5577/floor-map-editor.html
```

Click around the changed feature. Watch DevTools Console for red errors. Verify:
- New element appears where expected
- Existing elements still present (regression check)
- No layout shift / overflow on touched view
- Mobile layout still readable (use Chrome DevTools device toolbar)

## Commit hygiene check

Before `git commit`:

- [ ] **Specific files only** — `git add path/to/file`, NOT `git add .`
- [ ] **Heredoc commit message** — multiline body explaining WHY
- [ ] **No secrets** in commit message (no API keys, tokens, passwords)
- [ ] **No `--amend`** if previous commit landed
- [ ] **No `--no-verify`**

## Auto-fires after a clean commit (no per-action approval)

- ✅ `bash scripts/stamp-release.sh` (stamps commit hash into `<meta name="sfa-release">`)
- ✅ `firebase deploy --only hosting`
- ✅ `git push origin fix/autobilling-respect-archive-filters`
- ✅ `mcp__sentry__update_issue ... status='resolved'` when commit explicitly fixes a tracked `SUITESFORALL-NN`

## Non-negotiable: do NOT auto-fire (require explicit Tony approval)

- ❌ `firebase deploy --only functions` (Cloud Functions changes)
- ❌ `git push --force` / `git push --force-with-lease`
- ❌ `git reset --hard` (destructive)
- ❌ `git clean -fd` (destructive)
- ❌ `rm -rf` on anything tracked
- ❌ Any `npm install <pkg>` without Tony's approval
- ❌ Editing `firebase.json` / `firestore.rules` / `firestore.indexes.json` / `cors.json` without approval
- ❌ Editing `functions/.env`
- ❌ Touching `tests/playwright.config.ts` to disable specs
- ❌ Anything in CLAUDE.md § "Financial-model gate" until FINANCIAL_MODEL_REFERENCE.md validation

## Special cases by area

### Editing financial logic (`u.payments`, `u.contractRent`, `u.rent`, late-fee triggers)

⚠️ **REQUIRES TONY'S EXPLICIT APPROVAL** before touching. AND must pass the **Financial-Model Gate** (set 2026-05-11) — see `FINANCIAL_MODEL_REFERENCE.md`.

If approved:
- [ ] Read **`FINANCIAL_MODEL_REFERENCE.md` § 6 pre-commit checklist** FIRST — this is the canonical Kiwi-vs-SuitesForAll gate
- [ ] Read PAYMENTS_AND_FINANCE_RULES.md (SuitesForAll specifics)
- [ ] Identify all callsites of the changed function (`grep -n "fnName("`)
- [ ] Check that `_isFinanceShadow` skip is honored (multi-suite shadow units must not double-count)
- [ ] Verify the change doesn't break the optimistic-locking `_rev` flow
- [ ] Test with a manual payment record (use a fake suite with $1 rent)
- [ ] Cross-check formula against `financial-model/FINANCIAL_LOGIC_RULES.md` — find the relevant § 1-§ 19 rule
- [ ] If divergence from Kiwi rules: log it under FINANCIAL_MODEL_REFERENCE.md § 7 «Discrepancies log» BEFORE commit

### Editing auth / permissions (`canEdit`, `canSeeFinance`, `currentRole`, etc.)

⚠️ **REQUIRES TONY'S EXPLICIT APPROVAL**.

If approved:
- [ ] Read AUTH_AND_PERMISSIONS_RULES.md first
- [ ] Mirror the change in `firestore.rules` (defense-in-depth — UI gate AND server gate)
- [ ] Test with each role: admin, manager, mapeditor, teamviewer, viewer
- [ ] Verify CSS body-class gates still match the JS gates

### Editing rendering (`renderUnits`, `renderHomeForecast`, etc.)

- [ ] Re-verify `_labelFontFor` guard is intact (prevents Infinity tspan crash)
- [ ] Test on small viewport (Chrome DevTools 320×568 mobile)
- [ ] Test on huge viewport (1440×900 desktop)
- [ ] Test at minimum zoom (whole-floor visible) AND maximum zoom (one unit fills view)
- [ ] Verify clicks still register on units after the change (the most common regression)

### Adding a new doc file

- [ ] Filename matches the doc map in CLAUDE.md (don't invent random names)
- [ ] Cross-link to related docs (e.g. "see DECISIONS.md § X" instead of duplicating content)
- [ ] Update CLAUDE.md doc map if the new file is meant to be read regularly
- [ ] Add a one-liner under "## How to update this file" if applicable

## When checks fail

| Failure | Action |
|---|---|
| Parse-check fails | Fix syntax. Don't commit broken code. |
| Playwright spec fails | Read the spec; understand if your change breaks contract or the spec is stale. **Don't** silently disable — ask Tony. |
| Manual visual regression | Roll back the file, ask Tony to clarify intent. |
| Console errors after change (DOM exceptions) | Treat as critical. Fix or roll back. |
| Identifier collision (duplicate function) | Rename or remove. |
| State BC break (operator's saved data won't load) | **STOP**. Roll back. Report to Tony. |

## Confidence levels

After running the checks above, classify the change:

- **High confidence** ✓ — parse + manual visual + Playwright all clean → commit + report.
- **Medium confidence** ⚠️ — parse passes but Playwright not run (e.g. doc edit) → commit + flag in report.
- **Low confidence** ⚠️⚠️ — touched financial / auth / schema → STOP and verify with Tony before commit.

## Recovery from "I broke prod"

In auto-deploy mode every commit ships immediately. If a deploy lands a bug:

1. Find the last known-good commit hash (`git log --oneline | head -20`)
2. Roll back the file: `git checkout <good-hash> -- floor-map-editor.html`
3. Commit the rollback: `git -c commit.gpgsign=false commit -m "revert: rollback to <hash>"`
4. Stamp + deploy + push the rollback IMMEDIATELY (same auto-pipeline):
   ```bash
   bash scripts/stamp-release.sh && firebase deploy --only hosting && git push origin <branch>
   ```
5. If the bug is finance-touching (KI #1 / Stripe / DocuSign), ALSO ping Tony — silent rollback of money-flow code is not safe.
4. ASK Tony before deploying the rollback (do not auto-deploy)

See SESSION_LOG.md 2026-05-11 «Critical incident — units stopped clicking» for a real example of this flow.
