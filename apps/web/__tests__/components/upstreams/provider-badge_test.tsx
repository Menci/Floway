import { expect, test } from 'vitest';

import { ProviderBadge } from '../../../src/components/upstreams/provider-badge';
import { renderInApp } from '../../render';

test('uses the standard Fluent size with 7px outer spacing and a 6px icon-label gap', () => {
  const { container } = renderInApp(<ProviderBadge label="Copilot Enterprise" upstream={{ kind: 'copilot', hue: 210 }} />);
  const badge = container.querySelector<HTMLElement>('.fui-Tag')!;
  const style = getComputedStyle(badge);
  expect(style.height).toBe('24px');
  expect(style.columnGap).toBe('6px');
  expect(style.paddingLeft).toBe('6px');
  expect(style.paddingRight).toBe('6px');
  expect(getComputedStyle(badge.querySelector('.fui-Tag__primaryText')!).fontSize).toBe('12px');
  expect(badge.querySelector('.fui-Tag__icon .h-4.w-4')).toBeTruthy();
  expect(badge.textContent).toBe('Copilot Enterprise');
});
