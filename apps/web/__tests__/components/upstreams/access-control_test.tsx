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

const Control = ({ initialIds, initialOverride = true }: { initialIds: string[]; initialOverride?: boolean }) => {
  const [value, setValue] = useState({ override: initialOverride, ids: initialIds });
  return <UpstreamAccessControl available={available} disabled={false} ids={value.ids} models={[]} onChange={setValue} override={value.override} />;
};

const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
};

describe('upstream access selection', () => {
  it('only lets the upstream list expand while the limit is on', async () => {
    renderInApp(<Control initialIds={[]} initialOverride={false} />);
    const disclosure = screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') });

    expect((disclosure as HTMLButtonElement).disabled).toBe(true);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    await click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    await click(screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') }));
    expect((disclosure as HTMLButtonElement).disabled).toBe(false);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
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

  it('keeps a saved cap visible and removable when it is no longer selectable', async () => {
    const { rerender } = renderInApp(<Control initialIds={['up_gone']} />);
    await click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }));
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled: up_gone' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await click(checkbox);
    expect(screen.queryByRole('checkbox', { name: 'Enabled: up_gone' })).toBeNull();
    expect(screen.getByText(i18n.t('dashboard.upstreamAccess.emptyWarning'))).toBeTruthy();
    rerender(<Control initialIds={['up_a']} />);
  });
});
