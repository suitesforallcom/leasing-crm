# DEVELOPMENT_WORKFLOW.md

> ~~Local-only dev cycle. No GitHub PRs, no auto-deploy, no auto-push.~~ (stale — see banner below)

> **⚠️ MODE NOTICE (added 2026-05-12):** Active project mode is **auto-deploy + auto-push** (set 2026-05-11 evening — see SESSION_LOG.md `6552bcf` and CLAUDE.md § "Auto-deploy mode"). This doc was written during the brief 2026-05-11 local-only experiment. Where references below say «local-only», «don't deploy», «don't push», «in current mode», treat them as **historical context**, not current rules. Current rules: parse-check → commit → `firebase deploy --only hosting` → `git push origin <branch>` immediately, no per-action approval needed (CLAUDE.md § 1).

## The conservative loop

For any change Tony approves:

```
1. Inspect    →  read relevant code, propose plan
2. Approve    →  Tony confirms with "ok" / "go ahead"
3. Edit       →  small, focused diff (≤ 3-5 files per pass — legacy CLAUDE.md § 9)
4. Parse      →  run parse-check (mandatory after every edit to floor-map-editor.html)
5. Smoke      →  run Playwright if behavioral change touches public path
6. Commit     →  local commit only; do NOT push, do NOT deploy
7. Report     →  Files Changed + Tests Run + Risks + Rollback (per CLAUDE.md Final Response Format)
```

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

## Commit (local only — DO NOT PUSH in current mode)

```bash
git add floor-map-editor.html  # add specific file(s), NOT `git add .`
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
type(scope): one-line summary (≤ 70 chars)

Body explaining WHY (not just WHAT). Reference operator quote in Russian
where applicable. List concrete tradeoffs. Include rollback hint if
non-trivial.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Commit hygiene:**
- One topic per commit. Don't bundle unrelated changes.
- Commit message types: `feat / fix / refactor / docs / chore / test / style / perf`
- Always pass message via heredoc (preserves formatting, multiline body).
- **Don't** use `--no-verify` (no hooks to skip in this project, but the rule prevents accidental CI bypass).
- **Don't** use `--amend` after a previous commit landed — create a new commit instead (legacy rule from CLAUDE.md Section 1).

## Skip in current mode

These were part of the legacy auto-deploy loop. **Skip them**:

- ❌ `scripts/stamp-release.sh` (releases tagged the live `<meta name="sfa-release">` for Sentry)
- ❌ `firebase deploy --only hosting`
- ❌ `git push origin <branch>`
- ❌ Sentry resolve via `mcp__sentry__update_issue`

If Tony explicitly says "deploy this", first switch back to legacy mode (update CLAUDE.md), then follow the legacy pipeline. Document that mode-switch in SESSION_LOG.md.

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

In local-only mode, **don't create new branches** unless Tony asks. Stay on the current branch and commit incrementally.

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

These apply continuously. If a Tony preference conflicts with current local-only mode (e.g. "auto-deploy" preference), **local-only wins** — but mention the conflict and ask Tony to confirm which to follow.

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
