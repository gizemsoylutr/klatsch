## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, [Developer Certificate of Origin](https://developercertificate.org)).
- [ ] Tests for every behaviour I changed; a security-relevant change (auth, disclosure, detectors, the web UI) has a test that shows the rule holds.
- [ ] A new or changed tool, page or flow step has its end-to-end scenario in `test/e2e/` (and `test/ui/` for pages); `npm run flows` redrew `docs/flows/` if a scenario changed.
- [ ] Wire format changed? `npm run schema` and the updated `schema/` are in this pull request.
- [ ] No new runtime dependency, or the reason is below.
- [ ] I ran `npm run typecheck`, `npm test`, `npm run e2e`, `npm run test:ui`, `npm run schema:check` and `npm run flows:check`.

## Who sees what

<!-- Does this change what an agent, another person or the relay operator can see or decide? If yes, say how the consent rules in docs/security-model.md still hold. -->
