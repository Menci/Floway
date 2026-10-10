import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OllamaUsageCard } from '../../../src/components/upstream-editor/ollama-usage-card';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { creditBalance, legacyBalance, usageTotals, pairedUsage } from '../upstreams/ollama-usage-fixture';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ollama: { usage: { $post: mocks.refresh } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

test('successful manual balance refresh clears a persisted failure while displaying the new balance', async () => {
  const record = upstreamRecord('ollama', {
    kind: 'ollama', config: { baseUrl: 'https://ollama.com', cloudUsage: true, models: [], apiKeySet: true },
    state: {
      account: null, usageProbe: {
        attemptedAt: 1000, observation: { fetchedAt: 900, data: pairedUsage }, error: 'stored balance error',
      },
    },
  }) as Extract<UpstreamRecord, { kind: 'ollama' }>;
  mocks.refresh.mockResolvedValue({
    data: {
      observation: { fetchedAt: 2000, data: { usage: usageTotals, balance: { ...creditBalance, included: { ...creditBalance.included, balance_usd: 12.5 } } } },
      account: null,
    }, error: null,
  });
  renderInApp(<OllamaUsageCard record={record} probeRecord={{ ...record }} />);
  expect(screen.getByText(/stored balance error/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.ollama.usage.refresh') }));
  expect(await screen.findByText(/12\.5/)).toBeTruthy();
  expect(screen.queryByText(/stored balance error/)).toBeNull();
});

test.each(['credits', 'legacy'] as const)('the same Pro tier renders its %s billing controls from balance fields', kind => {
  const record = upstreamRecord('ollama', {
    kind: 'ollama', config: { baseUrl: 'https://ollama.com', cloudUsage: true, models: [], apiKeySet: true }, state: {
      account: { plan: 'pro', name: 'Demo', email: null, fetchedAt: 1000 },
      usageProbe: {
        attemptedAt: 1000, error: null, observation: {
          fetchedAt: 1000, data: {
            balance: kind === 'credits' ? creditBalance : legacyBalance,
            usage: kind === 'credits' ? usageTotals : { ...usageTotals, totals: { request_count: 15 } },
          },
        },
      },
    },
  }) as Extract<UpstreamRecord, { kind: 'ollama' }>;
  renderInApp(<OllamaUsageCard record={record} probeRecord={{ ...record }} />);
  expect(screen.getByText(i18n.t(`dashboard.upstreamEditor.ollama.usage.billing.${kind}`))).toBeTruthy();
  if (kind === 'credits') {
    expect(screen.getByText('$18.00')).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.ollama.usage.window.session'))).toBeNull();
  } else {
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.ollama.usage.window.session'))).toBeTruthy();
    expect(screen.queryByText('$3.25')).toBeNull();
  }
  expect(screen.getByText('$25.00')).toBeTruthy();
});
