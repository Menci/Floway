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

function Picker({ clearable = true, includeAll = true }: { clearable?: boolean; includeAll?: boolean }) {
  const [value, setValue] = useState<AccessPrincipal | null>({ kind: 'group', id: 1 });
  return <PrincipalPicker clearable={clearable} data={data} includeAll={includeAll} label="Applies to" onChange={setValue} value={value} />;
}

test('clears a principal filter and restores input focus', () => {
  const { container } = renderInApp(<Picker />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  const clear = screen.getByRole('button', { name: 'Clear user or group filter' });
  expect(input.value).toBe('Platform');
  expect(container.querySelector('.floway-principal-picker-avatar .floway-group-avatar')).toBeTruthy();
  fireEvent.click(clear);
  expect(input.value).toBe('All visible principals');
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
  expect(input.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('.floway-principal-picker-avatar')).toBeNull();
});

test('allows clearing a filter independently of offering all principals', () => {
  renderInApp(<Picker includeAll={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear user or group filter' }));
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' }).value).toBe('');
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
});
