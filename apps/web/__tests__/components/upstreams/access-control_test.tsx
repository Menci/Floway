import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import type { UpstreamOption } from '../../../src/api/types';
import { UpstreamAccessControl } from '../../../src/components/upstreams/access-control';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const available: UpstreamOption[] = [
  { id: 'up_a', name: 'Alpha', kind: 'custom', enabled: true, hue: 210, cachedModelCount: 1 },
];

const Control = ({ initialIds }: { initialIds: string[] }) => {
  const [value, setValue] = useState({ override: true, ids: initialIds });
  return <UpstreamAccessControl available={available} disabled={false} ids={value.ids} models={[]} onChange={setValue} override={value.override} />;
};

const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
};

describe('upstream access selection', () => {
  it('warns immediately for a saved empty selection even while the list is collapsed', async () => {
    renderInApp(<Control initialIds={[]} />);
    const warning = i18n.t('dashboard.upstreamAccess.emptyWarning');
    expect(screen.getByText(warning).closest('.fui-MessageBar')).not.toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }).getAttribute('aria-expanded')).toBe('false');

    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    await click(toggle);
    expect(screen.queryByText(warning)).toBeNull();
    await click(toggle);
    expect(screen.getByText(warning)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement).checked).toBe(false);
  });

  it('allows deselecting the last upstream and preserves selections across the limit switch', async () => {
    renderInApp(<Control initialIds={['up_a']} />);
    await click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }));
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement;
    const warning = i18n.t('dashboard.upstreamAccess.emptyWarning');
    expect(screen.queryByText(warning)).toBeNull();
    await click(checkbox);
    expect(screen.getByText(warning)).toBeTruthy();
    await click(checkbox);
    expect(screen.queryByText(warning)).toBeNull();
    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    await click(toggle);
    await click(toggle);
    expect((screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement).checked).toBe(true);
  });
});
