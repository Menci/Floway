import { tokenBasePricing, type ModelPricing, type PriceVector } from '@floway-dev/protocols/common';

type PricingRule = readonly [keys: readonly string[], rates: PriceVector];

// Request valuation uses Ollama's published standard rates, including cache
// reads. Actual account consumption comes from /api/usage: off-peak discounts
// and billing boundaries can make it differ from a standard-rate estimate.
// https://ollama.com/pricing
const STANDARD_PRICING: readonly PricingRule[] = [
  // Cloud aliases are published under each family's tags page.
  // https://ollama.com/library/deepseek-v4.1-flash/tags
  [['deepseek-v4.1-flash', 'deepseek-v4.1-flash:cloud'], { input_tokens: '0.30', input_cache_read_tokens: '0.006', output_tokens: '1.20' }],
  // https://ollama.com/library/deepseek-v4-pro/tags
  [['deepseek-v4-pro', 'deepseek-v4-pro:0813', 'deepseek-v4-pro:cloud', 'deepseek-v4-pro:0813-cloud'], { input_tokens: '1.32', input_cache_read_tokens: '0.044', output_tokens: '3.96' }],
  // https://ollama.com/library/gemma4/tags
  [['gemma4', 'gemma4:31b', 'gemma4:cloud', 'gemma4:31b-cloud'], { input_tokens: '0.14', input_cache_read_tokens: '0.05', output_tokens: '0.40' }],
  // https://ollama.com/library/glm-5.2/tags
  [['glm-5.2', 'glm-5.2:cloud'], { input_tokens: '1.40', input_cache_read_tokens: '0.26', output_tokens: '4.40' }],
  // https://ollama.com/library/glm-5.3/tags
  [['glm-5.3', 'glm-5.3:cloud'], { input_tokens: '1.40', input_cache_read_tokens: '0.26', output_tokens: '4.40' }],
  // https://ollama.com/library/glm-5.3-flash/tags
  [['glm-5.3-flash', 'glm-5.3-flash:cloud'], { input_tokens: '0.15', input_cache_read_tokens: '0.03', output_tokens: '0.50' }],
  // https://ollama.com/library/gpt-oss/tags
  [['gpt-oss:120b', 'gpt-oss:120b-cloud'], { input_tokens: '0.15', input_cache_read_tokens: '0.014', output_tokens: '0.60' }],
  [['gpt-oss:20b', 'gpt-oss:20b-cloud'], { input_tokens: '0.07', input_cache_read_tokens: '0.035', output_tokens: '0.30' }],
  // https://ollama.com/library/kimi-k3/tags
  [['kimi-k3', 'kimi-k3:cloud'], { input_tokens: '3.00', input_cache_read_tokens: '0.30', output_tokens: '15.00' }],
  // https://ollama.com/library/kimi-k2.7-code/tags
  [['kimi-k2.7-code', 'kimi-k2.7-code:cloud'], { input_tokens: '0.95', input_cache_read_tokens: '0.19', output_tokens: '4.00' }],
  // https://ollama.com/library/kimi-k2.6/tags
  [['kimi-k2.6', 'kimi-k2.6:cloud'], { input_tokens: '0.95', input_cache_read_tokens: '0.16', output_tokens: '4.00' }],
  // https://ollama.com/library/minimax-m3/tags
  [['minimax-m3', 'minimax-m3:cloud'], { input_tokens: '0.60', input_cache_read_tokens: '0.12', output_tokens: '2.40' }],
  // https://ollama.com/library/minimax-m2.7/tags
  [['minimax-m2.7', 'minimax-m2.7:cloud'], { input_tokens: '0.30', input_cache_read_tokens: '0.06', output_tokens: '1.20' }],
  // https://ollama.com/library/mistral-large-4/tags
  [['mistral-large-4', 'mistral-large-4:cloud'], { input_tokens: '0.68', input_cache_read_tokens: '0.07', output_tokens: '2.09' }],
  // https://ollama.com/library/mistral-large-3/tags
  [['mistral-large-3', 'mistral-large-3:675b', 'mistral-large-3:675b-cloud'], { input_tokens: '0.50', output_tokens: '1.50' }],
  // https://ollama.com/library/nemotron-3-nano/tags
  [['nemotron-3-nano:30b', 'nemotron-3-nano:30b-cloud'], { input_tokens: '0.06', output_tokens: '0.24' }],
  // https://ollama.com/library/nemotron-3-super/tags
  [['nemotron-3-super', 'nemotron-3-super:cloud'], { input_tokens: '0.015', input_cache_read_tokens: '0.015', output_tokens: '0.60' }],
  // https://ollama.com/library/nemotron-3-ultra/tags
  [['nemotron-3-ultra', 'nemotron-3-ultra:cloud'], { input_tokens: '0.10', input_cache_read_tokens: '0.10', output_tokens: '3.00' }],
];

// Models with no published Ollama rate retain their existing API-equivalent
// valuation, including models served locally. Unknown models remain unpriced.
const NOTIONAL_PRICING: readonly PricingRule[] = [
  // https://deepinfra.com/Qwen/Qwen3-Coder-480B-A35B-Instruct
  [['qwen3-coder:480b'], { input_tokens: '0.3', output_tokens: '1.0' }],
  // https://www.qwencloud.com/models/qwen3-coder-next
  [['qwen3-coder-next'], { input_tokens: '0.3', output_tokens: '1.5' }],
  // https://www.qwencloud.com/models/qwen3.5-397b-a17b
  [['qwen3.5:397b'], { input_tokens: '0.6', output_tokens: '3.6' }],
  // Historical first-party rates for retired DeepSeek releases.
  // https://api-docs.deepseek.com/quick_start/pricing
  [['deepseek-v3.1:671b'], { input_tokens: '0.56', input_cache_read_tokens: '0.07', output_tokens: '1.68' }],
  [['deepseek-v3.2'], { input_tokens: '0.28', input_cache_read_tokens: '0.028', output_tokens: '0.42' }],
  [['deepseek-v4-flash', 'deepseek-v4-flash:0731'], { input_tokens: '0.14', input_cache_read_tokens: '0.0028', output_tokens: '0.28' }],
  // https://docs.z.ai/guides/overview/pricing
  [['glm-4.7'], { input_tokens: '0.6', input_cache_read_tokens: '0.11', output_tokens: '2.2' }],
  [['glm-5'], { input_tokens: '1.0', input_cache_read_tokens: '0.2', output_tokens: '3.2' }],
  [['glm-5.1'], { input_tokens: '1.4', input_cache_read_tokens: '0.26', output_tokens: '4.4' }],
  // https://platform.kimi.ai/docs/pricing/chat
  [['kimi-k2.5'], { input_tokens: '0.55', input_cache_read_tokens: '0.1', output_tokens: '2.9' }],
  // https://platform.minimax.io/docs/guides/pricing-paygo
  [['minimax-m2', 'minimax-m2.1', 'minimax-m2.5'], { input_tokens: '0.3', input_cache_read_tokens: '0.03', output_tokens: '1.2' }],
  // https://mistral.ai/pricing
  // https://openrouter.ai/mistralai/devstral-2512
  [['devstral-2:123b'], { input_tokens: '0.4', input_cache_read_tokens: '0.04', output_tokens: '2.0' }],
  // https://openrouter.ai/mistralai/ministral-14b-2512
  [['ministral-3:3b'], { input_tokens: '0.1', input_cache_read_tokens: '0.01', output_tokens: '0.1' }],
  [['ministral-3:8b'], { input_tokens: '0.15', input_cache_read_tokens: '0.015', output_tokens: '0.15' }],
  [['ministral-3:14b'], { input_tokens: '0.2', input_cache_read_tokens: '0.02', output_tokens: '0.2' }],
  // https://together.ai/models/essentialai/Rnj-1-Instruct
  [['rnj-1:8b'], { input_tokens: '0.15', output_tokens: '0.15' }],
  // https://ai.google.dev/gemini-api/docs/pricing
  [['gemini-3-flash-preview'], { input_tokens: '0.5', input_cache_read_tokens: '0.05', output_tokens: '3.0' }],
];

const PRICING_BY_MODEL = new Map<string, ModelPricing>([...STANDARD_PRICING, ...NOTIONAL_PRICING].flatMap(([keys, rates]) => {
  const pricing = tokenBasePricing(rates);
  return keys.map(key => [key, pricing] as const);
}));

export const pricingForOllamaModelKey = (modelKey: string): ModelPricing | null => PRICING_BY_MODEL.get(modelKey) ?? null;
