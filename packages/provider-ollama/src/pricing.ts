// Per-model notional pricing table for the Ollama provider. Ollama bills by
// subscription tier (Free / Pro / Max) on ollama.com and runs at zero
// upstream cost on a self-hosted deployment, neither of which is per-token.
// To keep the dashboard's "value consumed" view meaningful for an operator
// paying the subscription, the gateway tracks usage cost as if the operator
// were paying the model on its own API: the vendor's first-party rate when
// the vendor operates one (DeepSeek, Z.ai, Moonshot, MiniMax, Mistral,
// Alibaba, Google), or the cheapest credible commodity host (DeepInfra,
// Groq, OpenRouter, Together) when the model is open-weights-only (OpenAI
// gpt-oss, NVIDIA Nemotron, Essential AI Rnj-1). Every entry carries explicit
// USD-per-million-token rates for its selector coordinate.
//
// Coverage: every model in https://ollama.com/search that has a published
// per-token price from a credible host. Models without a defensible reference
// (version names that don't map to any upstream release, sub-families with
// no host pricing, free-tier-only Labs SKUs whose pricing is non-commercial)
// are deliberately omitted — `pricingForOllamaModelKey` returns null and
// `usage.unit_price` is left NULL rather than fabricated.
//
// `input_cache_read` entries are intentional but DORMANT today: ollama.com
// internally caches prompt context (per its pricing FAQ, "prompts that share
// cached context use less"), but none of the three API surfaces
// (/v1/chat/completions, /api/chat, /v1/messages) currently exposes a cached-
// token count to clients. Without an upstream signal there is nothing to
// measure a cache-read metric against, so the rate sits unused. Leaving the
// upstream's cache rate in the table keeps it ready for the day Ollama
// surfaces cached_tokens — switching to billed cache reads then becomes a
// pure ingestion-side change.
//
// Refresh procedure: .agents/skills/fetching-models-pricing/.

import { tokenBasePricing, tokenModelPricing, tokenPricingEntry as pricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const OLLAMA_MODEL_PRICING: readonly PricingRule[] = [
  // OpenAI gpt-oss — Groq publishes the cheapest mainstream rates with
  // cached-input support. https://groq.com/pricing
  ['gpt-oss:120b', tokenBasePricing({ input_tokens: '0.15', input_cache_read_tokens: '0.075', output_tokens: '0.6' })],
  ['gpt-oss:20b', tokenBasePricing({ input_tokens: '0.075', input_cache_read_tokens: '0.0375', output_tokens: '0.3' })],

  // Qwen3-Coder 480B — DeepInfra Turbo. DashScope tiers by context window
  // and runs 5×–15× higher; the commodity floor is the defensible anchor.
  // https://deepinfra.com/Qwen/Qwen3-Coder-480B-A35B-Instruct
  ['qwen3-coder:480b', tokenBasePricing({ input_tokens: '0.3', output_tokens: '1.0' })],

  // Qwen3-Coder-Next — Alibaba International first-party SKU
  // (`qwen3-coder-next`). OpenRouter mirrors it ~2.7×/1.9× cheaper because
  // it runs the open weights itself; same first-party-vs-mirror split as
  // DeepSeek V3.x. Anchor to Alibaba.
  // https://www.qwencloud.com/models/qwen3-coder-next
  ['qwen3-coder-next', tokenBasePricing({ input_tokens: '0.3', output_tokens: '1.5' })],

  // Qwen 3.5 397B-a17b — Alibaba International first-party SKU
  // (`qwen3.5-397b-a17b`). Alibaba CN runs ~3.4× cheaper (regional split,
  // not a discount); International USD is the right anchor for non-CN.
  // https://www.qwencloud.com/models/qwen3.5-397b-a17b
  ['qwen3.5:397b', tokenBasePricing({ input_tokens: '0.6', output_tokens: '3.6' })],

  // DeepSeek — DeepSeek operates its own inference cluster, so the first-
  // party rate is the canonical anchor. V3.1 and V3.2 are no longer reachable
  // on api.deepseek.com (the `deepseek-chat` alias has since rotated to V4),
  // so their first-party prices come from Wayback snapshots of
  // https://api-docs.deepseek.com/quick_start/pricing taken while each
  // version was current; OpenRouter / DeepInfra mirror prices for V3.1/V3.2
  // sit BELOW these rates because those hosts run the open weights themselves
  // — they're not DeepSeek's API. For notional billing the Floway dashboard
  // should reflect the operator's "what would I pay on the model's own API"
  // anchor, which is DeepSeek first-party.
  // https://api-docs.deepseek.com/quick_start/pricing
  ['deepseek-v3.1:671b', tokenBasePricing({ input_tokens: '0.56', input_cache_read_tokens: '0.07', output_tokens: '1.68' })],
  ['deepseek-v3.2', tokenBasePricing({ input_tokens: '0.28', input_cache_read_tokens: '0.028', output_tokens: '0.42' })],
  ['deepseek-v4-pro', tokenBasePricing({ input_tokens: '0.435', input_cache_read_tokens: '0.003625', output_tokens: '0.87' })],
  ['deepseek-v4-flash', tokenBasePricing({ input_tokens: '0.14', input_cache_read_tokens: '0.0028', output_tokens: '0.28' })],

  // GLM 4.7 — Z.ai first-party. Priced lower than the 5.x family, so it
  // needs its own entry (don't shortcut by reusing the 5.x rule).
  // https://docs.z.ai/guides/overview/pricing
  ['glm-4.7', tokenBasePricing({ input_tokens: '0.6', input_cache_read_tokens: '0.11', output_tokens: '2.2' })],

  // GLM 5.x — Z.ai first-party. Bare `glm-5` is cheaper than `glm-5.1`
  // and `glm-5.2`, so they need separate rules.
  // https://docs.z.ai/guides/overview/pricing
  ['glm-5', tokenBasePricing({ input_tokens: '1.0', input_cache_read_tokens: '0.2', output_tokens: '3.2' })],
  [/^glm-5\.[12]$/, tokenBasePricing({ input_tokens: '1.4', input_cache_read_tokens: '0.26', output_tokens: '4.4' })],

  // Kimi K2.x — Moonshot international API. K2.5 has a cheaper CN-only rate;
  // the international SKU is the defensible reference across regions.
  // https://platform.kimi.ai/docs/pricing/chat
  ['kimi-k2.5', tokenBasePricing({ input_tokens: '0.55', input_cache_read_tokens: '0.1', output_tokens: '2.9' })],
  ['kimi-k2.6', tokenBasePricing({ input_tokens: '0.95', input_cache_read_tokens: '0.16', output_tokens: '4.0' })],
  ['kimi-k2.7-code', tokenBasePricing({ input_tokens: '0.95', input_cache_read_tokens: '0.19', output_tokens: '4.0' })],

  // MiniMax — international PAYGo. The cache_read rate is $0.03/M for the
  // older trio (m2 / m2.1 / m2.5) and $0.06/M for the newer m2.7 / m3 — the
  // M3 ≤512k row is currently flagged "Permanent 50% off" on MiniMax's page
  // and would otherwise be $0.60/$0.12/$2.40, the same as M3's >512k tier
  // (recorded by the explicit >512k threshold entry below).
  // https://platform.minimax.io/docs/guides/pricing-paygo
  [/^minimax-m2(\.[15])?$/, tokenBasePricing({ input_tokens: '0.3', input_cache_read_tokens: '0.03', output_tokens: '1.2' })],
  ['minimax-m2.7', tokenBasePricing({ input_tokens: '0.3', input_cache_read_tokens: '0.06', output_tokens: '1.2' })],
  ['minimax-m3', tokenModelPricing(
    pricingEntry({ input_tokens: '0.3', input_cache_read_tokens: '0.06', output_tokens: '1.2' }),
    pricingEntry({ input_tokens: '0.6', input_cache_read_tokens: '0.12', output_tokens: '2.4' }, { inputTokens: { operator: 'gt', value: 512000 } }),
  )],

  // Mistral La Plateforme — Mistral Large 3 is the MoE flagship (41B
  // active / 675B total per https://mistral.ai/news/mistral-3); Devstral 2
  // and the Ministral 3 family ship as separate La Plateforme SKUs. Input
  // and output rates all come straight from Mistral's pricing page; the
  // `input_cache_read` rates are not on that page but surface on
  // OpenRouter's `mistralai`-tagged provider row, which routes to Mistral's
  // first-party API for these models.
  // https://mistral.ai/pricing
  // https://openrouter.ai/mistralai/devstral-2512
  // https://openrouter.ai/mistralai/ministral-14b-2512
  ['mistral-large-3:675b', tokenBasePricing({ input_tokens: '0.5', output_tokens: '1.5' })],
  ['devstral-2:123b', tokenBasePricing({ input_tokens: '0.4', input_cache_read_tokens: '0.04', output_tokens: '2.0' })],
  // `devstral-small-2:24b` is intentionally omitted: Mistral's only listed
  // SKU is the free Labs tier (no commercial pricing) and no commodity host
  // carries Devstral Small 2 at a paid rate. Persisting $0 would misrepresent
  // the upstream as zero-cost.
  ['ministral-3:3b', tokenBasePricing({ input_tokens: '0.1', input_cache_read_tokens: '0.01', output_tokens: '0.1' })],
  ['ministral-3:8b', tokenBasePricing({ input_tokens: '0.15', input_cache_read_tokens: '0.015', output_tokens: '0.15' })],
  ['ministral-3:14b', tokenBasePricing({ input_tokens: '0.2', input_cache_read_tokens: '0.02', output_tokens: '0.2' })],

  // NVIDIA Nemotron-3 — open weights, no first-party per-token API. Nano
  // sits on OpenRouter; Super and Ultra run on DeepInfra (Ultra at FP8).
  // https://deepinfra.com/nvidia
  // https://openrouter.ai/nvidia/nemotron-3-nano-30b-a3b
  ['nemotron-3-nano:30b', tokenBasePricing({ input_tokens: '0.05', output_tokens: '0.2' })],
  ['nemotron-3-super', tokenBasePricing({ input_tokens: '0.1', output_tokens: '0.5' })],
  ['nemotron-3-ultra', tokenBasePricing({ input_tokens: '0.5', input_cache_read_tokens: '0.1', output_tokens: '2.2' })],

  // Essential AI Rnj-1 — `essentialai/Rnj-1-Instruct` open weights, served
  // by Together and OpenRouter at a flat rate. The Ollama tag carries the
  // unconventional `rnj-1:8b` slug but maps cleanly to the upstream weights.
  // https://together.ai/models/essentialai/Rnj-1-Instruct
  ['rnj-1:8b', tokenBasePricing({ input_tokens: '0.15', output_tokens: '0.15' })],

  // Gemini 3 Flash (preview) — Google AI Studio.
  // https://ai.google.dev/gemini-api/docs/pricing
  ['gemini-3-flash-preview', tokenBasePricing({ input_tokens: '0.5', input_cache_read_tokens: '0.05', output_tokens: '3.0' })],

  // Gemma 3.x and Gemma 4 31B intentionally have no entries: Vertex AI sells
  // a per-token MaaS SKU only for `gemma-4-26b-a4b-it` ($0.15/$0.60/$0.015),
  // which Ollama Cloud does not carry. Every Gemma tag Ollama does carry runs
  // on Vertex Model Garden as a self-hosted GPU/TPU deployment (priced by
  // accelerator-hour, not tokens), and Ollama's pricing FAQ never quotes a
  // per-token rate for them. Leaving these unpriced rather than fabricating
  // an "AI Studio is free" zero — usage rows resolve to NULL unit_price.
  // https://cloud.google.com/vertex-ai/generative-ai/pricing — Gemma table
];

// Model keys persisted in `usage.model_key` for the Ollama provider are the
// raw upstream slugs from `GET /api/tags` (e.g. `gpt-oss:120b`,
// `deepseek-v4-flash`), with no variant-suffix munging — direct lookup
// against the table.
export const pricingForOllamaModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of OLLAMA_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
