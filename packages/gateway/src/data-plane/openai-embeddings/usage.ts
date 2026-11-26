import { computeUsage } from '../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsageMeasurement } from '../shared/telemetry/usage.ts';

export const computeOpenAIEmbeddingsUsage = computeUsage('openaiEmbeddings', {
  result({ usage }) {
    const promptTokens = typeof usage === 'object' && usage !== null
      ? (usage as { prompt_tokens?: unknown }).prompt_tokens
      : undefined;
    return [typeof promptTokens === 'number' ? tokenUsageMeasurement({ input: promptTokens }) : requestOnlyUsageMeasurement()];
  },
});
