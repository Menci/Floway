import type { DumpAccumulator } from './accumulator.ts';
import type { UsageObservation } from '../data-plane/pipeline/compute-usage.ts';
import type { SelectedCandidate } from '../data-plane/pipeline/facts.ts';
import type { TokenUsage } from '../repo/types.ts';
import { decimalStringToNumber } from '@floway-dev/protocols/common';

const tokenMetrics = [
  ['input_tokens', 'input'],
  ['input_cache_read_tokens', 'input_cache_read'],
  ['input_cache_write_tokens', 'input_cache_write'],
  ['output_tokens', 'output'],
] as const;

export const recordSelectedDumpMetadata = async (
  dump: DumpAccumulator,
  candidate: SelectedCandidate,
  usage: Promise<UsageObservation> | undefined,
): Promise<void> => {
  const observation = await usage;
  const tokens: TokenUsage = {};
  if (observation?.kind === 'observed' && 'modelKey' in observation) {
    for (const { quantities } of observation.usage) {
      for (const [metric, key] of tokenMetrics) {
        const quantity = quantities[metric];
        if (quantity !== undefined) tokens[key] = (tokens[key] ?? 0) + decimalStringToNumber(quantity);
      }
    }
  }
  dump.success({ model: candidate.model, upstream: candidate.upstreamId }, tokens);
};
