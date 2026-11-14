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

test('clears a principal filter, restores input focus and keeps the arrow', () => {
  const { container } = renderInApp(<Picker />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  const clear = screen.getByRole('button', { name: 'Clear user or group filter' });
  expect(clear.tagName).toBe('BUTTON');
  expect(container.querySelector('.fui-Combobox__expandIcon')).toBeTruthy();
  expect(input.value).toBe('Platform');
  expect(container.querySelector('.floway-principal-picker-avatar .floway-group-avatar')).toBeTruthy();
  fireEvent.click(clear);
  expect(input.value).toBe('All visible principals');
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
  expect(input.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('.floway-principal-picker-avatar')).toBeNull();
});

test('uses the same user avatar as principal identities and retains it while searching', () => {
  const { container } = renderInApp(<PrincipalPicker data={data} label="Applies to" onChange={() => {}} value={{ kind: 'user', id: 2 }} />);
  const input = screen.getByRole('combobox', { name: 'Applies to' });
  const avatar = container.querySelector('.floway-principal-picker-avatar .fui-Avatar')!;
  expect(avatar).toBeTruthy();
  expect(avatar.classList.contains('floway-group-avatar')).toBe(false);
  expect(avatar.textContent).toBe('A');
  fireEvent.change(input, { target: { value: 'plat' } });
  expect(container.querySelector('.floway-principal-picker-avatar .fui-Avatar')).toBe(avatar);
});

test('keeps required principal selectors without a clear action', () => {
  renderInApp(<Picker clearable={false} includeAll={false} />);
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
});

test('allows clearing a filter independently of offering all principals', () => {
  renderInApp(<Picker includeAll={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear user or group filter' }));
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' }).value).toBe('');
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
});
