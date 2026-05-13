<!-- SuitesForAll PR template — Error Memory Protocol enforced -->

## Summary

<!-- 1–3 sentences. What changed and why. -->

## Files changed

<!-- Exact paths. -->

## How to test

<!-- Reproduction steps for the reviewer. Include the exact UI surface
     (which window, which tab, which suite) so the reviewer doesn't
     have to guess. -->

## Risk & rollback

- **Risks:** <!-- what could break, what edge cases weren't handled -->
- **Rollback:** `git checkout main -- <file>` or
  `git revert <sha>` — fill in the actual command.

## Error Memory declaration

> All entries are required. Tick each box or write N/A with a reason.

- [ ] I searched [`docs/ERROR_MEMORY.md`](../docs/ERROR_MEMORY.md) for
      similar symptoms before writing the fix.
- [ ] I re-read [`docs/ERROR_RULES.md`](../docs/ERROR_RULES.md) and
      verified this change does not violate any active rule.
- [ ] If this fix touches one of the duplicated formulas (overdue,
      prorate, grace, money totals), I updated **every** copy in the
      same commit — `_computeUnitMoney`, the rent-grid heatmap, the
      alerts banner, and the dashboard queue.
- [ ] If I added a new `u.stripe.*` "last error" stamp, I wrote the
      self-heal predicate in the same commit.
- [ ] If I added a new manual-link path, I mirrored to the truth
      source (`u.payments.*`) and tagged with `manualLink: true`.
- [ ] If `sw.js` changed, I bumped `CACHE_NAME`.
- [ ] Parse-check passes (`new Function(scriptText)` on every inline
      `<script>` block in `floor-map-editor.html`).

## Did this PR resolve a recurring class of bug?

- [ ] Yes — I added an entry to
      [`docs/ERROR_MEMORY.md`](../docs/ERROR_MEMORY.md) and, if the
      lesson generalises, a one-line rule to
      [`docs/ERROR_RULES.md`](../docs/ERROR_RULES.md).
- [ ] No — this is a feature / cosmetic / non-recurring fix.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
