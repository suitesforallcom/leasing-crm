# DEVELOPMENT_WORKFLOW.md

> Active auto-deploy + auto-push dev cycle for `floor-map-editor.html` and docs. Source of truth: CLAUDE.md § "Project Mode (active)".

## The auto-deploy loop

For any change inside the "Allowed Work" boundary of CLAUDE.md:

```
1. Inspect       →  read relevant code, propose plan
2. Edit          →  small, focused diff (≤ 3-5 files per pass — legacy CLAUDE.md § 9)
3. Parse         →  parse-check (mandatory after every edit to floor-map-editor.html)
4. Smoke         →  run Playwright if behavior touches boot / auth / render path
5. Commit        →  one topic per commit; specific files (no `git add .`)
6. Stamp release →  bash scripts/stamp-release.sh         ← writes commit hash into <meta sfa-release>
7. Deploy        →  firebase deploy --only hosting        ← ships to https://suitesforall.web.app
8. Push          →  git push origin <branch>              ← mirrors to GitHub
9. Sentry resolve → if commit fixes a tracked SUITESFORALL-NN, mark it resolved
10. Report       →  Files Changed + Tests + Hosting URL + Rollback (CLAUDE.md Final Response Format)
```

Steps 6-9 fire automatically after step 5 — no per-commit approval phrase needed. The boundary that DOES require Tony approval is in CLAUDE.md § "Approval STILL required" + § "Financial-model gate".

## Before every change

```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94"
git status                                  # working tree must be clean (or only untracked screenshots)
git rev-parse HEAD                          # capture rollback target
```

If the working tree is dirty (modified files), **STOP**. Report to Tony.

## During the change

- Use `Read` with `offset` + `limit` for partial loads of `floor-map-editor.html` — full reads are slow.
- Locate target functions via `grep -n "function fooBar"` first.
- Edit with `Edit` tool (preserves indentation, validates uniqueness of old_string).
- Comment edits in **Russian** — naming/identifiers stay English.
- Don't add new dependencies, don't touch external configs, don't refactor adjacent code.

## After every edit to `floor-map-editor.html`

**Required parse-check** (see LOCAL_SETUP.md for the full command):

```bash
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

Expected: `Parsed 3 blocks, 0 errors.` Anything else → fix the syntax error before committing.

## Commit + auto-deploy pipeline

```bash
# 1. Stage only the specific files you intended to change.
git add floor-map-editor.html  # NEVER `git add .` (may sweep in .env, screenshots, etc.)

# 2. Commit with a heredoc body explaining WHY.
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
type(scope): one-line summary (≤ 70 chars)

Body explaining WHY (not just WHAT). Reference operator quote in Russian
where applicable. List concrete tradeoffs. Include rollback hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

# 3. Stamp the release into <meta name="sfa-release"> so Sentry can tag events.
bash scripts/stamp-release.sh

# 4. Deploy hosting. Cloud Functions are NOT in this pipeline — they require
#    Tony's explicit approval per CLAUDE.md § "Approval STILL required".
firebase deploy --only hosting

# 5. Mirror to GitHub.
git push origin fix/autobilling-respect-archive-filters

# 6. (Optional) commit the stamp diff as `chore(release): stamp <hash>` and push.
git add floor-map-editor.html
git -c commit.gpgsign=false commit -m "chore(release): stamp <short-hash>"
git push origin fix/autobilling-respect-archive-filters
```

**Commit hygiene:**
- One topic per commit. Don't bundle unrelated changes.
- Commit message types: `feat / fix / refactor / docs / chore / test / style / perf`
- Always pass message via heredoc (preserves formatting, multiline body).
- **Don't** use `--no-verify` (no hooks to skip in this project, but the rule prevents accidental CI bypass).
- **Don't** use `--amend` after a previous commit landed — create a new commit instead (CLAUDE.md "CRITICAL: Always create NEW commits").

## Always required in current mode

- ✅ `scripts/stamp-release.sh` — writes commit hash into `<meta name="sfa-release">` so Sentry tags events with the live release
- ✅ `firebase deploy --only hosting` — fires after every commit on the active branch
- ✅ `git push origin <branch>` — mirrors to GitHub immediately
- ✅ Sentry resolve via `mcp__sentry__update_issue` when commit explicitly fixes a tracked `SUITESFORALL-NN`

## Always blocked (require explicit Tony approval even in auto-deploy mode)

- ❌ `firebase deploy --only functions` (Cloud Functions changes)
- ❌ Edits to `firebase.json` / `firestore.rules` / `firestore.indexes.json` / `cors.json`
- ❌ `firebase functions:secrets:set` and any secret writes
- ❌ `git push --force` / branch deletion / `git reset --hard` on tracked content
- ❌ `npm install <pkg>` (new dependencies)
- ❌ Bulk financial mutations — voiding Stripe invoices, refunds, mass payment edits
- ❌ Anything in CLAUDE.md § "Financial-model gate" until validated against FINANCIAL_MODEL_REFERENCE.md

If a change touches anything above, **stop and ask** — even though hosting deploy itself is automatic.

## Rollback

For a single-file edit:

```bash
git checkout HEAD -- floor-map-editor.html  # discards uncommitted changes
```

For an already-committed change, revert the commit:

```bash
git revert <commit-hash> --no-edit
# OR roll back file content:
git checkout <prior-hash> -- floor-map-editor.html
git -c commit.gpgsign=false commit -m "revert: rollback to <prior-hash> (reason)"
```

For a multi-commit rollback:

```bash
git checkout <known-good-hash> -- floor-map-editor.html
git -c commit.gpgsign=false commit -m "revert: emergency rollback to <hash>"
```

## Branch management

Current branch: `fix/autobilling-respect-archive-filters` (verify with `git branch --show-current`).

**Don't create new branches** unless Tony asks. Stay on the current branch and commit incrementally — auto-deploy ships every commit on this branch directly.

If Tony asks for a feature branch:

```bash
git checkout -b feature/<short-name>
```

Branch naming convention from legacy CLAUDE.md Section 3:
- `feature/[short-task-name]`
- `fix/[short-task-name]`
- `backup/[date-task-name]`

## Smoke test cadence

Run Playwright smoke tests when:
- Modifying anything in `floor-map-editor.html` that affects boot, auth, or initial render
- Modifying `index.html` / static page rewrites in `firebase.json`
- Touching `firestore.rules` (auth/permission changes — also requires Tony's approval per CLAUDE.md)

Skip Playwright when:
- Pure UI label / color / copy change with no boot impact
- Doc-only edits
- Tooltip / help-text tweaks

```bash
cd tests
PW_BASE_URL=http://localhost:5577 npx playwright test
```

(Default `PW_BASE_URL` hits production — set to localhost for local verification.)

## Multi-file changes

Per legacy CLAUDE.md Section 9: **don't modify more than 3-5 files in one pass** without Tony's explicit approval.

If a task requires more, propose the file list up front:

> "Tony, this needs editing 7 files: `<list>`. Want me to proceed, or break into smaller passes?"

Wait for confirmation before starting.

## Reporting after each pass

Use the `# Final Response Format` from CLAUDE.md. Minimum:

```markdown
# Files Changed
- floor-map-editor.html — added/changed/removed X
- DECISIONS.md — added entry under § 6 (latent bug)

# Checks Run
- Parse-check: ✓ 3 blocks, 0 errors
- Playwright smoke: not run (UI label only, no boot impact)

# Risks
- (Specific edge cases not tested, e.g. "polygon units > 100 vertices not verified")

# Rollback
- git checkout <prev-hash> -- floor-map-editor.html
```

## Working with Tony's preferences

From `MEMORY.md` (operator-level prefs that apply across all sessions):

- **Autonomy**: don't pause for routine checks Tony can already see. Proceed when action is safe.
- **Code comments in Russian**, identifiers English.
- **UI text in English**.
- **Proactive UX analysis** before patching one symptom — propose top-3 highest-impact improvements where applicable.
- **Grouped suites = one lease** (multi-suite leases never split per-suite for invoices/overdue/payments).

These apply continuously. If a Tony preference conflicts with the active auto-deploy mode (e.g. a request to "hold off on deploys"), **the in-session instruction wins** — temporarily switch behavior and log the deviation in SESSION_LOG.md.

## When to STOP and ask Tony

Per CLAUDE.md "Tony Approval Required":
- Touching real money / invoices / payments
- Database schema / migrations
- Auth / permissions / roles
- Production deployment (any deploy ANY where)
- External APIs / secrets
- Legal / business-critical workflows
- Destructive changes (file deletes, force-push, db drops)
- New dependencies
- Large refactors

If unsure, ASK. Better one extra Q than one accidental finance bug.
