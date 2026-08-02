# AGENTS.md — apps/web

Working rules for the dashboard SPA. Architecture lives in the repo-root
`AGENTS.md`; this file is only what experience says goes wrong here.

## Suspect the instrument before the conclusion

A surprising measurement is more often a broken measurement. Grepping for
"non-comment lines" as `^[+-]\s*(//|\*|/\*)` counts every continuation line of a
CSS comment inside a `.css.ts` template literal as code, and every JSX
`{/* … */}` as code because the braces survive. `curl -w '%{http_code}' || echo
000` prints `000000` on failure, because curl already printed its own `000`.
Before reporting a number, check what it counts by hand on two or three cases
you can verify.

The same rule applies to a claim about the code. Roughly a third of the findings
raised in a large audit of this app were disproved — a percentage that was
already rounded at both producers, a CSS family a render probe found present in
the DOM, a "stranded" flag that terminates under every interleaving, a
"duplicate" module that imports the other one, a "verbatim" duplicate whose
copies differ because one axis is logarithmic. Trace the path and quote the
lines. If you cannot, say so instead of asserting.

## Reach for the primitive that exists

The most common defect in this tree is a call site hand-building a slot its
component already provides: a `MessageBar` title stacked out of two `<Text>` in
a `<div className="grid gap-1">`, a link built from a router `Link` plus a brand
colour class, a settings row assembled by hand. The hand-built version also
overrides the component's own type size and fill, so it drifts twice.

Before writing markup, read `components/ui/` and the component's own definition.
If a slot exists, use it. If you genuinely need to depart, say why at the site.

## Comments are opt-in

Keep a comment only if deleting it would let a competent reader make a wrong
change. That is the whole test, applied per comment.

Keep: a vendor constant's source with its permalink; a decision the code cannot
show; a workaround with its upstream reference; a non-obvious ordering,
cascade or lifetime constraint; a deliberate departure from a default, in one
sentence.

Cut: restatement of the next line; narration of a mechanism the code shows;
multi-paragraph derivations where a citation plus one sentence carries the same
information — length is itself the defect, because the one load-bearing
sentence hides behind the fourteen that are not; history; and anything
defensive ("do not change this back"), which exists to deter review rather than
to inform.

## Never invent authority

Every vendor constant needs a reference URL — microsoft-ui-xaml at the pinned
SHA `188f602b27cdb47572b28c380e9c087b02e1ccee`, or a pinned Fluent or Community
Toolkit commit. A comment must not claim a WinUI derivation, an operator
decision, or a Fluent behaviour it cannot cite; an audit of this layer found
five Fluent claims that were simply false, and a comment that cites another
comment as its authority is a circle, not a source.

`data/visual/pinned-departures.md` records departures the operator chose. Read
it before calling anything a defect — but it is itself agent-authored, so "it is
pinned" is not evidence that the human pinned it.

## An instruction is locally scoped unless it says so

When this operator means a rule to apply everywhere he writes 全局, 彻查, 审计,
扫一下, or 所有…都. Absent those words, an instruction describes the screen he
was looking at. "所有非等宽 12px 字体都增大到 14px" was about one row of one
page; implemented as a global type-ramp change it was wrong in both directions
— the ramp moved, and the one row he asked about never got the change.

Record what he was looking at, not only what he said. A deictic instruction
without its referent is not evidence of anything.

## StrictMode double-invocation is a detector

React 18+ double-invokes effects in development, and `<Activity>` does the same
in production: a subtree's effects are unmounted and remounted with state
preserved. So every effect must answer — if setup ran, then cleanup, then setup
again, is the result the same as running setup once?

Failing that test is a real defect even when only development shows it. A guard
that sets a ref and returns without registering a cleanup is the shape that has
bitten this app repeatedly. A ref-guarded once-only effect is legitimate only
when the thing it does has no coherent cleanup — a first-paint entrance
animation is the canonical case.

Because the symptom is development-only, any timing or performance measurement
must be repeated against a production build.

## `disabled` versus `disabledFocusable`

`disabled` emits the HTML attribute: the control leaves the tab order and focus
is lost. `disabledFocusable` emits `aria-disabled` with no HTML `disabled`: the
control keeps focus and tab order, is announced as disabled, and Fluent
prevents the click. XAML states the same distinction as
`FrameworkElement.AllowFocusWhenDisabled`.

A control unavailable because its own command is in flight takes
`disabledFocusable`; a control unavailable for an external reason takes
`disabled`. Do not take focus out from under the button the operator just
pressed. `components/proxy/proxy-dialog.tsx`'s dialog actions are the reference.

## Half a fix is worse than none

A recurring shape here: correcting one half of a pair the source always plays
together makes the defect more visible, not less. An indicator that gained its
travel and lost its fade; a progress strip whose container faded while its bars
had already been dropped; `shadow4: 'none'`, correct for its own use, which
invalidated every focus ring composed as a shadow list. When a change touches
one member of a pair, name the other and say what happens to it.

## Verification covers less than it looks

`typecheck`, `lint` and `test` do not exercise the bundle. When a change touches
`vite.config.ts`, a pnpm patch, the UnoCSS scan, or dependency pre-bundling, run
`pnpm --filter @floway-dev/web run build` as well — the dev and build paths do
not apply the same plugin pipeline, and `optimizeDeps` entries bypass plugin
`transform` hooks entirely.

For anything visual, build before and after and diff the emitted stylesheet. For
a comment-only change the emitted CSS must be byte-identical.

Run `npx eslint` from the repo root; with `apps/web` as cwd the flat config
resolves a tsconfig path that does not exist there.

## Running the dev pair

`pnpm run dev` from the **repo root** — from `apps/web` it runs that package's
own dev script and no Worker starts, which looks like a working server with a
dead API.

`wrangler dev` serves static assets from `apps/web/dist/client` and exits if
that directory is missing, and `concurrently -k` then kills Vite. A `SIGTERM`
in the log is that reaping, not the cause: read the lines above it. If the
directory is gone, `pnpm --filter @floway-dev/web run build` restores it.

After merging `main`, apply migrations (`pnpm -w run db:migrate`) before
assuming a runtime error is a code defect.

## Sharing the branch with other agents

Never `git add -A` or `git add .`; stage the exact paths you changed and commit
immediately. A broad add sweeps another agent's in-flight files into your
commit, which has produced wrong attribution and, once, a committed state that
did not compile.

Never `pkill`/`killall`; kill only PIDs you recorded. The operator's dev server
runs under `concurrently -k`, so a pattern that matches one child takes the pair
down mid-review.

Do not rewrite a commit that others have built on. On this branch history is
squashed on the way to `main`, so a badly-scoped commit costs nothing; a rewrite
under concurrent work costs a great deal.
