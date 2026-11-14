import type { TokenUsage } from '../../../repo/types.ts';
import { tokenUsageQuantities } from '../../../repo/usage-metrics.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { UsageMeasurement } from '../../shared/telemetry/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';

export type ChatBillableUsage = Omit<BillableUsage, 'input' | 'output'> & { readonly input?: number; readonly output?: number };

export const chatUsageMeasurement = (usage: ChatBillableUsage): UsageMeasurement => {
  const tokens: TokenUsage = {
    ...tokenUsage({ input_cache_read: usage.cacheRead, input_cache_write: usage.cacheWrite, input_cache_write_1h: usage.cacheWrite1h }),
    ...(usage.input === undefined ? {} : { input: usage.input }),
    ...(usage.output === undefined ? {} : { output: usage.output }),
    ...(usage.tier === undefined ? {} : { tier: usage.tier }),
  };
  return {
    quantities: tokenUsageQuantities(tokens),
    pricingFacts: {
      ...(usage.tier === undefined ? {} : { serviceTier: usage.tier }),
      ...(usage.input === undefined ? {} : { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h }),
    },
    dumpTokenUsage: tokens,
  };
};
