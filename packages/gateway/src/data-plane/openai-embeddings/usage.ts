import { tokenUsageMeasurement, type UsageMeasurement } from '../shared/telemetry/usage.ts';
import { isJsonObject, isRawNumber, type JsonObject } from '@floway-dev/protocols/common';

export const measureOpenAIEmbeddingsUsage = ({ usage }: JsonObject): UsageMeasurement | null => {
  if (!isJsonObject(usage)) return null;
  const reported = usage.prompt_tokens;
  const tokens = isRawNumber(reported) ? Number((reported as { rawJSON: string }).rawJSON) : reported;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokenUsageMeasurement({ input: tokens }) : null;
};
