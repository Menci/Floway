import { fireEvent, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

test('Codex device normalization defaults off and can be toggled in the upstream editor', () => {
  const record = upstreamRecord('codex', {
    kind: 'codex', config: { accounts: [] }, state: { accounts: [] },
  });
  renderInApp(<ProviderConfigHarness record={record} />);
  const toggle = screen.getByRole('switch', { name: 'Normalize device identity' }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
});
