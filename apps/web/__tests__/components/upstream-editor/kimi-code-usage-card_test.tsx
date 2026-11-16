import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { KimiCodeUsageCard } from '../../../src/components/upstream-editor/kimi-code-usage-card';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';
import { currentUsage, kimiCodeRecord, legacyUsage } from '../upstreams/kimi-code-fixture';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { 'kimi-code': { usage: { $post: mocks.refresh } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

beforeEach(() => {
  primeDefaultSession();
  mocks.refresh.mockReset();
});

test.each([
  ['current', currentUsage, 'monthly'],
  ['legacy', legacyUsage, 'weekly'],
] as const)('renders %s subscription windows without treating the Code breakdown as a quota', (_generation, usage, longWindow) => {
  const record = kimiCodeRecord(usage);
  renderInApp(<KimiCodeUsageCard record={record} probeRecord={{ ...record }} />);
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.kimiCode.usage.window.five_hour'))).toBeTruthy();
  expect(screen.getByText(i18n.t(`dashboard.upstreamEditor.kimiCode.usage.window.${longWindow}`))).toBeTruthy();
  expect(screen.queryAllByText(i18n.t('dashboard.upstreamEditor.kimiCode.usage.monthlyCodeShare', { percent: 40 })))
    .toHaveLength(longWindow === 'monthly' ? 1 : 0);
  expect(document.body.textContent).not.toContain('$');
  expect(document.body.textContent).not.toContain('USD');
  expect(document.body.textContent).not.toContain('limit_');
});

test('a successful quota refresh remains successful when account details are unavailable', async () => {
  const record = kimiCodeRecord();
  record.state!.usageProbe!.error = 'old quota failure';
  record.state!.accountProbe = {
    attemptedAt: 1000, error: null,
    observation: { fetchedAt: 1000, data: { userId: 'fake-user', globalId: null, nickname: 'Old name', status: '', region: '', userLevel: 0, userLevelName: 'Pro', domain: 0, domainName: '', goodsVersion: null, username: null, email: null, bio: null, avatar: null, phone: null, createdTime: null, lastLoginTime: null } },
  };
  mocks.refresh.mockResolvedValue({
    data: {
      observation: { fetchedAt: 2000, data: legacyUsage },
      account: null, accountError: 'account details unavailable',
    }, error: null,
  });
  renderInApp(<KimiCodeUsageCard record={record} probeRecord={{ ...record }} />);
  expect(screen.getByText('Old name')).toBeTruthy();
  expect(screen.getByText(/old quota failure/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.kimiCode.usage.refresh') }));
  expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.kimiCode.usage.window.weekly'))).toBeTruthy();
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.getByText('Old name')).toBeTruthy();
  expect(screen.queryByText(/old quota failure/)).toBeNull();
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.kimiCode.usage.accountFailed', { message: 'account details unavailable' }))).toBeTruthy();
});

test.each(['HTTP 429: subscription quota exhausted', 'HTTP 403: subscription access restricted'])('preserves the upstream failure: %s', async message => {
  const record = kimiCodeRecord(null);
  mocks.refresh.mockResolvedValue({ data: null, error: { status: 502, message } });
  renderInApp(<KimiCodeUsageCard record={record} probeRecord={{ ...record }} />);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.kimiCode.usage.load') }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
});

test('read-only quota retains identity fallback and hides refresh actions', () => {
  const record = kimiCodeRecord();
  record.state!.accountProbe = {
    attemptedAt: 1000, error: null,
    observation: { fetchedAt: 1000, data: { userId: 'fake-user', globalId: null, nickname: '', status: '', region: '', userLevel: 0, userLevelName: 'Ultra', domain: 0, domainName: '', goodsVersion: null, username: null, email: null, bio: null, avatar: null, phone: null, createdTime: null, lastLoginTime: null } },
  };
  renderInApp(<KimiCodeUsageCard readOnly record={record} probeRecord={{ ...record }} />);
  expect(screen.getByText('fake-user')).toBeTruthy();
  expect(screen.getByText('Ultra')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
