import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OllamaUsageCard } from '../../../src/components/upstream-editor/ollama-usage-card';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ollama: { usage: { $post: mocks.refresh } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

test('successful manual balance refresh clears a persisted failure while displaying the new balance', async () => {
  const record = upstreamRecord('ollama', {
    kind: 'ollama', config: { baseUrl: 'https://ollama.com', cloudUsage: true, models: [], apiKeySet: true },
    state: {
      account: null, usageProbe: null, balanceProbe: {
        attemptedAt: 1000, observation: { fetchedAt: 900, data: { included: { balance_usd: 40 } } }, error: 'stored balance error',
      },
    },
  }) as Extract<UpstreamRecord, { kind: 'ollama' }>;
  mocks.refresh.mockResolvedValue({
    data: {
      observation: { fetchedAt: 2000, data: { totals: {} } },
      balanceObservation: { fetchedAt: 2000, data: { included: { balance_usd: 12.5 }, purchased: { balance_usd: 0 } } },
      account: null,
    }, error: null,
  });
  renderInApp(<OllamaUsageCard record={record} probeRecord={{ ...record }} />);
  expect(screen.getByText(/stored balance error/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.ollama.usage.refresh') }));
  expect(await screen.findByText(/12\.5/)).toBeTruthy();
  expect(screen.queryByText(/stored balance error/)).toBeNull();
});
