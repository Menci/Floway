import { assertClaudeCodeUpstreamRecord, type ClaudeCodeUpstreamRecord } from './config.ts';
import { assertClaudeCodeUpstreamState, type ClaudeCodeUpstreamState } from './state.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export type ValidatedClaudeCodeUpstreamRecord = ClaudeCodeUpstreamRecord & { state: ClaudeCodeUpstreamState };

export const assertClaudeCodeUpstreamCredentials = (
  record: UpstreamRecord,
): asserts record is ValidatedClaudeCodeUpstreamRecord => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);
  const identity = record.config.accounts[0];
  const credential = record.state.accounts[0];
  if (identity.accountUuid !== credential.accountUuid) {
    throw new TypeError(
      `Claude Code account identity ${identity.accountUuid} does not match credential ${credential.accountUuid}`,
    );
  }
};
