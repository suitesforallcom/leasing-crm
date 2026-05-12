# AUTOMATION_BOUNDARIES.md

> What Claude may auto-execute vs ask first. Read alongside CLAUDE.md "Allowed Work" / "Forbidden Work".

## The 4-tier model

| Tier | Description | Examples | Approval needed? |
|---|---|---|---|
| **GREEN** | Safe local automation | Read files, run parse-check, list git status, format output | No — just do it |
| **YELLOW** | Local writes / commits | Edit files, `git commit` (local), update docs | Per-task — describe before |
| **ORANGE** | External / network | `firebase deploy`, `git push`, `npm install`, browser MCP | Per-action explicit Tony OK |
| **RED** | Forbidden in current mode | Modify Stripe / production / firestore.rules / auth | Refuse + explain |

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

## YELLOW — Local writes after announcing intent

Modify-then-commit actions, scoped to local files only:

- Edit `floor-map-editor.html` (small focused diff per CLAUDE.md § 9 — ≤ 3-5 files)
- Create / update doc files (`*.md`)
- `git add <specific-file>` (NOT `git add .`)
- `git commit` with heredoc message + `Co-Authored-By: Claude` footer
- Run `node -e "..."` for parse-check
- Run `cd tests && npx playwright test` (if Playwright already installed)

Protocol:
1. State intent ("Going to edit X to do Y")
2. Show plan if non-trivial (multi-file or critical file)
3. Wait for "ok" / "go ahead" / substantive approval if change is risky (per CLAUDE.md "Tony Approval Required" list)
4. Execute
5. Report Files Changed + Tests Run + Risks + Rollback (per CLAUDE.md Final Response Format)

Boundary: nothing leaves the local file system. No `git push`, no deploy, no external API call, no `npm install`.

---

## ORANGE — External / network: explicit per-action approval

Each invocation requires Tony's explicit "yes":

- `firebase deploy --only hosting` (currently SUSPENDED in local-only mode)
- `firebase deploy --only functions` (currently SUSPENDED)
- `git push origin <branch>` (currently SUSPENDED)
- `npm install <pkg>` in `functions/` or `tests/`
- `npx playwright install` (downloads browser binaries — first-time only)
- Chrome MCP browser automation against production
- Playwright tests against production (`npx playwright test` without `PW_BASE_URL=localhost`)
- Sentry queries / updates (`mcp__sentry__*`)
- Any tool that hits a non-localhost URL

Protocol:
1. Tell Tony: "I want to do X. This will [external effect]. OK to proceed?"
2. Wait for "yes" / explicit confirmation
3. Execute
4. Report what happened
5. If `firebase deploy` fires → also report the live URL + release tag

Boundary: any action that touches the network or modifies Tony's filesystem outside the project worktree.

---

## RED — Forbidden in current mode (refuse with explanation)

Even with Tony asking, these require switching mode FIRST:

| Action | Why forbidden in local-only mode | What to ask Tony |
|---|---|---|
| Modify `firebase.json` / `firestore.rules` / `firestore.indexes.json` / `cors.json` | Production config; Tony's call | "Do you want to switch back to legacy auto-deploy mode first? OR confirm you want to edit prod config in maintenance mode?" |
| Touch `functions/.env` | Real secrets; never read or modify | "I won't touch `functions/.env`. If you need a value changed, set it via `firebase functions:secrets:set` yourself." |
| Run `firebase functions:secrets:set` / `:get` / `:remove` | Tony does these manually | "Run the command yourself in your terminal — this is a Tony-only action." |
| Run `firebase login` / `--reauth` | Auth flow; Tony interactive | "Run `firebase login --reauth` yourself — opens browser for OAuth." |
| Modify `~/.zshrc` / `~/.bashrc` | Shell config; risky for global env | "I won't write to your shell config. If a `PATH` change is needed, edit it yourself." |
| `git reset --hard <hash>` | Destructive | "This rewrites history. Confirm explicitly OR use `git revert <hash>` for a safer non-destructive undo." |
| `git clean -fd` / `git clean -fdx` | Destructive (deletes untracked files) | "This deletes untracked files. Confirm explicitly OR list what would be deleted first via `--dry-run`." |
| `git push --force` / `--force-with-lease` to main / master | Destructive on shared branch | "Force-push to a shared branch is risky. Confirm explicitly + take a backup branch first." |
| Bulk-delete tenant data / units / payments | Catastrophic | "This deletes business records. Tony, please confirm exactly what to delete with row-level approval." |
| Send Stripe invoice from Claude tool (e.g. via curl) | Real money | "Stripe sends only happen via the app's UI or Tony's manual API call. Refusing to do this directly." |
| Email / SMS / DocuSign send | Real outbound communication | "External communications are operator-initiated only." |

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

Switching from local-only mode to legacy auto-deploy (or vice versa) is itself a YELLOW action:

1. Tony says: "switch to auto-deploy mode" / "switch to local-only mode"
2. Claude updates CLAUDE.md § Project Mode
3. Adds entry in DECISION_LOG.md
4. Reports in SESSION_LOG.md (`## YYYY-MM-DD ## 🔧 Mode switch`)
5. From next instruction onwards, operate in the new mode

---

## Examples of correct judgment

### Example 1: Tony asks "look at the project"

→ GREEN: read files, list dirs, summarize. No approval needed.

### Example 2: Tony asks "fix the typo on line 14242"

→ YELLOW: announce intent ("editing line 14242 to fix [typo]"), make edit, parse-check, commit locally. NO push, NO deploy.

### Example 3: Tony asks "deploy this fix"

In local-only mode → REFUSE: "Local-only mode disallows deploy. To deploy, please confirm switch to auto-deploy mode first OR I can stage the commit and you run `firebase deploy --only hosting` yourself."

### Example 4: Tony asks "what's in functions/.env?"

→ RED: refuse (per SECURITY_AND_SECRETS.md). Suggest: "Open it in your editor; I won't read secrets."

### Example 5: Tony asks "void this Stripe invoice"

→ RED: refuse. Direct: "Void via Stripe Dashboard yourself — financial actions are operator-only."

### Example 6: Tony pastes a Stripe API key in chat

→ RED: don't save anywhere. Tell Tony: "Don't paste live keys in chat. Set via `firebase functions:secrets:set STRIPE_SECRET_KEY` yourself; if this key is live, rotate it now."

### Example 7: Tony says "scan the code for any place we might have forgotten to use the building filter"

→ GREEN: grep + Read + report. No mutations.

### Example 8: Tony asks "add a new sub-tab to Investment Analysis"

→ YELLOW: small edit; affects single file. Announce plan, edit, parse-check, commit locally. NO deploy / push.

### Example 9: Tony asks "delete all archived buildings"

→ RED-adjacent: clarifying confirm needed. "Bulk delete affects business records. Confirm: delete buildings flagged `archivedAt != null` from `state.buildings`? Total count would be N. Restoring requires backup. Confirm with row-level YES."

### Example 10: Tony asks "run Playwright tests"

→ ORANGE (default target = production): "Default config tests against `https://suitesforall.web.app`. OK to run against prod, OR want me to spin up local server (`python3 -m http.server 5577`) and target localhost first?"

---

## When in doubt

If unsure whether an action is GREEN / YELLOW / ORANGE / RED, treat it as one tier higher than your guess. Better to over-ask once than under-ask once and break something.
