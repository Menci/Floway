# Model Resolution

This document describes how the gateway turns an inbound `model` string into a
provider candidate the dispatch layer can call. Three concerns are kept apart:

- **Catalog assembly** — every enabled upstream's catalog is collapsed into
  one gateway-wide list of public model ids keyed by public id, with a
  reverse index of which upstream instances expose each id. Powers the
  listing endpoints; per-request resolution walks per-upstream catalogs
  directly without consulting this artefact.
- **Resolution** — an inbound `model` string is matched against each visible
  upstream's catalog, kind-filtered inside the per-upstream walk, to produce
  a flat list of `(provider, model)` candidates. This step never inspects
  per-endpoint capabilities.
- **Endpoint selection** — when a candidate is actually dispatched, the
  attempt layer reads `model.endpoints` and picks a target protocol from
  its inbound-protocol preference table. A candidate that cannot serve the
  current operation is filtered out at serve time, before dispatch sees
  it.

## Catalog Assembly

Inputs: the operator's enabled upstreams (filtered to the caller's effective
scope when one is set), each upstream's SWR-cached `getProvidedModels`
output, and each upstream's `modelPrefix` policy.

For every upstream model entry, one or more catalog entries are emitted:

- If the upstream has no `modelPrefix`, one entry is emitted at the model's
  bare id.
- If the upstream has a `modelPrefix` with `listed` surfaces, one entry is
  emitted per surface (`unprefixed`, `prefixed`, or both). The prefixed
  surface clones the upstream model with the rewritten id and synthesizes
  `display_name: "<upstreamName>: <originalName>"` so the dashboard tells
  the operator which upstream a prefixed id came from. `providerData` is
  preserved by the clone — the per-provider wire-call still reads the
  real upstream model id from there.

Operator-disabled public ids vanish for that upstream before the entries
are emitted, so a disabled `gpt-4o` hides both `gpt-4o` and
`<prefix>gpt-4o` from the upstream's contribution. The disable does not
cascade to other upstreams.

When two upstreams emit an entry under the same public id, the first wins
for metadata and the later one **endpoint-unions** into it. The merged
`endpoints` is the OR of the participants' endpoint capability flags, and
`kind` is recomputed from the union. The same `endpoints` field carries
different values at different scopes: a per-candidate row's `endpoints`
declares one upstream's wire reach (the row `enumerateRealModelCandidates`
produces carries a single-entry `providerModels` map), while the merged
catalog row's `endpoints` is the gateway-wide reach. Per-request dispatch
always reads the per-upstream `ProviderModel` off the chosen candidate via
`providerModelOf(candidate)`.

Catalog assembly returns two artefacts together:

- `models: InternalModel[]` — public-id-keyed metadata (id, kind, limits,
  cost, plus the merged `endpoints`). `toPublicModel` projects each row
  onto the wire DTO at `/v1/models` and `/models`.
- `upstreamsByPublicId: Map<string, Provider[]>` — every
  upstream instance that emitted an entry under the given public id, in
  enumeration order. The control-plane catalog endpoint reads this to
  render per-model upstream chips without re-walking the catalog.

Output ordering: the public-facing list is sorted by `compareModelIds`
before it crosses any gateway boundary — `/v1/models`, `/models`,
`/v1beta/models`, and the control-plane catalog endpoint.

Failed-upstream surfacing during listing: a catalog fetch that rejects
with `AbortError` propagates so the per-request abort signal cannot be
masked by a slow upstream. Any other rejection is captured into the
assembly's `failedUpstreams: string[]` — but listing and per-request
resolution take separate code paths through the SWR cache, so this list
is local to the listing artefact and does not feed back into resolution.

## Addressable Surfaces

`modelPrefix.addressable` controls which inbound id forms an upstream
**accepts** at resolution time, independent of which forms it `listed` at
catalog assembly time:

- `[unprefixed]` — the inbound id is looked up verbatim against the
  upstream's catalog.
- `[prefixed]` — the inbound id is accepted only if it starts with the
  configured prefix, and the lookup uses `inbound.slice(prefix.length)`.
- `[unprefixed, prefixed]` — both branches are evaluated against the same
  catalog fetch; the unprefixed branch is checked first, so when both
  branches' lookups succeed the unprefixed match wins ordering ties.

A single inbound id can therefore produce **two candidates from the same
upstream** when both branches are addressable, the inbound id literally
starts with the configured prefix, and the catalog lists both the bare
and prefixed forms. Each branch is its own catalog lookup; no
deduplication is performed.

An upstream with no `modelPrefix` is implicitly fully unprefixed.

## Resolution

The per-request resolver runs once per serve invocation and produces the
candidate list every dispatch layer reads.

Inputs:

- `model` — the inbound id verbatim as the client sent it.
- `upstreamIds` — the caller's effective upstream cap (`null` =
  unrestricted; empty list = no providers visible). The cap is the
  intersection of per-user and per-api-key allow-lists; unknown ids raise
  a configuration error rather than silently narrowing.
- `kind` — `chat` / `embedding` / `image`, determined by the inbound
  endpoint, not by the inbound payload. `/v1/completions` reuses the
  `chat` kind and narrows further via its endpoint-key predicate
  (`endpoints.completions !== undefined`).

The resolver is a two-function call chain:

```
enumerateModelCandidates({upstreamIds, model, kind, ...})        ← entry
  └─ enumerateRealModelCandidates(modelId, kind, providers, ...) ← per-id walk
       └─ for each provider, evaluate the prefix / unprefixed branches
          against that upstream's SWR-cached catalog, filtering by `kind`
          inside the loop
```

### `enumerateModelCandidates` — entry

1. List the visible providers through `listModelProviders(upstreamIds)` in
   configured `sort_order`. An empty list yields zero candidates with
   `sawModel: false`; the caller's failure renderer surfaces the resulting
   `model-missing` 404 without a separate throw at this layer.
2. Call `enumerateRealModelCandidates(model, kind, ...)`. If the inner
   walk returns at least one candidate, OR the inner walk's `sawAnyId` is
   true (the inbound id exists in some catalog under any kind), OR the
   inbound id does not match `/-\d{8}$/`, return that result verbatim
   (lifting `sawAnyId` up as `sawModel`).
3. Otherwise the inbound id was unknown to every visible upstream AND it
   matches the dated-suffix shape. Strip the trailing eight digits and
   call `enumerateRealModelCandidates(stripped, kind, ...)` once.
   `failedUpstreams` from the two attempts is deduplicated; `sawModel`
   becomes the retry's `sawAnyId`.

A wrong-kind match (`sawAnyId=true, candidates=[]`) does **not** trigger
the dated-suffix retry — the suffix strip cannot turn a wrong-kind model
into a right-kind one; the empty candidate list surfaces as a 400 "model
exists but the inbound endpoint cannot serve it" instead of a 404.

### `enumerateRealModelCandidates` — per-id walk

For each visible upstream, evaluate the prefix and unprefixed branches
the upstream's `addressable` policy allows. Both branches are independent
lookups against the same SWR-cached catalog fetch:

- Unprefixed branch (when allowed): look up `model.find(m => m.id ===
  modelId)`.
- Prefixed branch (when allowed AND the inbound id starts with the
  upstream's prefix): look up `model.find(m => m.id ===
  modelId.slice(prefix.length))`.

For each branch that found a match:

- If the catalog match's `kind === inboundKind`, push a
  `ModelCandidate { provider, model, fetcher }` into the result.
- If the match exists but `kind !== inboundKind`, set `sawAnyId = true`
  but do not push.

`sawAnyId` aggregates across upstreams: true whenever any branch in any
upstream found the lookup id in its catalog, regardless of kind. Operator-
disabled ids are not counted toward `sawAnyId` (they vanish from the
catalog before lookup).

Per-upstream catalog fetches fan out concurrently so a slow upstream
cannot stall the rest. A catalog fetch that rejects with `AbortError`
propagates so the per-request abort signal cannot be masked. Other
rejections are captured into the per-id `failedUpstreams` list, which
`enumerateModelCandidates` deduplicates across the two attempts and the
caller's failure renderer inlines into 404 / 400 wording as a
parenthetical.

### Why kind threads down

A post-filter shape ("walk first, drop wrong-kind after") would entangle
the dated-suffix retry decision with the kind filter — the retry has to
distinguish "the inbound id was nowhere in any catalog" (worth retrying
on a stripped form) from "the id existed but only under the wrong kind"
(stripping cannot fix that). Threading `kind` into the per-upstream walk
keeps the candidate list clean of wrong-kind entries at every layer and
keeps the `sawAnyId` signal exact: it answers "did this id appear in
some catalog at all" regardless of kind.

The dated-suffix fallback exists for clients that pin to a vendor's dated
release id (typical for Anthropic-style `claude-sonnet-4-5-20250929`)
against a catalog that only lists the base id. It deliberately operates
on the **full resolution flow**, not on a single upstream's catalog, so
the stripped id is tried against every visible upstream in its own
enumeration order.

The resolver never mutates the inbound id on the request body. The
returned candidates carry an `InternalModel` whose `providerModels` map
holds the emitting upstream's `ProviderModel` (with `providerData` and
`enabledFlags`); the dispatch layer reads that entry via
`providerModelOf(candidate)`.

## Candidate Shape

```ts
interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
}
```

- `provider` is the resolved upstream provider instance — every wire call,
  capability flag, and pricing lookup reads off `provider.*` directly
  (upstream id, upstream name, provider kind, `supportsResponsesItemReference`).
- `model` is the merged public row for this id, projected to a single
  contributing upstream: `providerModels` carries exactly one entry keyed
  on `provider.upstream`. That entry is the `ProviderModel` the upstream
  emitted verbatim — its `providerData` carries the per-provider wire id,
  its `enabledFlags` carries the operator's per-model flag set. Dispatch
  and interceptor gates read the entry through `providerModelOf(candidate)`.
- `fetcher` is the per-request proxy-chain-bound `Fetcher` for the
  candidate's upstream, minted once at resolution time and carried with
  the candidate that dispatches.

A target protocol (e.g. `messages` / `responses` / `chat-completions`) is
deliberately **not** part of the candidate — see Endpoint Selection.

## Endpoint Selection

Resolution returns kind-matched candidates without consulting
`model.endpoints`. The actual target endpoint is chosen at attempt
dispatch, by a per-inbound-operation preference table that lives next to
the attempt code:

- `/v1/messages` generate: `messages` > `responses` > `chat-completions`.
- `/v1/messages` countTokens: `messages` only.
- `/v1/responses` generate: `responses` > `messages` > `chat-completions`.
- `/v1/responses/compact`: `responses` > `messages` > `chat-completions`.
  Non-responses targets are reached through the responses-compact-shim
  interceptor, which pivots the action and synthesizes the compact
  envelope from a generate-shaped turn.
- `/v1/chat/completions`: `chat-completions` > `messages` > `responses`.
- `/v1beta/models/{m}:generateContent` and `:streamGenerateContent`:
  `chat-completions` > `messages` > `responses` (Gemini is always served
  via translation).
- `/v1beta/models/{m}:countTokens`: `messages` only.

Each preference table is wrapped by a `chatTargetPicker(preference)`
factory exposing two functions:

- `canServe(endpoints): boolean` — true when at least one preferred
  target's endpoint key is present on the candidate. Serve calls this to
  filter out candidates whose upstream wire cannot serve the inbound
  operation, so dispatch sees only viable candidates.
- `pick(endpoints): ChatTargetApi` — returns the first preferred target
  whose endpoint key is set. Attempt calls this once it has a candidate
  to choose which upstream wire the dispatch goes out on. `pick` is
  contractually total — a call that returns null would mean serve let a
  non-viable candidate through, which is a contract breach.

The per-protocol picker definitions live in the attempt files
(`xTarget = chatTargetPicker([...])`), and both serve and attempt import
the same picker object — serve uses `.canServe`, attempt uses `.pick`.
The `targetApi` decision is therefore exclusively an attempt-time
concern; it is never carried on the candidate or threaded as an explicit
argument.

Passthrough endpoints (`/v1/embeddings`, `/v1/images/*`, `/v1/completions`)
follow the same rule with a single-key predicate
(`endpoints[endpointKey] !== undefined`) instead of a multi-target
preference list. The kind-filter at resolution time guarantees a
chat-kind candidate is never offered to a passthrough endpoint and vice
versa; the endpoint-key check at attempt time then narrows within the
kind.

## Candidate Ordering

Candidates are ordered before they reach dispatch:

- Across upstreams, by configured `sort_order` (lower first). An upstream
  with an explicit `sort_order` ahead of another upstream's gets first
  shot at the inbound id.
- Within a single upstream, the unprefixed branch precedes the prefixed
  one when both apply.

For Responses-shape inbound, the affinity walk
(`classifyResponsesItemAffinity`) adjusts the ordering by stored-item
affinity before dispatch sees it. The walk reads
`provider.supportsResponsesItemReference` to decide whether a candidate
can absorb an unexpanded `item_reference` carrier and rejects a request
that names a forcing upstream the candidate list does not include. The
affinity walk never invents new candidates; it only narrows or re-orders
the list the resolver produced.

Serve dispatches the first candidate of the ordered list exactly once.
The attempt's non-throwing result — an SSE-stream event handoff (chat) or
a 2xx Response (passthrough), an upstream-shaped API error, or an
internal-debug failure — is the request's final answer; an upstream
4xx/5xx surfaces verbatim rather than rolling over to another candidate.

## Known Edges

- A catalog that disabled the inbound id under one upstream still serves
  it from another that allows it; the operator's per-upstream disable
  list is intentionally not cross-cutting.
- A `-\d{8}$` strip is the only inbound-id normalization the gateway
  applies. Vendor variant suffixes (effort tiers, context-window
  variants, fast-mode) are routed by request-body fields against a
  catalog that lists only the base id; clients that send raw variant ids
  receive a model-missing 404 unless their inbound id happens to match
  another upstream's catalog entry verbatim.
- The catalog is SWR-cached per upstream. A model the operator just
  enabled is visible to resolution as soon as the next cached refresh
  lands; SWR-soft hits do not block the request.
- Dual-addressable surfaces (`[unprefixed, prefixed]`) intentionally
  retain both candidate paths instead of deduping. The unprefixed
  candidate precedes the prefix-stripped one in the ordered list, so it
  is the one dispatched.
