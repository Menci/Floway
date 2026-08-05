import { assertCodexUpstreamRecord, type CodexUpstreamRecord } from './config.ts';
import { assertCodexUpstreamState, type CodexUpstreamState } from './state.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export type ValidatedCodexUpstreamRecord = CodexUpstreamRecord & { state: CodexUpstreamState };

export function assertCodexUpstreamCredentials(
  record: UpstreamRecord,
): asserts record is ValidatedCodexUpstreamRecord {
  assertCodexUpstreamRecord(record);
  assertCodexUpstreamState(record.state);
  const identity = record.config.accounts[0];
  const credential = record.state.accounts[0];
  if (identity.chatgptAccountId !== credential.chatgptAccountId) {
    throw new TypeError(
      `Codex account identity ${identity.chatgptAccountId} does not match credential ${credential.chatgptAccountId}`,
    );
  }
}
