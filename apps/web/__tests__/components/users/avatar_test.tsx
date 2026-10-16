import { expect, test } from 'vitest';

import { UserAvatar } from '../../../src/components/users/avatar';
import { alphaColor } from '../../../src/lib/color';
import { hueBadgeTone, hueFromString } from '../../../src/lib/hue';
import { renderInApp } from '../../render';

test('paints matching usernames with matching themed identity colors', () => {
  const { container } = renderInApp(<><UserAvatar username="alice" /><UserAvatar username="alice" /><UserAvatar username="bob" /></>);
  const initials = [...container.querySelectorAll<HTMLElement>('.fui-Avatar__initials')];
  expect(initials).toHaveLength(3);
  expect(initials[0]!.style.cssText).toBe(initials[1]!.style.cssText);
  expect(initials[0]!.style.cssText).not.toBe(initials[2]!.style.cssText);
  expect(initials[0]!.style.getPropertyValue('--floway-badge-fill-light')).toBe(alphaColor(hueBadgeTone(hueFromString('alice')).light, 0.1));
  expect(initials[0]!.style.getPropertyValue('--floway-badge-fill-dark')).not.toBe('');
  expect(container.querySelector('.fui-Avatar')!.getAttribute('aria-hidden')).toBe('true');
});
