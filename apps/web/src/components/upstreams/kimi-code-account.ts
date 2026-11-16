import { shortAccountId } from './account-id';
import type { UpstreamRecord } from '../../api/types';
import type { KimiCodeAccount, KimiCodeAccountUsage, KimiCodeQuotaWindow } from '@floway-dev/provider-kimi-code/browser';

export type KimiCodeRecord = Extract<UpstreamRecord, { kind: 'kimi-code' }>;

export const kimiCodeAccount = (record: KimiCodeRecord): KimiCodeAccount | null =>
  record.state?.accountProbe?.observation?.data ?? null;

export const kimiCodeAccountName = (account: KimiCodeAccount): string =>
  account.nickname || shortAccountId(account.userId);

export const kimiCodePlanLabel = (record: KimiCodeRecord): string | null => {
  const account = kimiCodeAccount(record);
  return account === null || account.planName === '' ? null : account.planName;
};

const WINDOW_ORDER: Record<KimiCodeQuotaWindow['id'], number> = { five_hour: 0, monthly: 1, weekly: 2 };

export const readKimiCodeWindows = (usage: KimiCodeAccountUsage) =>
  usage.windows.toSorted((left, right) => WINDOW_ORDER[left.id] - WINDOW_ORDER[right.id])
    .map(window => ({ ...window, percent: window.usedRatio * 100 }));
