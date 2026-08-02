# AGENTS.md — apps/web

How to work in this package. The architecture is in the repo-root `AGENTS.md`,
and so are the working rules that apply to the whole repository — read its
Working Rules section first; this file adds only what is specific to the
dashboard.

The dominant failure here is a change made from a mental model of the code
rather than from observed reality, then declared done on partial evidence.

## Measure it in a running browser before saying it is fixed

Reading the source you just edited is not evidence about what renders; computed
style, measured geometry, and per-frame capture from a real engine are.

Confirm you are looking at an instance that contains your change — a stale
server or an unbuilt asset directory has cost hours here. Never hand over
something you have not opened yourself.

A development build is not a production build. React double-invokes effects in
development only, so any claim about timing, work done, or animation count must
be re-checked against a production build.

## Ground every visual and motion value in upstream source

This layer restyles Fluent onto WinUI 3, so it has an external ground truth.
Take values from `microsoft-ui-xaml` at the pinned SHA, from the Community
Toolkit, or from Fluent's installed source — not from a screenshot and not from
recollection of the design language. Cite it at the value.

Where a value follows from other values, derive it by formula. A magic number is
a defect even when it is right, because it cannot survive a change to what it
was derived from.

When reproducing an existing design, work from the artifact and compare side by
side. Eyeballing produces something plausible that is wrong in every state you
did not photograph.

## Fix at the layer that owns it

Values belong in the token or component layer, never at the call site. A local
override — a utility class, an inline size, a hand-tuned colour — treats a
systemic problem as a local one and guarantees the next site gets it wrong too.

Before writing markup, find the primitive that already exists. The most common
defect in this tree is a call site hand-building a slot its component provides,
which then also overrides the component's own type and colour, so it drifts
twice.

## Surfaces with the same purpose share one implementation

Pages that do the same kind of thing are isomorphic — same structure, same
affordances, same states. A UI assembled in parallel diverges by default, so
divergence is a defect class rather than a cosmetic difference. Deliberate
exceptions are confirmed with the operator and recorded, never assumed.

## A platform default you replaced is banned everywhere

When this app takes over a browser or library behaviour, the original is gone
globally, not suppressed on the pages where it was noticed. Removing it in one
place and leaving it in another is worse than not removing it, because the
inconsistency is invisible until someone finds it by accident.

## A report is a sample, not the population

The characteristic defect here is the partial fix: one call site of five, light
mode only, resting state only. After the reported instance, sweep for the class
— every state, every theme, every call site.

This holds for copy as much as code. Terminal punctuation, dash forms and
capitalisation are app-wide invariants, so one wrong instance means a sweep.

## Fail loudly

The defects here are overwhelmingly ordering and lifecycle problems — style
before content, hydration, detached observers, effects running twice — and a
fallback hides those and ships them. Prefer a crash or a failing assertion to a
silent default. Remove the instrumentation you added while digging.

## Comments are opt-in

Keep a comment only if deleting it would let a competent reader make a wrong
change: a researched constant with its reference, a non-obvious ordering or
cascade constraint, a decision the code cannot show, a deliberate departure in
one sentence. Delete restatement of the code, narration of a visible mechanism,
history, and anything defensive.

Never claim a conformance you did not verify. An uncited assertion about WinUI
or Fluent is worse than no comment, because the next reader builds on it.

## Keep a working instance up

Review here happens by looking, continuously, so a dead dev server is a stalled
review loop. Serve a production build when the question is about shipped
behaviour.
