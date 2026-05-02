#!/usr/bin/env bash
# ===================================================================
# One-shot script to clean up the partial git init Claude started and
# commit the baseline. Safe to run multiple times — idempotent.
# ===================================================================
set -e
cd "$(dirname "$0")"

echo "→ removing any stale .git/index.lock"
rm -f .git/index.lock

echo "→ ensuring branch is named 'main'"
git branch -m main 2>/dev/null || true

echo "→ git status (before commit)"
git status -s | head -20
echo "  ($(git status -s | wc -l | tr -d ' ') untracked / changed paths total)"

echo
echo "→ ignored files (should include .firebase, node_modules, _lease-*.jpg, .fuse_hidden*):"
git status --ignored -s | grep '^!!' | head -20

echo
read -p "Commit ALL of the above as baseline? (y/N) " ans
if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
  echo "Aborted. Nothing committed."
  exit 1
fi

git add -A
git commit -m "baseline 2026-05-01: snapshot before adopting branch-based workflow

Includes everything in the working tree at this moment:
- Multi-suite-lease feature (groupId infrastructure, Shift+G hotkey,
  Group & Assign Tenant modal, group banner with combined rent /
  effective rate / total area / suite share, sub-rooms 'covered by
  parent lease' fix, Rent Roll group badge)
- Stacking view: office-only filter + Building summary table at
  bottom + per-floor outline-area integration + 3-column rate table
  with Total/Rentable/Leased columns
- Multi-select rate panel: Total rent (pro-rata) field, utilities
  toggle (Gross/Net), bulk-input value persistence after Apply,
  per-unit row recalc for total mode, contract→rent mirror to
  prevent display 0 on vacant suites
- Phantom-units fix on floor 4 (auto-seed blocker)
- Polygon label centroid fix (text stays inside non-rect shapes)
- Calibrate-by-line rewritten as single drag gesture (parity w/ area)
- Shared-edge resize on rectangle units + corner-snap viz at draw
- Floor area panel kebab moved to bottom toolbar more-actions menu
- Recompute capacity buttons + sqftPerPerson input + Align edges
- localStorage quota emergency fix: total-budget eviction policy +
  sfaWipeBackups() / sfaStorageReport() console commands
- CLAUDE.md updated with full project rules incl. branch-based
  workflow + Deploy to production gate
- .gitignore covers node_modules, .firebase cache, FUSE leftovers,
  lease-scratch screenshots, and any .env / serviceAccount json"

echo
echo "✓ baseline committed."
git log --oneline -5
echo
echo "Now you can create a working branch:"
echo "  git checkout -b feature/post-baseline-tweaks"
