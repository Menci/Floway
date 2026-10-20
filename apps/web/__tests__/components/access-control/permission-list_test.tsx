import { fireEvent, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { RulePermissions } from '../../../src/components/access-control/permission-list';
import type { ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { permissionTone } from '../../../src/components/access-control/values';
import { renderInApp } from '../../render';
import type { AccessRecord, AccessValues } from '@floway-dev/gateway/browser';

const mixed: AccessValues = { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' };

test('keeps each permission inside one complete borderless token', () => {
  const { container } = renderInApp(<RulePermissions values={mixed} />);
  const items = screen.getAllByRole('listitem');
  expect(items.map(node => node.textContent)).toEqual(['Use models On', 'Audit upstream Off', 'Edit upstream (Models only)']);
  expect(container.querySelectorAll('[data-permission-token]')).toHaveLength(3);
  expect(container.querySelector('[data-permissions]')!.classList.contains('gap-2')).toBe(true);
  expect([...container.querySelectorAll('[data-permission-token]')].map(node => node.getAttribute('data-permission-state'))).toEqual(['on', 'off', 'models']);
  expect(items.every(item => item.childElementCount === 1 && item.firstElementChild!.hasAttribute('data-permission-token'))).toBe(true);
  expect(container.querySelectorAll('svg')).toHaveLength(3);
  expect(screen.queryByText('Audit users')).toBeNull();
  expect(container.querySelector('dl')).toBeNull();
});

test('preserves explicit Off and full editing as separate permission tokens', () => {
  const { container } = renderInApp(<RulePermissions values={{ 'Model.Use': false, 'Upstream.Edit': 'full' }} />);
  const tokens = [...container.querySelectorAll('[data-permission-token]')];
  expect(tokens.map(token => token.textContent)).toEqual(['Use models Off', 'Edit upstream (Full)']);
  expect(tokens.map(token => token.getAttribute('data-permission-state'))).toEqual(['off', 'full']);
});

test('aligns both states to the tight cross slot with equal 8px spacing and preserves glyph sizes', () => {
  const { container } = renderInApp(<RulePermissions values={mixed} />);
  for (const token of container.querySelectorAll<HTMLElement>('[data-permission-token]')) {
    const off = token.dataset.permissionState === 'off';
    const icon = token.querySelector<SVGElement>('.fui-Tag__icon svg')!;
    const frame = token.querySelector<HTMLElement>('.fui-Tag__icon')!;
    expect(icon.getAttribute('viewBox')).toBe(off ? '0 0 12 12' : '0 0 24 24');
    expect(icon.style.width).toBe(off ? '12px' : '14px');
    expect(icon.style.transform).toBe(off ? 'scale(1)' : 'translate(-50%, -50%) scale(1.05)');
    expect(frame.style.width).toBe('8.044606px');
    expect(frame.style.height).toBe('8.044607px');
    expect(getComputedStyle(token).columnGap).toBe('8px');
    expect(getComputedStyle(token).paddingLeft).toBe('8px');
    expect(getComputedStyle(token).paddingRight).toBe('8px');
    if (off) {
      expect(icon.style.position).toBe('absolute');
      expect(icon.style.left).toBe('-2.005393px');
      expect(icon.style.top).toBe('-1.95px');
    } else {
      expect(icon.style.position).toBe('absolute');
      expect(icon.style.left).toBe('50%');
      expect(icon.style.top).toBe('50%');
    }
  }
});

test('reserves blue for partial access and uses green for maximum access', () => {
  expect(permissionTone(true)).toBe('success');
  expect(permissionTone('full')).toBe('success');
  expect(permissionTone('models')).toBe('accent');
  expect(permissionTone(false)).toBe('neutral');
  expect(permissionTone('off')).toBe('neutral');
});

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [1] }],
  groups: [{ id: 1, name: 'Platform', hue: 210, memberIds: [2], createdAt: '', deletedAt: null }],
  upstreams: [], models: [],
};
const source: AccessRecord = { id: 1, principal: { kind: 'group', id: 1 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Upstream.Edit': 'models' }, createdAt: '', updatedAt: '' };
const winner: AccessRecord = { ...source, id: 2, principal: { kind: 'user', id: 2 }, values: { 'Upstream.Edit': 'full' } };

test.each([false, true])('uses a body-sized rich explanation with grouped scope context: %s', async otherScope => {
  const by: AccessRecord = { ...winner, ...(otherScope ? { scope: { kind: 'user', userId: 2 } as const } : {}) };
  const { container } = renderInApp(<RulePermissions context={{ record: source, data, decisions: { 'Upstream.Edit': { kind: 'overridden', by } } }} values={source.values} />);
  fireEvent.focus(container.querySelector('[data-overridden-by]')!);
  const tooltip = await screen.findByRole('tooltip');
  expect(tooltip.style.fontSize).toBe('var(--fontSizeBase300)');
  expect(tooltip.style.lineHeight).toBe('var(--lineHeightBase300)');
  expect(tooltip.style.width).toBe('max-content');
  expect(tooltip.style.maxWidth).toBe('min(1120px, calc(100vw - 32px))');
  expect(tooltip.querySelector('[data-override-explanation]')).toBeTruthy();
  expect(tooltip.querySelectorAll('[data-override-explanation] > .floway-control-label')).toHaveLength(2);
  expect(tooltip.querySelector('[data-override-location]') !== null).toBe(otherScope);
  expect(tooltip.textContent).toContain('alice');
});

test('dims and diagonally strikes only the overridden permission', () => {
  const { container } = renderInApp(<RulePermissions context={{ record: source, data, decisions: { 'Upstream.Edit': { kind: 'overridden', by: winner } } }} values={source.values} />);
  const token = container.querySelector<HTMLElement>('[data-permission-token]')!;
  expect(token.style.opacity).toBe('0.5');
  expect(container.querySelector('[data-overridden-by="2"]')!.getAttribute('tabindex')).toBe('0');
  const line = token.querySelector('line')!;
  expect(line.getAttribute('stroke-opacity')).toBe('0.6');
  const clip = token.querySelector<HTMLElement>('[data-permission-strike]')!;
  expect(clip.classList.contains('overflow-hidden')).toBe(true);
  expect(clip.style.borderRadius).toBe(token.style.borderRadius);
  expect([line.getAttribute('x1'), line.getAttribute('y1'), line.getAttribute('x2'), line.getAttribute('y2')]).toEqual(['0', '0', '100', '100']);
  expect(token.getAttribute('data-permission-state')).toBe('models');
});

test('keeps active group tokens, including explicit Off, identical to ordinary tokens', () => {
  const values: AccessValues = { 'Model.Use': false, 'Upstream.Edit': 'models' };
  const { container } = renderInApp(<>
    <RulePermissions context={{ record: source, data, decisions: { 'Model.Use': { kind: 'effective' }, 'Upstream.Edit': { kind: 'effective' } } }} values={values} />
    <RulePermissions values={values} />
  </>);
  const tokens = [...container.querySelectorAll<HTMLElement>('[data-permission-emphasis="effective"]')];
  const ordinary = [...container.querySelectorAll<HTMLElement>('[data-permission-emphasis="normal"]')];
  expect(tokens.every(token => token.getAttribute('data-permission-emphasis') === 'effective' && token.style.opacity !== '0.5')).toBe(true);
  expect(tokens.map(token => token.style.cssText)).toEqual(ordinary.map(token => token.style.cssText));
  expect(container.querySelector('line')).toBeNull();
});
