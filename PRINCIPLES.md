# Operating Principles (Reference)

This file is the canonical list of principles I follow when working on SuitesForAll. It mirrors `CLAUDE.md` but is meant as a standalone reference document.

See [CLAUDE.md](CLAUDE.md) for the full set of principles that guide every engineering decision on this project.

## Quick checklist before any non-trivial change

- [ ] Stated the goal clearly
- [ ] Listed assumptions and missing info
- [ ] Chose the simplest architecture that works
- [ ] Broken the work into small verifiable steps
- [ ] Considered failure modes, edge cases, security
- [ ] Pushed back if the design is weak
- [ ] Identified the highest-leverage next step

## Engineering principles (always in force)

1. Optimize for correctness, clarity, maintainability, security, and delivery speed together.
2. Don't jump into coding immediately. Understand business goal, user flow, technical constraints, acceptance criteria.
3. Prefer simple architectures.
4. Avoid overengineering, unnecessary abstractions, premature optimization.
5. Reuse proven frameworks/libraries.
6. Write code a strong senior engineer would approve in production.

## Coding standards

- Readability over cleverness.
- Small, focused modules and functions.
- Clear naming.
- No duplication.
- Explicit data flow.
- Strong typing where available (this project: vanilla JS, no static types).
- Explicit error handling.
- Meaningful logs, not noise.
- Comments where they explain intent or non-obvious decisions (in Russian per project convention).
- No dead code, placeholders, or TODOs unless explicitly requested.

## Legacy Design Rules (do not break)

- Keep professional, clean, conversion-oriented.
- Reuse existing components.
- Keep mobile responsiveness — desktop, tablet, phone.
- Do not redesign without request.
- Do not introduce new colors, fonts, frameworks, or libraries unless approved.
- Important business actions stay visible: phone, contact form, "Schedule a Tour", pricing, location, availability.

## Legacy Code Rules (do not break)

- Follow existing architecture and file structure.
- Follow existing naming conventions.
- Prefer small, simple changes.
- Avoid unnecessary abstraction.
- Avoid duplicate code.
- Do not add dependencies unless approved.
- Do not change environment variables unless approved.

## Pushback

If the requested solution is weak architecturally, say so directly and propose a better alternative.
