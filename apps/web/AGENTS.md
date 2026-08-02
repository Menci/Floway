# AGENTS.md — apps/web

How to work in this package. The architecture is in the repo-root `AGENTS.md`;
this is what the project's history says goes wrong.

Almost every correction on this codebase has been one of three things: the fix
landed **at the wrong layer**, it landed in **one of N places**, or it silently
**dropped behaviour that already worked**. A defect seen twice is treated as
proof that the first fix was wrong in kind, not that it was incomplete.

## Fix the class, and make the recurrence structurally impossible

Correcting the reported instance is the start of the work. Ask what would have to
be true for this defect to be unable to happen again, and build that: one source
of truth instead of two that can disagree, a shared component instead of parallel
implementations, a derived value instead of a hardcoded one, a test or a gate
where the invariant can be checked.

"I fixed all the current occurrences" is a weaker answer than "this can no longer
be got wrong", and the difference is the whole task.

## Fix at the layer that owns it

Values belong in the token or component layer, never at the call site. A local
override — a utility class, an inline size, a hand-tuned colour — treats a
systemic problem as a local one and guarantees the next site gets it wrong too.

Before writing markup, find the primitive that already exists. The most common
defect in this tree is a call site hand-building a slot its component provides,
which then also overrides the component's own type and colour, so it drifts twice.

## Surfaces with the same purpose share one implementation

Pages that do the same kind of thing must be isomorphic — same structure, same
affordances, same states. Divergence between them is its own defect class, not a
cosmetic difference, because a UI assembled in parallel diverges by default.

Deliberate exceptions are legitimate but are confirmed with the operator and
recorded, never assumed.

## A platform default you replaced is banned everywhere

When this app takes over a browser or library behaviour, the original is gone
globally, not suppressed on the pages where it was noticed. Removing it in one
place and leaving it in another is worse than not removing it, because the
inconsistency is now invisible until someone finds it by accident.

## Parity with what you replace is the default specification

When rebuilding a surface, everything the old one did is required unless it was
explicitly dropped. Behaviour that quietly disappears in a rewrite is a
regression, not a simplification — enumerate what the old surface did before
declaring the new one finished.

## Measure it in a running browser before saying it is fixed

Reading the source you just edited is not evidence about what renders; computed
style, measured geometry, and per-frame capture from a real engine are.

Confirm you are looking at the instance that contains your change — a stale
server or an unbuilt asset directory has cost hours here. Never hand over
something you have not opened yourself.

A development build is not a production build: React double-invokes effects in
development only, so any claim about timing, work done, or animation count must be
re-checked against a production build.

## Ground every visual and motion value in upstream source

This layer restyles Fluent onto WinUI 3, so it has an external ground truth. Take
values from `microsoft-ui-xaml` at the pinned SHA, from the Community Toolkit, or
from Fluent's installed source — not from a screenshot and not from recollection
of the design language. Cite it at the value.

Where a value follows from other values, derive it by formula. A magic number is
a defect even when it happens to be right, because it cannot survive a change to
what it was derived from.

When reproducing an existing design, work from the artifact and compare side by
side. Eyeballing produces something plausible that is wrong in every state you
did not photograph.

## A bug report is literally true and exactly scoped

Reproduce the stated scenario before theorising; substituting an alternative
cause to avoid the reported one has been wrong every time it was tried here. If
you genuinely cannot reproduce it, name the single missing condition you need.

Scope is exact in both directions. An instruction about one row of one page is
not a rule about the app; when a rule is meant to apply everywhere, this operator
says so. When an instruction refers to existing state — "like the other page",
"the same as before" — go read that state rather than assuming what it is.

## Fail loudly; never degrade gracefully

The defects here are overwhelmingly ordering and lifecycle problems — style
before content, hydration, detached observers, effects running twice — and a
fallback hides those and ships them. Prefer a crash or a failing assertion to a
silent default.

Dig to the root cause rather than the first plausible one, and remove the
instrumentation you added while digging.

## When a fix degrades across iterations, revert and reconsider

Iterative patching on a wrong model leaves dead scaffolding behind even after the
real fix lands. By the third patch, rebuilding from the specification is cheaper
than the fourth. A fix that turned out to be on the wrong path is deleted, not
left in.

## Decisions decay silently; keep them with their scope

On a long branch a local instruction gets applied globally and a deliberate
exception gets "cleaned up" by a later pass. Record what was decided *and the
context it was decided in* — which screen, which question. A decision without its
referent cannot be checked later.

When a later pass wants to change something a decision covers, surface it rather
than rationalising the deviation. Never cite an earlier comment as authority: a
comment is not a source.

## Comments are opt-in

Keep a comment only if deleting it would let a competent reader make a wrong
change — a researched constant with its reference, a non-obvious ordering or
cascade constraint, a decision the code cannot show, a deliberate departure in one
sentence. Delete restatement of the code, narration of a visible mechanism,
history, and anything defensive.

Never claim a conformance you did not verify. An uncited assertion about WinUI or
Fluent is worse than no comment, because the next reader builds on it.

## Leave no trace of the migration

This UI replaced another one. The tree should read as if it had always been
written this way: no concept, name, or shim from the previous dashboard. An
unrelated change belongs in its own change that lands first, not folded into the
work that happened to touch it.

## Working alongside the operator and other agents

Keep a working instance up. Review here happens by looking, continuously, so a
dead server is a stalled review loop; serve a production build when the question
is about shipped behaviour.

Stage only paths you name. `git add -A`, `checkout`, `reset` and `stash` are
destructive under concurrency, and interleaved commits are merely untidy — prefer
the untidy failure. Never kill processes by pattern.

Match an audit's granularity to the thing being audited — per file, per component,
per comment, per effect — and enumerate the whole population. A small number of
agents against a large set is a sampled audit, and a sampled audit is not an
audit.

Do exactly the change asked. Do not stop to confirm what was already delegated,
and if you say you are waiting on something, be doing it. Answer every point of a
multi-part message and say explicitly how each was closed.

## Write for a reader without your transcript

Every report, decision list and summary is read cold. State what each item is,
where it came from, and why it matters — at the level of a durable principle
rather than an incident log.
