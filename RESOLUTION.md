# Model Resolution

This document describes how Floway turns an inbound model name into a provider
call. Catalog assembly, request resolution, endpoint selection, and pricing are
separate concerns:

- **Catalog assembly** creates the gateway-wide public model list used by model
  listing endpoints.
- **Resolution** walks each caller-visible upstream catalog and returns ordered
  provider candidates for the inbound model name and model kind.
- **Endpoint selection** chooses the upstream wire protocol only when a
  candidate is attempted.
- **Pricing** is metadata on each model. Request telemetry projects runtime
  facts onto one pricing entry and snapshots its rates; only aggregation turns
  usage and rates into realized cost.

## Catalog Assembly

Catalog assembly reads enabled upstreams in configured order, applies the
caller's effective upstream scope, fetches each provider's SWR-cached
`getProvidedModels` output, and applies the upstream's `modelPrefix` policy.

For each upstream model:

- Without `modelPrefix`, Floway emits the bare public id.
- With a prefix policy, Floway emits every configured listed surface:
  `unprefixed`, `prefixed`, or both.
- A prefixed surface preserves `providerData` and rewrites only the public id
  and display name. The provider still sends its original upstream model id.
- An id disabled on one upstream contributes no listed or addressable surface
  from that upstream. Other upstreams remain unaffected.

When several upstreams publish the same public id, the first model supplies
canonical metadata and later models union their endpoint maps into it. The
merged row therefore describes gateway-wide reach, while each request
candidate carries a single-upstream `ProviderModel`. Dispatch always obtains
that provider-specific row through `providerModelOf(candidate)`.

Catalog assembly returns:

- `models: InternalModel[]` — public metadata including id, kind, limits,
  pricing, chat metadata, and the merged endpoint map.
- `upstreamsByPublicId: Map<string, Provider[]>` — every contributing
  upstream in enumeration order, used by the control-plane catalog.
- `failedUpstreams: string[]` — non-abort catalog failures captured for the
  current listing operation.

Public models are sorted with `compareModelIds` before crossing
`/v1/models`, `/models`, `/v1beta/models`, or the control-plane catalog
boundary. `AbortError` always propagates; other catalog failures are surfaced
alongside the partial listing.

## Addressable Surfaces

`modelPrefix.addressable` controls accepted inbound forms independently from
`modelPrefix.listed`:

- `[unprefixed]` looks up the inbound id verbatim.
- `[prefixed]` requires the configured prefix and looks up the suffix.
- `[unprefixed, prefixed]` performs both lookups, unprefixed first.

Both branches are real candidate paths. If an inbound id literally starts with
the configured prefix and both lookups find a model, one upstream can contribute
two candidates. Floway intentionally preserves both rather than deduplicating
them. An upstream without `modelPrefix` is implicitly unprefixed.

## Resolution

The resolver receives:

- the inbound model string;
- the caller's effective upstream ids (`null` means unrestricted);
- the endpoint-derived model kind: `chat`, `embedding`, or `image`.

Unknown upstream ids are configuration errors. An empty upstream list exposes
no candidates. The inbound protocol determines kind; payload contents do not.
`/v1/completions` uses chat kind and later requires the completions endpoint.

The top-level flow is:

```text
enumerateModelCandidates
  ├─ matching alias
  │    └─ walk every target in selection order
  │         └─ real-catalog lookup with the target's rule overlay
  └─ no alias
       └─ real-catalog lookup for the inbound id
            └─ one dated-suffix retry when the id was absent everywhere
```

### Real-catalog lookup

For each visible upstream, the resolver performs every allowed addressable
lookup against the same cached catalog. A match of the requested kind becomes
a `ModelCandidate`; a wrong-kind match sets `sawAnyId` but is not returned.
This distinction lets callers report:

- 404 when the id is absent;
- 400 when the id exists but cannot serve the inbound model kind.

Catalog fetches fan out concurrently. `AbortError` propagates and every other
failure is recorded in `failedUpstreams`.

### Dated suffixes

When the first real-catalog walk finds neither candidates nor any id match, an
inbound name ending in `-\d{8}` is retried once without the suffix. A
wrong-kind match never triggers this retry. The retry runs across all visible
upstreams rather than rewriting one provider's catalog, and it never mutates
the request body.

## Alias Resolution

An alias is resolved inside the same top-level call as a real model. Floway
walks every target in selection-mode order:

- `first-available` preserves declaration order;
- `random` shuffles target order.

Each target delegates to the real-catalog resolver, including dated-suffix
handling. Returned candidates carry that target's rule overlay. The flattened
list is deduplicated by `(model.id, provider.upstream, rules)`: identical
triples collapse, while the same provider/model with distinct rules remains
distinct.

Alias targets never re-enter alias lookup. A target id is resolved as a real
model id, so an alias may safely shadow a real name. When no target yields a
kind-compatible candidate, the normal model-missing response uses the alias
name.

For chat protocols, each attempt applies alias rules immediately before the
terminal provider call. It then normalizes `payload.model` to the resolved
candidate id and lets the provider stamp its own wire id from
`providerData`. Gemini carries the inbound model on the URL and dispatches
directly from the candidate id.

## Candidate Shape

```ts
interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}
```

- `provider` owns the upstream id, provider kind, provider capabilities, and
  provider instance.
- `model` is the public row narrowed to one contributing upstream.
- `fetcher` is bound to that upstream's proxy fallback chain for the current
  request.
- `rules` is present only for alias-origin candidates.

The candidate deliberately carries no target protocol. Protocol selection is
an attempt-time concern.

## Endpoint Selection

Resolution filters by model kind but does not choose a wire protocol. Each
attempt shares a `chatTargetPicker` with its serve layer:

- `canServe(endpoints)` filters candidates before dispatch.
- `pick(endpoints)` selects the first available target from the operation's
  preference list.

Current preferences are:

- Messages generate: Messages → Responses → Chat Completions.
- Messages count tokens: Messages only.
- Responses generate: Responses → Messages → Chat Completions.
- Responses compact: Responses → Messages → Chat Completions.
- Chat Completions: Chat Completions → Messages → Responses.
- Gemini generate/stream: Chat Completions → Messages → Responses.
- Gemini count tokens: Messages only.

Passthrough endpoints use one exact capability key instead:

- Completions requires `endpoints.completions`.
- Embeddings requires `endpoints.embeddings`.
- Image generation/edit requires its corresponding image endpoint.

The kind check and endpoint check are intentionally separate. Kind explains the
model family; endpoints describe the concrete upstream wires.

## Pricing and Cost

Model metadata uses `pricing?: ModelPricing`. A model's pricing is a rate
schedule, not money already spent:

```text
ModelPricing
  → runtime facts (service tier, input-token count)
  → exact PricingEntry
  → PriceVector rates snapshot
  → token counts × rates
  → realized USD cost
```

`ModelPricing.entries` is a sparse Cartesian map. Exactly one entry has the
empty selector and acts as Base; every other entry declares the same rate
dimensions as Base. Missing selector combinations and missing rate dimensions
are unpriced; there is no inheritance, precedence, multiplier, or cache/image
rate fallback.

The naming boundary is enforced in code and on the wire:

- `pricing` — reusable model metadata and operator-authored configuration;
- `rates` — the resolved per-dimension `PriceVector` stored with a usage
  bucket;
- `unit_price` — the persisted scalar SQL value for one billing dimension;
- `cost` — the aggregatable USD result exposed by token-usage views.

Telemetry snapshots the selector and rates at request time so later catalog
price changes cannot rewrite historical usage. SQL bucket identity includes the
canonical selector JSON.

## Candidate Ordering and Failure Semantics

Candidates preserve configured upstream order. Within one upstream, the
unprefixed addressable path precedes the prefix-stripped path. Responses item
affinity may narrow or reorder this list but never creates candidates.

Dispatch stops on the first candidate's non-throwing result. Successful
responses, upstream-shaped API errors, and internal-debug failures are final;
Floway does not roll over after an upstream 4xx/5xx. This preserves upstream
status, headers, and body.

## Known Edges

- Disabling a public id is per-upstream, not global.
- Date stripping is the only inbound model-name normalization.
- Vendor effort, context, and fast-mode suffixes are not accepted unless an
  upstream catalog publishes them as ids.
- Catalogs are SWR-cached per upstream; newly available models appear after the
  next refresh.
- Dual-addressable prefix policies intentionally retain both candidate paths.
- A listing may be partial when one upstream catalog fails; request resolution
  performs its own catalog walk and failure accounting.
