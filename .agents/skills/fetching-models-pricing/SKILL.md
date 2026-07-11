---
name: fetching-models-pricing
description: Use when refreshing a per-model pricing table for a Floway
  provider whose upstream doesn't publish per-token rates and needs
  notional billing (Copilot, Codex, Ollama). Manual procedure — no script.
---

# Fetching Models Pricing

Floway's subscription / free providers (Copilot, Codex, Ollama) each own a
hardcoded per-model pricing table. The upstream doesn't bill per token — it's
a flat subscription or self-hosted at zero cost — but the dashboard tracks
"value consumed" as if the operator were paying the model on its own API.
This skill is how those tables stay in sync with reality.

## The three tables

| Provider | File | Catalog source | Source of truth |
|---|---|---|---|
| Copilot | `packages/provider-copilot/src/pricing.ts` | Copilot `/models` per account | <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing> |
| Codex   | `packages/provider-codex/src/pricing.ts`   | `/codex/models` via ChatGPT OAuth | <https://openai.com/api/pricing/> |
| Ollama  | `packages/provider-ollama/src/pricing.ts`  | `/api/tags` + `/api/show` on the configured base URL | varies per model family — vendor first-party where the vendor operates an API, commodity host otherwise |

All three tables share the same shape: `readonly [key, ModelPricing][]` with
first-hit-wins, where `key` is either a literal model id string or a RegExp.

## Flow

1. **Pull the live catalog** for the provider you're refreshing.
   - Copilot: load a real Copilot upstream and inspect what
     `getProvidedModels` returns (`packages/provider-copilot/src/provider.ts`),
     or read the dashboard's cached row.
   - Codex: an authenticated OAuth session against `/codex/models` —
     normally only reachable through an imported Codex upstream.
   - Ollama: `curl -s <baseUrl>/api/tags | jq -r '.models[].name' | sort`
     (for ollama.com, base URL is `https://ollama.com`).

   Diff against the existing table's string keys + regex coverage. Note
   new models, retired models, and entries whose family no longer
   appears upstream.

2. **Identify the source of truth for each new entry.** The right anchor
   depends on whether the model's vendor operates its own API:

   - **Vendor first-party API exists** — use the vendor's published rate.
     Examples: DeepSeek's API for `deepseek-v*`, Z.ai for `glm-*`,
     Anthropic for `claude-*` on Copilot, OpenAI for `gpt-*` on Codex
     and Copilot, Mistral for `mistral-large-*` / `devstral-*` /
     `ministral-*` on Ollama.
   - **Open weights with no vendor API** — use the cheapest credible
     commodity host (DeepInfra, Groq, Together, OpenRouter). Examples:
     `gpt-oss:*` (OpenAI released weights but doesn't host them),
     `nemotron-*` (NVIDIA NIM Hub surfaces partner endpoints, no
     first-party token SKU), `rnj-*` (Essential AI publishes weights, no
     API).
   - **Past version whose alias rotated** — DeepSeek's `deepseek-chat`
     alias points at the current generation; older versions like v3.1 /
     v3.2 are no longer reachable on the live page. Use Wayback
     snapshots from the period the version was current.

   For Ollama's many model families, the per-family anchor:

   | Family | Anchor |
   |---|---|
   | `gpt-oss:*` | Groq (cheapest commodity host with cached-input pricing) |
   | `qwen*` | Alibaba International first-party (`qwencloud.com/models/<id>`); fall back to DeepInfra Turbo only when Alibaba doesn't publish a SKU |
   | `deepseek-v*` | DeepSeek first-party (`api-docs.deepseek.com/quick_start/pricing`); for past versions whose `deepseek-chat` alias has rotated, use Wayback snapshots |
   | `glm-*` | Z.ai first-party (`docs.z.ai/guides/overview/pricing`) |
   | `kimi-*` | Kimi first-party (`platform.kimi.ai/docs/pricing/chat`) |
   | `minimax-*` | MiniMax international PAYGo (`platform.minimax.io/docs/guides/pricing-paygo`) |
   | `mistral-large-*` / `devstral-*` / `ministral-*` | Mistral first-party (`mistral.ai/pricing`) |
   | `nemotron-3-*` | DeepInfra (cheapest commodity host) |
   | `gemini-*` | Google AI Studio (`ai.google.dev/gemini-api/docs/pricing`) |
   | `gemma*` | Vertex AI sells per-token only for `gemma-4-26b-a4b-it`; every other Gemma tag is GPU-hour self-host. Leave NULL. |
   | `rnj-*` | Together (Essential AI doesn't run its own API) |

3. **Verify against multiple sources before writing.** Cross-check the
   first-party rate against models.dev's catalog
   (`curl -s https://models.dev/api.json | jq '.<provider>.models["<id>"].cost'`)
   and against OpenRouter's `/api/v1/models`. OpenRouter rates that sit
   *below* first-party are mirror prices — some other host running the
   open weights more cheaply — not the canonical anchor. Use first-party.

4. **Edit the pricing.ts.** Add/update entries with `input`,
   `input_cache_read` (when the upstream publishes one), `input_cache_write`
   (Copilot exposes this on Anthropic models), `output`. Group exact
   string keys; use a regex only when several versions genuinely share a
   single rate.

   Pricing is a **(service tier × input length) grid**, not a stack of
   overlays. The bare dimension keys are the base cell (default service
   tier, base input length). `tiers[wireValue]` adds a service-tier cell
   (`fast`, `priority`, `flex`); `inputLengthTiers` adds input-length
   bands, each keyed by `aboveInputTokens` (the request's total input must
   be STRICTLY greater to select it — e.g. OpenAI's 272k long-context
   rate). When BOTH selectors are non-default the rate comes only from the
   explicit combined cell `inputLengthTiers[i].tiers[wireValue]`; if the
   upstream publishes no such combination, leave it absent — a request
   that lands there is unpriced (NULL unit price) rather than silently
   charged one axis's rate. So a model with a priority lane AND a
   long-context band needs all four cells published to bill the
   priority-long corner. `input_above_tokens` is a **price selector**, not
   a token bucket: the whole request is charged at the selected cell's
   rates, never split into a marginal overage. LiteLLM's
   `_above_272k_tokens` / `_priority` price-key suffixes mirror this — they
   are alternate rate columns, not separate models or token dimensions.

5. **Leave NULL when there's no defensible reference.** Examples:
   - Versions whose name doesn't map to any upstream release.
   - Free-tier-only Labs SKUs with no commercial rate.
   - Open weights with no published per-token host (rare; investigate
     before falling back).
   `pricingForXxxModelKey` returning `null` is correct — it persists
   `usage.unit_price` as NULL, which aggregates to zero cost. Better than
   a guess.

6. **Backfill historical rows** with `backfill-model-pricing` when an
   existing model's rate moved. New rows pick the new price automatically.

## Modelkey shape per provider

- **Copilot**: `usage.model_key` carries variant suffixes (`-high`,
  `-xhigh`, `-1m`, dated snapshots). The lookup helper
  `pricingForCopilotModelKey` strips them via `copilotPublicModelId`
  before matching the table; keep table keys at the public-id level
  (`claude-opus-4-7`, not `claude-opus-4-7-xhigh`).
- **Codex** and **Ollama**: the modelkey IS the raw upstream slug
  verbatim. The table key matches directly.

## Sources to avoid

- **LiteLLM `model_prices_and_context_window.json`** for the `ollama/*`
  namespace — those entries are hardcoded to `0.0` by design. Reading
  from there silently zeros every row.
- **OpenRouter rates that sit below the vendor's first-party** — these
  are mirror prices (some other host running the open weights more
  cheaply), not the canonical anchor.
- **HTML scraping per-model tier labels** (e.g. `Light` / `Medium` /
  `High` / `Extra High` on Ollama's library page) — those are
  subscription GPU-time weights, not token prices, and conflating them
  silently mis-bills.

## Cautions

- Don't fabricate a price by extrapolating from an adjacent version
  (e.g. estimating `glm-4.7` from `glm-4.6`). Leave NULL.
- Don't map by name string when the version reads ambiguous. Versions
  like `qwen3.5` on Ollama and `qwen3-235b-a22b-instruct-2507` on
  DashScope are not necessarily the same release; confirm with a
  release-note pair before linking them.
- Cross-provider spread is large; the choice of anchor changes
  user-visible cost several-fold. Pick deliberately, and write the choice
  into the comment so the next refresh doesn't have to re-derive it.
- Pricing is USD per million tokens, single REAL per `BillingDimension`.
  Falls back per `unitPriceForDimension` (cached → uncached, image →
  text). Don't pre-bake that within-cell fallback into the table. The
  cross-axis (service tier × input length) grid is the exception: those
  cells are explicit — never rely on one axis inheriting the other's rate.
