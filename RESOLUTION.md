# Model Resolution

This document describes how Floway turns an inbound `model` string into an
ordered set of dispatchable candidates. Catalog assembly, name resolution,
client-carried affinity, endpoint selection, fallback, and pricing are distinct
stages.

## Catalog assembly

Catalog assembly reads enabled upstreams in configured `sort_order`, each
upstream's SWR-cached `getProvidedModels()` result, and its `modelPrefix`
policy. It builds public listing metadata; request resolution still walks
per-upstream catalogs so dispatch retains the exact provider model object.

For each upstream model:

- no prefix policy emits the bare ID;
- a prefix policy emits every configured `listed` surface (`unprefixed`,
  `prefixed`, or both);
- prefixed rows keep the provider's opaque `providerData` but expose a public
  ID and display name prefixed with the upstream name;
- public IDs disabled for that upstream are removed before either surface is
  emitted.

When multiple upstreams expose the same public ID, the first contributes the
display metadata and later rows union their endpoint capability maps. `kind` is
recomputed from that union. This merged row is only a listing artefact. A
request candidate carries a single-upstream `InternalModel` whose
`providerModels` map contains exactly the selected upstream's original
`ProviderModel`; provider dispatch reads it through `providerModelOf()`.

Catalog assembly returns:

- `models: InternalModel[]`, projected onto `/v1/models`, `/models`,
  `/v1beta/models`, and the control-plane catalog;
- `upstreamsByPublicId: Map<string, Provider[]>`, used by the dashboard to
  render every upstream contributing a public ID;
- the upstream names whose catalog fetch failed.

Public model lists are sorted by `compareModelIds`. An `AbortError` always
propagates. Other upstream catalog failures are collected so listing and
request errors can identify unavailable upstreams without discarding successful
catalog contributions.

## Addressable model surfaces

`modelPrefix.addressable` is independent from `listed`:

- `unprefixed` looks up the inbound ID verbatim;
- `prefixed` first requires the configured prefix, then looks up the suffix;
- both forms evaluate both lookup branches against one cached catalog fetch.

An upstream with no prefix policy accepts the unprefixed form. When both forms
are addressable and both catalog lookups succeed, they are independent
candidates; the unprefixed branch is ordered first.

## Candidate enumeration

Every source serve calls:

```text
enumerateModelCandidates({ upstreamIds, model, kind, ... })
  ├─ alias exists → walk all ordered alias targets
  │                  resolve each target against real catalogs
  │                  attach that target's rules
  │                  flatten and deduplicate exact candidate identities
  └─ no alias     → resolve the inbound ID against real catalogs
                     retry once without a trailing -YYYYMMDD only when
                     the first pass found the ID nowhere
```

Inputs are:

- the exact inbound `model` string;
- the effective upstream scope, which intersects user and API-key allow-lists
  (`null` is unrestricted; an empty list exposes no upstreams);
- the endpoint's broad model kind (`chat`, `embedding`, or `image`);
- the request scheduler and runtime location used by catalog and proxy work.

Unknown upstream IDs in a scope are configuration errors. Disabled but known
upstreams are simply absent.

The real-catalog walk fans out across visible upstreams. Each matching branch
sets `sawAnyId`; a candidate is added only when the catalog row's kind equals
the request kind. This distinction matters to dated-suffix fallback: an ID
that exists under the wrong kind yields an unsupported-endpoint error, not a
second lookup under a modified name. Non-abort catalog failures are collected
and do not prevent other upstreams from contributing candidates.

The only implicit model-name normalization is removal of one trailing
`-\d{8}` release date when the original ID was absent from every catalog.
Vendor variants and arbitrary suffixes are not guessed.

## Alias resolution

An alias is resolved inside the same enumeration call as a direct model.
`first-available` walks targets in declaration order; `random` shuffles the
available targets. Each target delegates to the complete real-model resolution
flow, including prefix handling and dated-suffix retry.

Candidates from every target are flattened in target order and deduplicated by:

```text
canonical model ID
+ upstream ID
+ optional alias-rule value (`undefined` differs from `{}`)
```

Rule presence matters: a direct candidate with `rules === undefined` is
different from an alias candidate carrying `{}`. Different rule variants for
the same physical binding remain independently dispatchable.

Alias rules ride on `ModelCandidate.rules` and are applied only at the terminal
wire call, after translation, by
`applyRulesToUpstream{ChatCompletions,Messages,Responses}`. A target protocol
with no slot for a rule omits it. Gemini is source-only, so its alias rules are
applied after translation on the selected chat target. Embedding, image, and
text-completion aliases are schema-restricted to empty rules.

Alias names never recursively enter alias resolution; alias targets are real
model IDs. Listings expose aliases, and an alias shadows a real row of the same
public ID. Response model fields identify the canonical model that actually
served the request.

## Candidate shape and identity

```ts
interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}
```

- `provider` owns the upstream ID, name, kind, prefix policy, and
  provider implementation;
- `model` is the canonical public row projected to that upstream and contains
  its exact `ProviderModel`;
- `fetcher` is the request-scoped proxy-aware fetcher for that upstream;
- `rules` distinguishes direct resolution from an alias target and carries the
  post-translation overlay.

The target API is not part of a candidate. It is chosen from that candidate's
endpoint metadata at attempt time.

Client-carried affinity serializes the exact dispatch identity:

```text
upstream ID
+ canonical model ID
+ optional alias-rule value (`undefined` differs from `{}`)
```

Ordinary preference and discardable opaque restoration use exact rule
structure, matching candidate deduplication. Force evidence and non-discardable
state restoration compare only upstream and canonical model. Different rule
variants on that target remain viable, with an available exact preference
ordered first.

## Client-carried affinity routing

Every API key has a hidden 256-bit server secret for gateway-private
per-key data. Affinity derives a dedicated key from it. The source-protocol
ingress scans opaque reasoning carriers and attempts AES-GCM authentication.
Successfully decoded envelopes yield immutable target identities and restore
metadata. Protocol ingress derives request-local `prefer` or `force` evidence
from the carrier's current location; routing strength is never stored in the
encrypted envelope. A value that is malformed, belongs to another key, or
belongs to another Floway instance is foreign and contributes no constraint.

Affinity has two strengths:

- `prefer` is ordinary, discardable reasoning continuity. The last preferred
  target that is currently available is moved to the front. If it is absent,
  normal candidate order is retained.
- `force` represents state that cannot be translated or discarded, including
  Responses compaction and programmatic state. One forcing identity retains
  every candidate with the required upstream and canonical model; it does not
  filter alias rules. An unavailable force or multiple incompatible forces
  returns `routing-unavailable` before any upstream call.

Responses program and compaction state is recognized when the client carries
the result back, at which point ingress promotes the associated upstream/model
to force. Envelope framing and per-protocol placement are documented in
[AFFINITY.md](./AFFINITY.md).

Affinity never invents candidates and never bypasses the user's upstream
scope. It only filters or reorders viable candidates returned by ordinary
resolution.

Ingress produces a pure candidate payload factory. For every attempt it clones
the original source payload, restores discardable owned values for an exact
optional-rules match and non-discardable force state for an upstream/model
match, removes incompatible owned values, and leaves foreign values
byte-for-byte. This per-attempt clone prevents a failed candidate's rewrites
from leaking into fallback.

Responses has one additional ordering requirement. The store first expands
`previous_response_id` and hydrates every gateway item ID into its complete
payload; affinity is decoded from that hydrated history afterward. This lets
stored and client-supplied history use one routing path without making the
Responses repository understand affinity.

## Endpoint selection

After enumeration, each source serve removes candidates that cannot implement
the operation. The attempt layer then selects the first advertised endpoint in
the source's preference table:

| Source operation | Target preference |
| --- | --- |
| Messages generate | Messages → Responses → Chat Completions |
| Messages count tokens | Messages only |
| Responses generate | Responses → Messages → Chat Completions |
| Responses compact | Responses → Messages → Chat Completions |
| Chat Completions | Chat Completions → Messages → Responses |
| Gemini generate | Chat Completions → Messages → Responses |
| Gemini count tokens | Messages only |

`chatTargetPicker(preference)` exposes `canServe(endpoints)` for serve-time
filtering and `pick(endpoints)` for attempt dispatch. `pick()` is total after
the filter; failure means a programming invariant was broken.

Responses compact uses the native compact operation where available. On a
Messages or Chat target, the compact interceptor performs a generate-shaped
summarization turn and returns a source-shaped compact result.

Passthrough endpoints use one endpoint-key predicate instead of a preference
table. `/v1/completions` shares the broad chat kind but still requires the
candidate's `completions` endpoint.

## Attempt ordering and fallback

Normal candidate order is alias-target order, then upstream `sort_order`, then
the unprefixed branch before the prefixed branch. Affinity is applied after
endpoint viability and before attempts.

`iterateCandidates` creates fresh attempt timing state and invokes candidates
sequentially. A successful event-stream handoff, a successful plain response,
or a compact result ends iteration. Pre-stream API and internal errors continue
to the next candidate; the final failure is returned unchanged when the list is
exhausted. Once a stream is handed to the client, a later stream error cannot
restart on another upstream.

The winning candidate is recorded in the request affinity context. Only after
events have returned to the source protocol does the responder add encrypted
client affinity. Provider and translation layers never see Floway's envelope.

## Pricing and cost

Each `ProviderModel` may carry `pricing: ModelPricing`, a reusable schedule of
selector coordinates and rate vectors:

```text
ProviderModel pricing
→ runtime facts (tier, input-token threshold)
→ exact PricingEntry
→ PriceVector snapshot on the usage bucket
→ token counts × rates
→ realized USD cost
```

Exactly one Base entry has no selector. Non-Base entries declare explicit
coordinates. Service tier is an open-string equality axis. Input-token
thresholds reprice the whole request, not a marginal suffix; the highest
matching global or scoped threshold is selected before one exact coordinate
lookup. A missing coordinate uses the complete Base vector rather than merging
fields from several entries.

Terminology is enforced across code and storage:

- `pricing` is model metadata;
- `rates` is the resolved request vector;
- `unit_price` is one persisted billing-dimension scalar;
- `cost` is the aggregated USD result.

Telemetry snapshots the selected coordinate and rates from the exact candidate
that dispatched, so later catalog changes cannot rewrite historical usage.

## Known edges

- Disabling a model on one upstream does not affect the same public ID on
  another upstream.
- A soft SWR catalog hit may briefly expose the previous upstream catalog until
  refresh completes.
- Dual-addressable prefix policies intentionally keep two candidate paths.
- A preferred affinity target that disappeared is a normal cache miss; a forced
  target that disappeared is an explicit error.
- Replacing API-key affinity material makes existing owned client envelopes
  foreign. Normal key creation and updates preserve the hidden secret; admin
  transfer format version 10 is the supported way to move it with the key.
