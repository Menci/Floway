# Model Resolution

This document follows an inbound model id from catalog discovery to the one
candidate result returned to the client. The stages are deliberately separate:

- **Catalog assembly** merges provider-emitted models into stable public listing
  rows and an upstream reverse index.
- **Model resolution** matches the inbound `model` string and endpoint family to
  an ordered list of `(provider, model)` candidates. It does not choose a chat
  target protocol.
- **Affinity narrowing** may reorder or restrict that existing candidate list;
  it never creates candidates.
- **Target selection** reads one candidate's endpoint map and chooses the
  upstream wire protocol for the current source route/action.
- **Candidate iteration** attempts viable candidates sequentially until a
  shipped result class counts as success, or returns the last failure.
- **Pricing and usage** select the candidate's rate vector, record request count
  separately from measured metric rows, and aggregate realized cost later.

## Catalog assembly

`data-plane/providers/registry.ts` constructs enabled provider instances.
`catalog.ts` assembles their models, while `resolution.ts` performs request-time
matching. Both paths use each upstream's SWR-cached `getProvidedModels` result
and an upstream-scoped proxy-aware fetcher.

For every provider model, `modelPrefix.listed` determines its public catalog
surface:

- With no prefix policy, the bare provider model id is listed.
- With a prefix policy, each listed `unprefixed` or `prefixed` form becomes a
  row. A prefixed row gets the public id `<prefix><provider-id>` and display name
  `<upstream name>: <provider display name>`.
- The operator's disable list is matched against the provider-emitted id before
  any prefix is applied, so a disabled id removes both its unprefixed and
  prefixed forms. The disable is per upstream and does not hide the same id from
  other upstreams.

The prefixed row is a shallow `ProviderModel` clone. `providerData` is preserved
as opaque provider-private invocation data; it is not a universal upstream-id
field. Each provider defines its own shape for it, and a provider that needs no
private data omits it. Dispatch always returns the exact provider's own emitted
`ProviderModel` to its `call*` method.

Rows collide by public id. The first contribution wins ordinary display/limit/
pricing metadata; later contributions union their `endpoints`, recompute `kind`
from that union, and add their own `ProviderModel` to `providerModels` under the
upstream id. Consequently:

- a merged listing row's `endpoints` describes gateway-wide reach and its
  `providerModels` map can contain several upstreams;
- a request candidate is rebuilt from one provider emission, so its
  `providerModels` map and `endpoints` describe only that upstream.

`getModelsFromProviders` returns the merged `InternalModel[]` and
`upstreamsByPublicId`, preserving provider enumeration order in the reverse
index. Per-upstream fetches fan out concurrently. `AbortError` propagates;
other failures are collected while healthy upstreams still contribute rows. If
all catalog fetches fail, the last error surfaces. Listing currently does not
expose the partial-failure names.

### Listing surfaces

Listing routes enumerate addressable ids from the same real catalog. Real rows
are sorted with `compareModelIds`; visible aliases are synthesized afterward in
configured alias order, replacing a colliding real id. The control plane can
append addressable-but-unlisted rows after the listed slice. The same underlying
catalog feeds:

- `GET /v1/models` and `GET /models` — Claude Code discovery and the Floway
  public superset include visible aliases. A Codex User-Agent selects the Codex
  catalog instead; that branch consumes listed real addressable rows only.
- `GET /v1beta/models` and `GET /v1beta/models/{model}` — chat-kind Gemini model
  list and single-model lookup, including visible chat aliases.
- `GET /api/models` — the control-plane list, including visible aliases,
  per-row upstream chips, and optional addressable-but-unlisted rows.

`toPublicModel` projects an `InternalModel` onto the public DTO. Gemini uses its
own projection, Codex synthesizes its client-catalog shape, and the control plane
adds dashboard-only fields. The listing paths and request resolver are separate
consumers of the same SWR cache; listing failures do not feed state into
resolution.

## Addressable surfaces

`modelPrefix.addressable` controls which inbound id forms an upstream accepts,
independently of which forms it lists:

- `[unprefixed]` looks up the inbound id verbatim.
- `[prefixed]` requires the configured prefix and looks up the suffix after it.
- `[unprefixed, prefixed]` evaluates both branches in declaration order against
  the same provider catalog.

An upstream without `modelPrefix` is implicitly unprefixed. A single inbound id
can produce two candidates from one upstream when both forms are addressable,
the id starts with the prefix, and both lookups find catalog rows. Resolution
does not deduplicate these branches. `enumerateAddressableModelIds` separately
adds addressable-but-not-listed forms for alias and control-plane pickers while
pointing them back to their canonical listed row.

## Request-time model resolution

`enumerateModelCandidates` receives:

- the inbound `model` string unchanged;
- `upstreamIds` — the intersection of the user's and the API key's own
  `upstreamIds`, naming the upstreams this request may reach (`null` means
  unrestricted, an empty list means no provider is visible);
- `kind`, derived from the source route: `chat`, `embedding`, `image`, `rerank`,
  or `transcription`;
- the background scheduler and runtime-location tag needed by catalog fetch and
  proxy selection.

`/v1/completions` and `/completions` deliberately use `kind: 'chat'`, then
require the `completions` endpoint key. Resolution itself is endpoint-blind.

The resolver has two top-level branches:

```text
enumerateModelCandidates
  ├─ alias exists
  │    └─ resolve every target in selection order
  │         └─ real-catalog walk, including dated-suffix retry
  └─ no alias
       └─ real-catalog walk, including dated-suffix retry
```

### Real-catalog walk

`enumerateRealModelCandidates` fans out across visible providers while
preserving provider order in its collected result. For each provider it builds
the permitted unprefixed/prefixed lookup ids and searches the cached catalog.
A found row sets `sawAnyId` regardless of kind; only a row whose `kind` matches
the source route becomes a candidate. Disabled ids are absent before this test.

A provider catalog rejection contributes that upstream's display name to
`failedUpstreams`; `AbortError` propagates. The aggregate therefore separates:

- `candidates` — kind-matching real rows;
- `sawAnyId` — the id existed under any kind;
- `failedUpstreams` — non-abort catalog failures.

If the first real-catalog walk finds neither a candidate nor any id, and the
inbound id ends in `-\d{8}`, the resolver strips that suffix once and walks all
providers again. This supports dated client ids such as
`claude-sonnet-4-5-20250929` when a catalog lists only the base id. A wrong-kind
match suppresses the retry because changing the spelling cannot change its
kind. Failure names from the two walks are deduplicated.

The inbound request body is never mutated by this retry. Candidates carry
the real matched model id.

### Alias walk

When the inbound id names an alias, every target is resolved rather than only
the first target with a catalog match. `first-available` preserves declaration
order; `random` shuffles target order. Each target delegates to the complete
real-catalog flow and tags every returned candidate with that target's `rules`.
The results are flattened in target order and deduplicated by
`(model.id, upstream id, rules)`. The same physical binding remains twice when
its rule overlays differ.

This flattening is what lets candidate iteration fall through all upstreams for
one target and then continue into the next target. When no target yields the
requested kind:

- no target id seen under any kind gives `sawModel: false`, and callers render a
  model-missing 404 using the original alias name;
- a target seen only under another kind gives `sawModel: true`, and callers
  render a 400 because the model exists but cannot serve the source endpoint.

Alias names never recurse. A target id is always resolved as a real id, so an
alias that shadows a same-named real model can target that real binding without
re-entering alias lookup.

Alias rows are synthesized only for listings. The Floway/Claude Code shapes on
`/v1/models` and `/models`, both Gemini listing routes, and `/api/models` merge
aliases according to caller scope. The Codex User-Agent branch deliberately
uses listed real addressable rows without alias synthesis. The shared addressable
and alias implementations live under `data-plane/shared/listing/`.

## Candidate shape

```ts
interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}
```

- `provider` is one configured upstream binding: upstream id/name, provider kind,
  prefix policy, and concrete `ProviderInstance`.
- `model` is a real `InternalModel` narrowed to that upstream. Its sole
  `providerModels[provider.upstreamId]` entry is the provider's original
  `ProviderModel`, including opaque `providerData`, resolved `enabledFlags`,
  optional per-model flag overrides, rerank target, and pricing schedule.
  `providerModelOf(candidate)` is the only dispatch accessor.
- `fetcher` runs this upstream's proxy fallback chain, collapsing to direct
  TCP connect when the configured list is empty or fully excluded by the
  request's runtime location.
- `rules` is absent on direct candidates and present on alias candidates,
  including `{}` for an alias target with no overlay.

A candidate never carries the chosen target protocol. Model resolution answers
“which configured upstream/model bindings match?” Target selection answers
“which wire protocol should this attempt use?”

## Target selection

Each chat source route owns an ordered `chatTargetPicker`. Serve uses
`canServe(candidate.model.endpoints)` to remove candidates with no acceptable
target; attempt later calls `pick` on that same picker to choose the first
present endpoint key. A null pick is a contract violation because serve must
have filtered the candidate first.

The shipped preferences are:

- Messages generate: `messages` > `responses` > `chat-completions`.
- Messages count tokens: `messages` only.
- Responses generate and compact: `responses` > `messages` >
  `chat-completions`. Compact reaches non-Responses targets through the compact
  shim, which pivots to a generate-shaped turn and synthesizes the compact
  envelope.
- Chat Completions: `chat-completions` > `messages` > `responses`.
- Gemini generate and stream-generate: `chat-completions` > `messages` >
  `responses`.
- Gemini count tokens: `messages` only.

The picker objects live beside their attempt implementations; source serve and
attempt import the same object. `targetApi` is attempt-local and is neither
part of `ModelCandidate` nor an output of resolution.

Single-wire source routes use the same separation with one endpoint predicate:
OpenAI Completions, Embeddings, Images, and Audio Transcriptions, plus rerank.
The canonical `/v1/*` routes and their shipped bare aliases share the same
handlers where a bare alias exists. Rerank is not a passthrough protocol: after
the `rerank` endpoint check, its provider model must carry a `rerankTarget` that
selects one of the translated target dialects and optional path.

Completions is the passthrough exception in alias-rule handling. It resolves as
`kind: 'chat'`, so a chat alias may carry non-empty rules, but the Completions
wire has no rule-application step and ignores them. Embeddings, Images, Audio
Transcriptions, and Rerank use non-chat alias kinds whose schemas require empty
rules. Chat source routes apply rules after target selection, on the selected
target protocol's native fields: `data-plane/chat/shared/alias-rules.ts` owns
those overlays, and each attempt's terminal wire call runs the matching
`applyRulesToUpstream{ChatCompletions,Responses,Messages}` over the target
payload, dropping any rule the chosen protocol has no native slot for.

Audio Transcriptions buffers and normalizes multipart input before iteration,
then rebuilds it with each attempted provider model id. Its successful media
type selects raw JSON/text/subtitle forwarding or transcription-SSE handling;
it never translates through a chat protocol.

## Candidate ordering and affinity

Before affinity, candidates are ordered:

1. alias target order, when the source id is an alias;
2. upstream order within each target/real-id walk: a request with a non-null
   `upstreamIds` walks that array in its own order — the intersection filters
   the API key's array by the user's set, so the key's order wins whenever the
   key restricts anything — while an unrestricted request walks every enabled
   upstream in configured `sort_order`;
3. addressable-form order within one provider (normally unprefixed before
   prefixed when configured that way).

Chat-shaped ingress analyzes client-carried affinity, then
`selectAffinityCandidates` evaluates every viable candidate. One evaluation
decides both whether the candidate can retain required continuation state and
whether projecting optional state would discard a natural opaque blob. Rejected
candidates leave the list. Accepted candidates that retain every natural blob
come first in their existing order, followed by degrading fallbacks in their
existing order. Removing an originless carrier is not degradation because it
loses no upstream value, though Responses can use its target as the source of a
requirement inherited by later non-portable state. If all accepted candidates
have the same degradation status, alias `first-available` order passes through
unchanged even when another candidate served the previous turn. Affinity never
adds a candidate. Carrier placement, requirement inheritance, restoration, and
the degradation boundary are specified in [AFFINITY.md](./AFFINITY.md).

## Sequential candidate iteration

Serve passes the affinity-selected list to `iterateCandidates`. Attempts
run sequentially, never concurrently. The iterator resets per-attempt timing,
stamps telemetry attribution for the current candidate before calling it, and
classifies the returned envelope exactly as follows:

- `events` is success as soon as the SSE event stream is handed off;
- `result` is success for the non-streaming Responses compact envelope;
- `plain` is success only for a 2xx status;
- `api-error`, `internal-error`, and non-2xx `plain` are failures that fall
  through to the next candidate.

The first success is final. Once an `events` result opens, a later mid-stream
failure cannot start another upstream because the client has already consumed
part of the stream. If every attempt returns a classified failure, the iterator
returns the most recent one; the source renderer forwards that upstream-shaped
result or internal-debug envelope. Thus 4xx/429/5xx responses represented as
`api-error` or non-2xx `plain`, plus represented `internal-error` values, can
roll over while candidates remain. A thrown JavaScript exception is not a
result class: it exits iteration to the source's outer error handler and does
not advance. The final classified failure is never replaced with a synthetic
“all upstreams failed” response.

An empty viable list never enters the iterator. Each source route renders its
own protocol-shaped 404/400 for missing, wrong-kind, or unsupported-endpoint
models.

### Performance timing

Each iteration clears `upstreamCallStartedAt` and `firstOutputTokenAt`.
Providers receive `wrapUpstreamCall`; invoking it stamps
`upstreamCallStartedAt` synchronously immediately before dispatch, so the
interval includes the gateway's own egress work — the proxy-backoff lookup,
dial, TLS, and CONNECT — and excludes gateway pre-dispatch work: parsing,
model resolution, affinity, translation, and interceptor entry. Because the
anchors are cleared per candidate, after a failover the recorded interval is
shorter than the one the client observed.

The first emitted output token stamps `firstOutputTokenAt`. Chat TTFT is their
monotonic difference. A represented failure with no output records a zero-output
error; a successful path without both stamps records neutral performance.
Successful passthrough operations record neutral performance rather than
inventing a token TTFT; their failures remain zero-output errors. Attribution
belongs to the terminal candidate because the iterator replaces the attempt
context before every run.

## Pricing, request counts, and metric rows

`BILLING_METRICS` in `packages/protocols/src/common/pricing.ts` owns the metric
vocabulary. `ProviderModel.pricing` is a reusable `ModelPricing` schedule. Each
schedule has exactly one Base entry with no selector; every non-Base entry has
an explicit selector and exactly the same metric keys as Base. `PriceVector`
values are canonical non-negative decimal strings containing USD per one base
unit of the
named billing metric. Token helpers may accept vendor-published per-million
prices, but they divide during model construction: model metadata, selected
rates, and persisted `unit_price` are always per one token, second, or rerank
search as named by the metric.

```ts
{
  entries: [{ rates: {
    input_tokens: '0.000001',
    output_tokens: '0.000004',
  } }],
}
```

The dashboard may display token rates per million tokens, but that scaling is
UI-only. `unit_price` is not a rate vector and not a per-request total: each
persisted metric row carries one scalar USD rate for one base unit of that row's
`metric`. Realized cost is `quantity * unit_price` with no additional scaling.

Observed quantities are authoritative. General `input_tokens` and
`output_tokens` preserve the upstream's unsplit counters; modality metrics such
as `input_image_tokens`, `input_audio_tokens`, `input_audio_seconds`, and
`output_image_tokens` are used only when the upstream reports disjoint values.
No duration/token or modality conversion is inferred. A measured metric with no
selected rate is still stored with `unit_price: null`.

Runtime pricing facts currently have two axes:

- `serviceTier` is open-string equality after base-tier markers are normalized;
- `inputTokens` selects whole-request threshold bands, not a marginal suffix.

Threshold-only entries are global. Thresholds combined with equality
coordinates apply within that scope. Runtime chooses the highest matching band
across the applicable global and equality-scoped thresholds, then performs one
exact selector lookup. If the full coordinate has no entry, the whole Base
vector is selected; rates are never merged field-by-field or inherited from a
lower band. If the model has no pricing schedule, runtime retains the observed
equality selector and selects `rates: null`.

For one terminal candidate, telemetry snapshots the selected selector and rates
from that exact provider model. Later catalog changes cannot rewrite historical
rows. The naming boundary is:

- `pricing` — reusable model metadata;
- `selector` — the canonical runtime coordinate for one request bucket;
- `rates` — the selected `PriceVector`, or null when wholly unpriced;
- `metric` — one measured quantity vocabulary key and its base unit;
- `quantity` — the canonical decimal amount measured for that metric;
- `unit_price` — that row's canonical per-base-unit USD rate, or null;
- `cost` — the aggregated sum of priced `quantity * unit_price` products.

Request count and metric rows are separate facts. Every terminal call that
reaches `settle` or `settleUsageMeasurement` increments
`usage_requests.requests` for its
`(key, public model, upstream, model key, hour, pricing selector)` bucket even
when the upstream supplies no usage breakdown. The `usage` table receives zero
or more rows keyed by that same bucket plus `metric`; each row aggregates its
own `quantity` and scalar `unit_price`. Repository reads assemble both tables
into one `UsageRecord`, so a request-only record has `requests > 0` and an empty
metric list rather than a fabricated zero-token row.

Aggregation sums request counts independently of metrics. It skips null-price
rows when computing cost: cost is null only when no metric row was priced, and a
non-null cost may still be partial when sibling metrics are unpriced. Quantities,
rates, and costs remain canonical decimal strings through persistence and
aggregation; conversion to JavaScript numbers happens only at the final chart
coordinate boundary.

## Known edges

- Disabling an id on one upstream does not hide the same id on another.
- The `-\d{8}` retry is the only request-time model-id normalization.
- Catalogs are SWR-cached per upstream. Soft-fresh reads do not block on refresh.
- Dual-addressable forms intentionally remain separate candidates. Their order
  follows the configured `addressable` array.
- A listing row's unioned endpoint map must never be used for dispatch; attempt
  code reads the one-upstream candidate row through `providerModelOf`.
