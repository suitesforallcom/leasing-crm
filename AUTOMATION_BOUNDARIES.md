# AUTOMATION_BOUNDARIES.md

> What Claude may auto-execute vs ask first. Read alongside CLAUDE.md § "Allowed Work" / § "Approval STILL required". Active mode is **auto-deploy + auto-push**.

## The 4-tier model

| Tier | Description | Examples | Approval needed? |
|---|---|---|---|
| **GREEN** | Safe local automation | Read files, parse-check, `git status`, format output | No — just do it |
| **YELLOW** | Local writes / commits / hosting deploys | Edit files, `git commit`, `firebase deploy --only hosting`, `git push origin <branch>`, Sentry resolve | No per-action approval — fires automatically after a clean commit on the active branch |
| **ORANGE** | Network calls outside the auto-deploy pipeline | `npm install`, browser MCP, Playwright against prod, Stripe / DocuSign / UniFi read-only API calls | Per-action explicit Tony OK |
| **RED** | Always forbidden — refuse or escalate | Modify Stripe / `firestore.rules` / Cloud Functions / auth, bulk-delete records, force-push to main, edit `functions/.env` | Refuse + explain + suggest safer path |

---

## GREEN — Auto-execute without asking

Inspection / observation / read-only actions:

- Read any project file
- `git status` / `git log` / `git diff` / `git branch --show-current` / `git rev-parse HEAD`
- `grep` / `find` (via Grep / Glob tools)
- Parse-check the inline scripts in `floor-map-editor.html`
- Run `wc -l` / `head` / `tail` / `cat` for metadata
- List directories
- Check `firebase.json` / `firestore.rules` / `firestore.indexes.json` / `cors.json` for content (read-only)
- Format output (markdown, tables, code blocks)
- Update working memory (TodoWrite if relevant)
- Suggest plans / propose architectures
- Document what was found

Boundary: any action that doesn't write to disk, doesn't call external services, doesn't mutate state.

---

## YELLOW — Local writes + the auto-deploy pipeline

Modify → commit → ship — fires automatically after every clean commit on the active feature branch (no per-action approval phrase required):

- Edit `floor-map-editor.html` (small focused diff per CLAUDE.md § 9 — ≤ 3-5 files)
- Create / update doc files (`*.md`)
- `git add <specific-file>` (NOT `git add .`)
- `git commit` with heredoc message + `Co-Authored-By: Claude` footer
- Parse-check via inline `node -e "..."`
- `bash scripts/stamp-release.sh` (writes commit hash into `<meta sfa-release>` for Sentry tagging)
- `firebase deploy --only hosting`
- `git push origin fix/autobilling-respect-archive-filters`
- `mcp__sentry__update_issue ... status='resolved'` when commit explicitly fixes a tracked `SUITESFORALL-NN`
- Sentry list / inspect queries (read-only) — `mcp__sentry__list_issues`, `mcp__sentry__get_sentry_resource`
- `cd tests && npx playwright test` against production OR localhost
- Browser MCP visual smoke against `https://suitesforall.web.app` after a deploy

Protocol:
1. Make the change
2. Parse-check
3. Commit (one topic per commit)
4. Stamp + deploy + push automatically
5. (If applicable) resolve corresponding Sentry issue
6. Report Files Changed + Tests Run + Hosting URL + Rollback (per CLAUDE.md Final Response Format)

Boundary: stays inside the auto-deploy pipeline. Doesn't install new packages, doesn't run mutating external API calls (Stripe / DocuSign / UniFi), doesn't touch Cloud Functions or production config.

---

## ORANGE — Outside the auto-deploy pipeline: explicit per-action approval

Each invocation requires Tony's explicit "yes" because it goes outside the standard ship loop:

- `npm install <pkg>` in `functions/` or `tests/` (new dependencies)
- `npx playwright install` (downloads browser binaries — first-time only)
- Chrome MCP browser actions that mutate state (form submits, button clicks that aren't pure-navigation)
- Stripe / DocuSign / UniFi / Plaid API calls (passive reads beyond `whoami`-level metadata)
- Running `cd tests && npx playwright test --headed` (UI takeover — visible to user)
- Long-running background processes (Bash `run_in_background`)
- Any tool that hits a non-localhost URL outside the hosting / GitHub / Sentry MCP setup

Protocol:
1. Tell Tony: "I want to do X. This will [external effect]. OK to proceed?"
2. Wait for "yes" / explicit confirmation
3. Execute
4. Report what happened

Boundary: any action that requires a new external integration or makes a mutating call to a service outside Firebase hosting / GitHub / Sentry resolve.

---

## RED — Always forbidden (refuse with explanation)

These remain forbidden regardless of mode. Cross-reference CLAUDE.md § "Approval STILL required" — these are the items where the auto-deploy pipeline does NOT apply.

| Action | Why forbidden | What to tell Tony |
|---|---|---|
| `firebase deploy --only functions` | Cloud Functions touch real money / external APIs | "Functions deploys require your explicit OK per CLAUDE.md. Confirm + I'll fire it; otherwise I stop at hosting." |
| Modify `firebase.json` / `firestore.rules` / `firestore.indexes.json` / `cors.json` | Production config / schema; Tony's call | "I won't edit this without your explicit OK. Want me to draft the diff for your review?" |
| Touch `functions/.env` | Real secrets; never read or modify | "I won't touch `functions/.env`. If you need a value changed, set it via `firebase functions:secrets:set` yourself." |
| Run `firebase functions:secrets:set` / `:get` / `:remove` | Tony does these manually | "Run the command yourself — this is a Tony-only action." |
| Run `firebase login` / `--reauth` | Auth flow; Tony interactive | "Run `firebase login --reauth` yourself — opens browser for OAuth." |
| Modify `~/.zshrc` / `~/.bashrc` | Shell config; risky for global env | "I won't write to your shell config. If a `PATH` change is needed, edit it yourself." |
| `git reset --hard <hash>` | Destructive | "This rewrites history. Confirm explicitly OR use `git revert <hash>` for a safer non-destructive undo." |
| `git clean -fd` / `git clean -fdx` | Destructive (deletes untracked files) | "This deletes untracked files. Confirm explicitly OR list what would be deleted first via `--dry-run`." |
| `git push --force` / `--force-with-lease` to main / master | Destructive on shared branch | "Force-push to a shared branch is risky. Confirm explicitly + take a backup branch first." |
| Bulk-delete tenant data / units / payments | Catastrophic | "This deletes business records. Tony, please confirm exactly what to delete with row-level approval." |
| Send Stripe invoice from Claude tool (e.g. via curl) | Real money | "Stripe sends only happen via the app's UI or your manual API call. I won't fire it directly." |
| Email / SMS / DocuSign send | Real outbound communication | "External communications are operator-initiated only." |
| Anything in CLAUDE.md § "Financial-model gate" before validation | Banking-grade rules from Kiwi bundle | "This change must pass `FINANCIAL_MODEL_REFERENCE.md` § 6 checklist first — see § 7 Discrepancies log." |

Protocol:
1. Refuse the action
2. Explain WHY (which rule, which doc)
3. Suggest the safer path (mode switch, manual operator action, etc.)
4. Wait for Tony's explicit "OK, switch mode and do it" OR alternative path

---

## Specific automation rules

### Tool selection

| Want to... | Use | Don't use |
|---|---|---|
| Find a file by pattern | `Glob` | `Bash find` |
| Find content by regex | `Grep` | `Bash grep` / `rg` |
| Read a known file | `Read` | `Bash cat` / `head` / `tail` |
| Edit existing file | `Edit` | `Bash sed` / `awk` |
| Create new file | `Write` | `Bash echo > file` / `cat <<EOF` |
| Echo a message | Direct text output in chat | `Bash echo` |
| Run a shell command | `Bash` (with description) | n/a |

### Parallel tool calls

When multiple operations are independent, batch them in one message (multiple tool calls in one `<function_calls>` block). Examples:

- ✓ `git status` + `git diff` + `git log -5` in parallel
- ✓ Reading 3 files at once
- ✗ NOT `git checkout && git commit && git push` — those are dependent

### Bash hygiene

- Always quote paths with spaces: `cd "/Users/diskc/Documents/Claude/Projects/Office map/..."`
- Maintain absolute paths; avoid relying on `cwd` between calls
- Never use `--no-verify`, `--no-edit` on rebases, `-i` interactive flags
- Never `rm -rf <path>` without explicit Tony approval
- Avoid `sleep` loops; use `Bash run_in_background` if waiting for long task

### Heredoc commit messages

Always pass commit message via heredoc (preserves formatting):

```bash
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
type(scope): one-line title

Body explaining WHY.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

NEVER pass commit message as a raw `-m "string with \n inside"` — escaping is fragile.

### File path conventions

- Use ABSOLUTE paths in all tool calls (Read, Write, Edit, Bash)
- Project root: `/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94`
- Always quote paths with spaces in Bash

---

## Decision tree

For any action, ask:

```
Is the action read-only?
├─ YES → GREEN — just do it
└─ NO → 
    Does it write to disk?
    ├─ Local file only?
    │   ├─ YES → YELLOW — announce + do (per-task approval if risky)
    │   └─ NO → ORANGE — explicit OK first
    └─ External / network?
        ├─ YES → ORANGE — explicit per-action OK
        └─ Production / secrets / destructive?
            └─ RED — refuse, explain, suggest safer path
```

---

## When Tony asks Claude to skip an approval

If Tony says "just do it" / "stop asking" / "auto-approve all":

- For YELLOW / ORANGE / RED actions, POLITELY confirm: "OK to skip approval for [specific category] going forward?" — get explicit per-category OK.
- Don't generalize "auto-approve all" to RED actions (Stripe sends, schema changes, auth changes).
- If Tony explicitly removes the restriction (e.g. "re-enable auto-deploy"), update CLAUDE.md mode + document the change in DECISION_LOG.md + SESSION_LOG.md.

---

## Mode switching

If Tony asks to temporarily pause auto-deploy (e.g. "no deploys today, just stage commits"):

1. Tony explicit ask required (in-session)
2. Claude reads as a YELLOW override — stay on the current branch, commit only
3. Add a one-line note in SESSION_LOG.md under today's date so the next session sees the deviation
4. When Tony says "resume" / makes a new request, return to the default auto-deploy pipeline
5. A FULL mode switch (back to local-only) requires updating CLAUDE.md § "Project Mode (active)" + DECISION_LOG.md entry — same flow as 2026-05-11 `6552bcf`

---

## Examples of correct judgment

### Example 1: Tony asks "look at the project"

→ GREEN: read files, list dirs, summarize. No approval needed.

### Example 2: Tony asks "fix the typo on line 14242"

→ YELLOW: edit, parse-check, commit, stamp-release, `firebase deploy --only hosting`, `git push`. Report hosting URL + release tag.

### Example 3: Tony asks "deploy this fix"

→ Redundant in auto-deploy mode (deploy already fired with the commit). Answer: "Already live on `https://suitesforall.web.app` at release `<short-hash>` — see Final Report." If the deploy was somehow blocked (auth expired, fs full), report the error and ask for direction.

### Example 4: Tony asks "what's in functions/.env?"

→ RED: refuse (per SECURITY_AND_SECRETS.md). Suggest: "Open it in your editor; I won't read secrets."

### Example 5: Tony asks "void this Stripe invoice"

→ RED: refuse. Direct: "Void via Stripe Dashboard yourself — financial actions are operator-only."

### Example 6: Tony pastes a Stripe API key in chat

→ RED: don't save anywhere. Tell Tony: "Don't paste live keys in chat. Set via `firebase functions:secrets:set STRIPE_SECRET_KEY` yourself; if this key is live, rotate it now."

### Example 7: Tony says "scan the code for any place we might have forgotten to use the building filter"

→ GREEN: grep + Read + report. No mutations.

### Example 8: Tony asks "add a new sub-tab to Investment Analysis"

→ YELLOW: small edit, single file. Announce plan if non-trivial, edit, parse-check, commit, auto-deploy + push. Report hosting URL.

### Example 9: Tony asks "delete all archived buildings"

→ RED-adjacent: clarifying confirm needed. "Bulk delete affects business records. Confirm: delete buildings flagged `archivedAt != null` from `state.buildings`? Total count would be N. Restoring requires backup. Confirm with row-level YES."

### Example 10: Tony asks "run Playwright tests against prod"

→ YELLOW (read-only smoke against the freshly deployed release): just run it and report. If the smoke would require fill-form / submit (mutating actions), step up to ORANGE.

### Example 11: Tony asks "change the pro-rate formula"

→ RED until financial-model gate validated: "This is on the Financial-Model Gate — per `FINANCIAL_MODEL_REFERENCE.md` § 6, I need to map the proposed change against Kiwi rules and surface any discrepancy under § 7 before commit. Want me to do that pass?"

---

## When in doubt

If unsure whether an action is GREEN / YELLOW / ORANGE / RED, treat it as one tier higher than your guess. Better to over-ask once than under-ask once and break something.
