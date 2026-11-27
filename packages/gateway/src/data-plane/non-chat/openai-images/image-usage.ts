import { requestOnlyUsageMeasurement, tokenUsageFromOpenAIImagesBody, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import type { OpenAIImagesStreamItem } from '@floway-dev/protocols/openai-images';

const imageUsage = (value: unknown) => {
  const observed = tokenUsageFromOpenAIImagesBody(value);
  return observed === null ? undefined : [tokenUsageMeasurement(observed)];
};

export const imageUsageReaders = {
  result: (value: unknown) => imageUsage(value) ?? [requestOnlyUsageMeasurement()],
  stream: () => ({
    frame: ({ data }: OpenAIImagesStreamItem) => imageUsage(data),
    done: () => [requestOnlyUsageMeasurement()],
  }),
};
