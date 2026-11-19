import { fireEvent, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { RulePermissions } from '../../../src/components/access-control/permission-list';
import type { ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { renderInApp } from '../../render';
import type { AccessRecord } from '@floway-dev/gateway/browser';

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [1] }],
  groups: [{ id: 1, name: 'Platform', hue: 210, memberIds: [2], createdAt: '', deletedAt: null }],
  upstreams: [], models: [],
};
const source: AccessRecord = { id: 1, principal: { kind: 'group', id: 1 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Upstream.Edit': 'models' }, createdAt: '', updatedAt: '' };
const winner: AccessRecord = { ...source, id: 2, principal: { kind: 'user', id: 2 }, values: { 'Upstream.Edit': 'full' } };

test.each([false, true])('explains which rule overrides a permission, naming its scope only when it differs: %s', async otherScope => {
  const by: AccessRecord = { ...winner, ...(otherScope ? { scope: { kind: 'user', userId: 2 } as const } : {}) };
  const { container } = renderInApp(<RulePermissions context={{ record: source, data, decisions: { 'Upstream.Edit': { kind: 'overridden', by } } }} values={source.values} />);
  fireEvent.focus(container.querySelector('[data-overridden-by]')!);
  const tooltip = await screen.findByRole('tooltip');
  expect(tooltip.querySelector('[data-override-explanation]')).toBeTruthy();
  expect(tooltip.querySelector('[data-override-location]') !== null).toBe(otherScope);
  expect(tooltip.textContent).toContain('alice');
});
