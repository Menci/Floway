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

Confirm you are looking at an instance that contains your change — the right
worktree, the right branch, rebuilt if it needed rebuilding. Never hand over
something you have not opened yourself.

A development build is not a production build. React double-invokes effects in
development only, so any claim about timing, work done, or animation count must
be re-checked against a production build.

Measure the property that was named, in the state that was named. A box's
position is not the alignment of the text inside it, font metrics are not
rasterised ink, a replica is not the component, and a served status code is not
a working page. When measurements contradict what someone can plainly see, stop
measuring and read the pixels.

## Ground every visual and motion value in upstream source

This layer restyles Fluent onto WinUI 3, so it has an external ground truth.
Take values from `microsoft-ui-xaml` at the pinned SHA, from the Community
Toolkit, or from Fluent's installed source — not from a screenshot and not from
recollection of the design language. Cite it at the value, and make the citation
cover that value: a reference landing near the thing it justifies satisfies the
rule and catches nothing.

Transcribe the constraint, not the number. A value carries a kind — a bound on
painted ink, a floor a computed size may already exceed, a shorthand that cannot
be split across sides — and the digits without the kind are right in the
dictionary and wrong on screen. It also assumes a context: what it sits on, what
is behind it, what was already applied. State both where the value is declared.

Where a value follows from other values, derive it by formula. A magic number is
a defect even when it is right, because it cannot survive a change to what it
was derived from. When sites disagree on an unsourced value, the one upstream
resource that states the quantity decides — never the majority.

A departure from upstream belongs to the human and is recorded in their words. A
rationale you wrote for your own departure is not a decision, and a comment
claiming the faithful option was impossible is a claim to check — check it and
take the faithful option if it is there, rather than deleting either one on
suspicion.

When reproducing an existing design, work from the artifact and compare side by
side. Eyeballing produces something plausible that is wrong in every state you
did not photograph.

## Fix at the layer that owns it

Values belong in the token or component layer, never at the call site. A local
override — a utility class, an inline size, a hand-tuned colour — treats a
systemic problem as a local one and guarantees the next site gets it wrong too.

Before writing markup, find the primitive that already exists, and use it for
the meaning its own documentation gives it rather than for how it happens to
look. The most common defect in this tree is a call site hand-building a slot
its component provides, which then also overrides the component's own type and
colour, so it drifts twice.

Know which way a rule propagates before you write it. Redefining a token reaches
everything below that reads it by name; setting a property directly stays local
but outranks the state rules meant to change it; a rule stated in shorthand
deletes what a call site set in longhand.

One fact usually reaches the screen through more than one outlet — the control's
own class and another component's slot, every cell of a state table, a rule
cancelled in one stylesheet and alive in its sibling. Fixing one outlet leaves
two places asserting opposite things about the same surface.

Removing a source removes the reason for its compensations: sweep for the
negative margins and hardcoded sizes that existed only to cancel it. And a
library default is not this app's default — where the library resolves a prop to
nothing, the app's value is stated once, at the wrapper.

## A frozen surface is defined by what it renders

Touching none of its files is not compliance: a flattened token or a global
reset reaches a frozen subtree without appearing in its diff. Give it an escape
whose selectors name none of it — a contract must not depend on happening to
miss.

## Match the component to what the thing is

A component carries meaning, not only pixels. A settings row says "a setting the
system remembered"; an operation says "you run this once". No amount of upstream
sourcing surfaces this — only asking what the surface *is*.

## A module is named for its job, not for its directory

A file under `components/<x>/` never repeats `<x>`: the directory already said
it, and a name that says it again spends itself on what the path already
carries. The suffix carries the job — `data.ts` talks to the network, `plot.ts`
builds a chart model — and the leading words distinguish it from its siblings.

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

## Delivered means rendered

A component nobody mounts and a translation key with no string behind it both
pass every check this package runs, and a missing key renders as itself, so the
failure reads as bad copy rather than as an error. Confirm the new thing
replaced what it was meant to replace instead of sitting beside it, and that
everything it names exists.

## Fail loudly

The defects here are overwhelmingly ordering and lifecycle problems — style
before content, hydration, detached observers, effects running twice — and a
fallback hides those and ships them. Prefer a crash or a failing assertion to a
silent default. Remove the instrumentation you added while digging.

A failed fetch is not an empty result. Rendering one as the other produces a
confident lie: a telemetry page of zeros, or an invitation to add your first
upstream shown to an operator whose server is down.

This app renders the whole document, so a hydration mismatch makes React discard
the prerendered tree and rebuild it, taking with it anything else attached to
the document. Recoverable-error handling therefore throws, and code that keeps a
node resident asserts that it is still connected rather than healing itself.

Never write an operator-visible failure path that can echo stored input back to
the screen.

## Comments are opt-in

Keep a comment only if deleting it would let a competent reader make a wrong
change: a researched constant with its reference, a non-obvious ordering or
cascade constraint, a decision the code cannot show, a deliberate departure in
one sentence. Delete restatement of the code, narration of a visible mechanism,
history, and anything defensive.

Never claim a conformance you did not verify. An uncited assertion about WinUI
or Fluent is worse than no comment, because the next reader builds on it. A
corroboration that later turned out to be false is deleted, not softened.

**A comment inside a `.css.ts` module must not contain a backtick.** Those files
hold their CSS in a template literal, so one backtick in a comment terminates
the literal and the whole file stops parsing — the failure is the module, not
the rule. Write property and prop names bare.

## Keep a working instance up

Review here happens by looking, continuously, so a dead dev server is a stalled
review loop. Serve a production build when the question is about shipped
behaviour, and point the instance at its gateway through the environment rather
than by editing checked-in config.
