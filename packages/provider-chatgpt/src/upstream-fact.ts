import { assertChatGPTUpstreamRecord, type ChatGPTUpstreamConfig } from './config.ts';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

export type ChatGPTUpstreamFact = ProviderUpstream<'chatgpt', ChatGPTUpstreamConfig>;

export const chatgptUpstreamFact = (record: UpstreamRecord): ChatGPTUpstreamFact => {
  assertChatGPTUpstreamRecord(record);
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    config: { accounts: [{ ...record.config.accounts[0] }] },
  };
};
