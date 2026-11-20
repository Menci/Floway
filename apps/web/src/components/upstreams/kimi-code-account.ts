import { shortAccountId } from './account-id';
import type { UpstreamRecord } from '../../api/types';
import type { KimiCodeAccount, KimiCodeAccountUsage } from '@floway-dev/provider-kimi-code/browser';

export type KimiCodeRecord = Extract<UpstreamRecord, { kind: 'kimi-code' }>;

export const kimiCodeAccount = (record: KimiCodeRecord): KimiCodeAccount | null =>
  record.state?.accountProbe?.observation?.data ?? null;

export const kimiCodeAccountName = (account: KimiCodeAccount): string =>
  account.nickname || shortAccountId(account.userId);

export const kimiCodePlanLabel = (record: KimiCodeRecord): string | null => {
  const account = kimiCodeAccount(record);
  return account === null || account.userLevelName === '' ? null : `Kimi ${account.userLevelName}`;
};

export const readKimiCodeWindows = (usage: KimiCodeAccountUsage) =>
  usage.windows.map(window => ({ ...window, percent: window.usedRatio * 100 }));
