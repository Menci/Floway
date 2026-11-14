import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackoffRow } from '../../../src/api/types';
import { ProxyBackoffPanel } from '../../../src/components/proxy/backoff-panel';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { renderInApp } from '../../render';

const backoff = (overrides: Partial<BackoffRow> = {}): BackoffRow => ({
  proxy_id: 'proxy_primary',
  upstream_id: 'up_internal_copilot',
  upstream: {
    id: 'up_internal_copilot',
    name: 'GitHub Copilot Production',
    kind: 'copilot',
    hue: 210,
  },
  fail_count: 1,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  last_error: '[tcp-connect] ss: dial to 130.94.37.137:23718: operation timed out',
  last_error_at: Math.floor(Date.now() / 1000),
  ...overrides,
});

const renderPanel = (row: BackoffRow, onReset = vi.fn()) => renderInApp(
  <OutcomeToastProvider>
    <ProxyBackoffPanel backoffs={[row]} onReset={onReset} proxyId={row.proxy_id} />
  </OutcomeToastProvider>,
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('proxy backoff panel', () => {
  it('renders operator-facing upstream identity and complete diagnostics', () => {
    const row = backoff();
    const view = renderPanel(row);

    expect(screen.getByText('This proxy is in backoff for 1 upstream.')).toBeTruthy();
    expect(screen.getByText(row.upstream.name)).toBeTruthy();
    expect(view.container.textContent).not.toContain(row.upstream_id);
    expect(screen.getByText('1 failure')).toBeTruthy();
    expect(screen.getByText(row.last_error!)).toBeTruthy();
  });

  it('resets one upstream by its internal id without displaying that id', async () => {
    const row = backoff();
    const onReset = vi.fn();
    let requestBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    }));
    renderPanel(row, onReset);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(requestBody).toEqual({ upstream_id: row.upstream_id });
    expect(screen.queryByText(row.upstream_id)).toBeNull();
  });
});
