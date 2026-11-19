import { describe, expect, it, vi } from 'vitest';

import type { ProxyRecord } from '../../../src/api/types';
import { ProxyList } from '../../../src/components/proxy/list';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const record = (id: string, name: string, url: string): ProxyRecord => ({
  id,
  name,
  url,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  dial_timeout_seconds: null,
});

const renderList = (proxies: ProxyRecord[]) => renderInApp(
  <ProxyList disabled={false} onDelete={vi.fn()} onEdit={vi.fn()} proxies={proxies} />,
);

describe('proxy list address column', () => {

  it('says so rather than falling back to a URI no parser accepts', () => {
    const view = renderList([record('two', 'Broken', 'trojan://s3cretpassword@example.com:70000')]);

    expect(view.container.innerHTML).not.toContain('s3cretpassword');
    expect(view.container.textContent).toContain(i18n.t('dashboard.proxy.unknownAddress'));
  });
});
