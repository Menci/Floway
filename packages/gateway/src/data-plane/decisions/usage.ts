import type { TokenUsage } from '../../repo/types.ts';
import { tokenUsage } from '../shared/telemetry/usage.ts';
import { parseSystemOneUsage } from '@floway-dev/protocols/decisions';

export const tokenUsageFromSystemOneBody = (body: unknown): TokenUsage | null => {
  const usage = parseSystemOneUsage(body);
  return usage === null ? null : tokenUsage({ input: usage.inputTokens, output: usage.outputTokens });
};
