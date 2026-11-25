import { tokenUsageFromOpenAIImagesBody, tokenUsageMeasurement, type UsageMeasurement } from '../shared/telemetry/usage.ts';

export const measureOpenAIImagesUsage = (body: unknown): UsageMeasurement | null => {
  const usage = tokenUsageFromOpenAIImagesBody(body);
  return usage === null ? null : tokenUsageMeasurement(usage);
};
