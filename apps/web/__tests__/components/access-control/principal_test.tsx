import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { PrincipalPicker } from '../../../src/components/access-control/principal';
import type { ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { renderInApp } from '../../render';
import type { AccessPrincipal } from '@floway-dev/gateway/browser';

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [1] }],
  groups: [{ id: 1, name: 'Platform', hue: 210, createdAt: '', deletedAt: null, memberIds: [2] }],
  upstreams: [], models: [],
};

function Picker() {
  const [value, setValue] = useState<AccessPrincipal | null>({ kind: 'group', id: 1 });
  return <PrincipalPicker clearable data={data} includeAll label="Applies to" onChange={setValue} value={value} />;
}

test('clears a principal filter and restores input focus', () => {
  renderInApp(<Picker />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  const clear = screen.getByRole('button', { name: 'Clear user or group filter' });
  expect(input.value).toBe('Platform');
  fireEvent.click(clear);
  expect(input.value).toBe('All visible principals');
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
  expect(input.getAttribute('aria-expanded')).toBe('false');
});
