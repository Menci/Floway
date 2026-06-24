import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { BILLING_DIMENSIONS, type BillingDimension } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const hasTokenUsage = (usage: TokenUsage): boolean => BILLING_DIMENSIONS.some(dimension => (usage[dimension] ?? 0) > 0);

// Map an upstream-reported service tier onto the tier marker the gateway
// stores on the usage row. `default` (OpenAI's response-side base value) and
// `standard` (Anthropic's response-side base value) both denote base pricing
// and collapse to null so they aggregate with rows that carry no tier at all.
// Compared case-insensitively in case a future upstream stamps `'Default'`
// or `'STANDARD'` (defensive — both protocols' SDKs ship the values in
// lowercase today); non-base values pass through with their original
// casing so per-tier overrides match the wire-stamped string verbatim.
// https://developers.openai.com/api/docs/guides/priority-processing
// https://docs.claude.com/en/api/service-tiers
// https://docs.claude.com/en/build-with-claude/fast-mode
export const billableServiceTier = (tier: string | null | undefined): string | null => {
  if (tier == null) return null;
  const normalized = tier.toLowerCase();
  return normalized === 'default' || normalized === 'standard' ? null : tier;
};

// Drop zero / undefined dimensions so a usage map only carries the dimensions
// actually billed. `tier` (a non-numeric service-tier marker) survives the
// filter so per-tier pricing overrides resolve at recording time.
export const tokenUsage = (counts: TokenUsage): TokenUsage => {
  const out: TokenUsage = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const value = counts[dimension] ?? 0;
    if (value > 0) out[dimension] = value;
  }
  if (counts.tier != null) out.tier = counts.tier;
  return out;
};

export const tokenUsageFromEmbeddingsBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage } = body as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof promptTokens === 'number' ? tokenUsage({ input: promptTokens }) : null;
};

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`,
// where the details objects split each total into `text_tokens` and
// `image_tokens`. We map that split onto the billing dimensions: bare
// input/output for the text modality, input_image/output_image for the image
// modality. The details splits are disjoint and sum to their respective total.
//
// When a details object is missing but its total is present, the whole total is
// charged on the bare dimension rather than inventing a split. A present field
// that is a non-number is treated as a malformed upstream payload (return
// null) rather than silently coerced.
export const tokenUsageFromImagesBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage } = body as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const { input_tokens: inputTotal, output_tokens: outputTotal, input_tokens_details: inputDetails, output_tokens_details: outputDetails } = usage as ImagesUsageShape;

  if (inputTotal !== undefined && typeof inputTotal !== 'number') return null;
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return null;
  if (inputTotal === undefined && outputTotal === undefined) return null;

  const input = splitModalityCounts('input', 'input_image', inputTotal, inputDetails);
  if (input === null) return null;
  const output = splitModalityCounts('output', 'output_image', outputTotal, outputDetails);
  if (output === null) return null;

  return tokenUsage({ ...input, ...output });
};

interface ImagesUsageShape {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: unknown;
  output_tokens_details?: unknown;
}

const splitModalityCounts = (
  textDimension: BillingDimension,
  imageDimension: BillingDimension,
  total: number | undefined,
  details: unknown,
): TokenUsage | null => {
  if (total === undefined) return {};
  if (details === undefined) return { [textDimension]: total };
  if (!details || typeof details !== 'object') return null;
  const { text_tokens: text, image_tokens: image } = details as { text_tokens?: unknown; image_tokens?: unknown };
  if (text !== undefined && typeof text !== 'number') return null;
  if (image !== undefined && typeof image !== 'number') return null;
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textDimension]: total };
  return { [textDimension]: text ?? 0, [imageDimension]: image ?? 0 };
};

export const recordTokenUsage = async (keyId: string, modelIdentity: TelemetryModelIdentity, usage: TokenUsage): Promise<void> => {
  const { tier, ...tokens } = usage;
  await Promise.all([
    getRepo().usage.record({
      keyId,
      model: modelIdentity.model,
      upstream: modelIdentity.upstream,
      modelKey: modelIdentity.modelKey,
      hour: currentHour(),
      tier: tier ?? null,
      requests: 1,
      tokens,
      cost: modelIdentity.cost,
    }),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};
