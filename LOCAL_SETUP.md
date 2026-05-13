# LOCAL_SETUP.md

> How to run SuitesForAll locally without touching production.

## Prerequisites

- macOS / Linux / Windows
- Modern browser (Chrome 120+, Safari 17+, Firefox 121+) — Chrome strongly recommended (Firefox SVG `getBBox` quirks have surfaced before)
- Node.js 20.x (for Cloud Functions + Playwright tests; **not needed** to just run the app)
- `git` (for version control inside the worktree)

**Optional** (only if Tony explicitly approves):
- `firebase-tools` (`npm i -g firebase-tools`) — for Functions emulator + deploys (deploys SUSPENDED in current mode)
- `pnpm` / `yarn` — not used by this project; `npm` is canonical

## The simplest "open and go" path

The main app is a static HTML file. To open it:

```bash
open "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94/floor-map-editor.html"
```

This opens in the default browser. Local-only mode — Firebase calls will fail without auth (expected). The app shows the login overlay and stops; no data writes happen.

**Limits of opening directly (`file://`):**
- Firebase Auth domain check rejects `file://` origin → can't sign in
- CORS blocks Firebase Storage reads
- Service Worker can't register from `file://`

For real local interaction (auth + sync), use the static-server path below.

## Run with a local static server (recommended for testing)

The project has no built-in dev server. Use Python's built-in or any equivalent:

```bash
cd "/Users/diskc/Documents/Claude/Projects/Office map/.claude/worktrees/angry-tu-472a94"
python3 -m http.server 5577
```

Then open `http://localhost:5577/floor-map-editor.html` in browser.

**For Firebase Auth to work** against this URL, the Firebase project must have `localhost` in its authorized domains list (it should, by default, but if not, add via Firebase Console → Authentication → Settings → Authorized domains). **Do not modify the Firebase project config from the CLI in local-only mode** — verify only.

Alternatives:
- `npx serve .` (requires `serve` package — installs ad-hoc)
- `npx http-server` (requires `http-server`)
- VS Code Live Server extension

## Cloud Functions emulator (only if Tony approves)

If Tony asks Claude to verify Cloud Functions logic locally:

```bash
cd functions
npm install                              # ⚠️ asks Tony first
npm run serve                            # firebase emulators:start --only functions
```

This runs the Functions locally on port 5001 by default. Stripe webhooks won't reach you unless you tunnel (e.g. `stripe listen --forward-to http://localhost:5001/...`). **Do not** set up tunneling without Tony's approval.

## Playwright smoke tests

```bash
cd tests
npm install                              # ⚠️ asks Tony first if node_modules/ missing
npx playwright install                   # ⚠️ asks Tony first; downloads browser binaries
npx playwright test                      # runs the 3 specs
```

**Default target** is production (`https://suitesforall.web.app`) — running tests by default DOES hit live URL.

To target local server instead:

```bash
PW_BASE_URL=http://localhost:5577 npx playwright test
```

Specs:
- `app-loads.spec.ts` — page renders, Sentry initializes, no console errors, release tag is non-DEV in prod
- `auth-gate.spec.ts` — unauthenticated visitors see login screen
- (third spec mentioned in legacy CLAUDE.md was static-pages — verify presence)

## Parse-check (required after every edit to `floor-map-editor.html`)

There's no formal lint step. The required check is parse-validation of every inline `<script>` block:

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

Expected output: `Parsed 3 blocks, 0 errors.`

If any block fails to parse, the change introduced a syntax error somewhere — find by line number in the error. **Do not commit code that fails parse-check.**

## What NOT to install in local-only mode

Forbidden without Tony's approval:
- New top-level npm packages (root has no `package.json`; don't create one)
- New `functions/` deps (would change deployed Cloud Functions)
- New `tests/` deps (would change CI surface area)
- Global tools (`npm i -g <anything>`)
- pnpm / yarn / bun (use `npm`)

## What NOT to configure

- `~/.firebaserc` / `firebase login` — leave as-is. Don't run `firebase login --reauth` unless Tony asks.
- `.env` files — never create real ones. See SECURITY_AND_SECRETS.md.
- IDE plugins that auto-deploy / auto-push — disable.

## How to know you're in local-only mode

Check `CLAUDE.md` § Project Mode at top of file. If it says "local-only maintenance mode", you're in it. If Tony has switched back to the legacy auto-deploy mode, the file will be updated to reflect that explicitly.

Also check git remote: `git remote -v` shows the origin URL but local-only mode means **don't push** to it.

## Common stuck-on-X recipes

| Symptom | Fix |
|---|---|
| `firebase: command not found` | Don't install — local-only mode does not deploy. |
| Auth fails on localhost | Verify Firebase Console > Auth > Authorized domains includes `localhost`. **Don't** add via CLI. |
| Playwright can't find browser | Install via `npx playwright install` only with Tony's approval. |
| Parse-check fails after edit | Read the block index + error message, fix the syntax, re-run. |
| Browser shows `Cloud sync failed` red banner | Click "↑ Force push" or "↓ Pull cloud" buttons (added 2026-05-10). DON'T touch Firestore directly. |
| `git push` rejected | Don't push in local-only mode. Period. |

## Verifying you can read the project safely

To prove "I can inspect without breaking":

```bash
git status           # should show only untracked screenshots / .claude / .playwright-mcp
git log --oneline -5 # should show recent commits
ls *.md              # should list 10+ docs
wc -l floor-map-editor.html  # should show ~130k lines
```

If any of these surface unexpected modifications, STOP and report to Tony before doing anything else.
