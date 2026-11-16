import type { KimiCodeAccount, KimiCodeUpstreamState } from '../src/state.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

interface KimiCodeUsageData {
  [field: string]: unknown;
  usages: Record<string, { used_ratio: number | string; reset_time: string }>;
}

export const RESET = '2026-11-20T00:00:00Z';
export const config = { region: 'china', apiKey: 'sk-kimi-obviously-fake-test-key' } as const;
export const usage = (legacy = false): KimiCodeUsageData => ({
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '75', resetTime: RESET } }],
  usages: legacy
    ? { limit_5h: { used_ratio: 0.25, reset_time: RESET }, limit_7d: { used_ratio: '0.5', reset_time: RESET } }
    : { limit_5h: { used_ratio: 0.25, reset_time: RESET }, limit_month_total: { used_ratio: '0.5', reset_time: RESET }, limit_month_code: { used_ratio: 0.2, reset_time: RESET } },
  ...(legacy ? { usage: { limit: '100', used: '50', remaining: '50', resetTime: RESET }, booster_wallet: { balance: { amount: '10000000000', unit: 'UNIT_CURRENCY' }, monthlyUsed: { currency: 'CNY', priceInCents: '0' } } } : {}),
});
export const profile = { user_id: 'fake-user', nickname: 'Test account', user_level_name: 'Ultra', goods_version: 2 };
export const account: KimiCodeAccount = {
  userId: 'fake-user', globalId: null, nickname: 'Test account',
  status: '', region: '', userLevel: 0, userLevelName: 'Ultra',
  domain: 0, domainName: '', goodsVersion: 2, username: null, email: null, bio: null,
  avatar: null, phone: null, createdTime: null, lastLoginTime: null,
};
export const recentState = (): KimiCodeUpstreamState => ({
  usageProbe: { attemptedAt: Date.now(), observation: { fetchedAt: Date.now(), data: usage() }, error: null },
  accountProbe: { attemptedAt: Date.now(), observation: { fetchedAt: Date.now(), data: account }, error: null },
});
export const record = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_kimi_code', kind: 'kimi-code', name: 'Kimi Code', enabled: true,
  usageRefreshIntervalMinutes: 0, sortOrder: 0, createdAt: '', updatedAt: '',
  config, state: recentState(), flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210, ...overrides,
});
export const rawModel = (overrides: Record<string, unknown> = {}) => ({
  id: 'arbitrary-model', display_name: 'A catalog model', context_length: 1_048_576,
  supports_reasoning: true, supports_image_in: true, supports_video_in: true,
  supports_thinking_type: 'only', think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
  ...overrides,
});

export const speedCatalog = () => [
  rawModel({ id: 'kimi-for-coding', display_name: 'K2.8 Preview' }),
  rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K2.7 Code Highspeed', context_length: 262_144 }),
  rawModel({ id: 'k3', display_name: 'K3' }),
  rawModel({ id: 'k3-256k', display_name: 'K3-256k', context_length: 262_144 }),
  rawModel({ id: 'k3.1-pro', display_name: 'K3.1 Pro' }),
  rawModel({ id: 'k3.1-pro-highspeed', display_name: 'K3.1 Pro Highspeed 2x Usage Cost' }),
];
