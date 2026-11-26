import { computeUsage } from '../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsageFromOpenAIImagesBody, tokenUsageMeasurement } from '../shared/telemetry/usage.ts';

const imageUsage = (value: unknown) => {
  const usage = tokenUsageFromOpenAIImagesBody(value);
  return usage === null ? undefined : [tokenUsageMeasurement(usage)];
};

const readers = {
  result: (value: unknown) => imageUsage(value) ?? [requestOnlyUsageMeasurement()],
  stream: () => ({ frame: imageUsage, done: () => [requestOnlyUsageMeasurement()] }),
};

export const computeOpenAIImagesGenerationsUsage = computeUsage('openaiImagesGenerations', readers);
export const computeOpenAIImagesEditsUsage = computeUsage('openaiImagesEdits', readers);
