# Cleanup + review convergence checklist

## Cleanup (must all be true to converge)
- [x] Freeze scope (82 src files, ~325 comment blocks)
- [x] Comments: primary-agent pass over core files (10 confirmed defects, applied + pushed 0cae8ca33)
- [ ] Comments: batch A (3 readers) — 2 independent reviews
- [ ] Comments: batch B (7 SSE adapters)
- [ ] Comments: batch C (shared/ir/round-trip/entrypoints)
- [ ] Structure review across src/
- [ ] Defensive design review across src/
- [ ] Reconcile all findings; apply remaining eligible fixes
- [ ] Verify: tsc + tests + lint after final fixes
- [ ] Convergence claim: no remaining eligible fix

## Behavior diff review (report only, no changes)
- [ ] Request-payload side vs main
- [ ] Event/stream side vs main
- [ ] Classify: EXISTING-BUG-FIX / USER-REQUESTED / OBVIOUS-BUG / NEEDS-DISCUSSION
- [ ] Deliver classified report

## Cleanup at the end
- [ ] Delete cron 2d807505 after report is delivered
