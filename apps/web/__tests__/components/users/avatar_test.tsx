import { expect, test } from 'vitest';

import { UserAvatar } from '../../../src/components/users/avatar';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Avatar } = fluentComponents;

test('preserves the mockup Fluent identity palette without custom badge styling', () => {
  const { container } = renderInApp(<><UserAvatar username="alice" /><UserAvatar username="alice" /><UserAvatar username="bob" /><Avatar color="colorful" idForColor="alice" name="alice" size={24} /></>);
  const initials = [...container.querySelectorAll<HTMLElement>('.fui-Avatar__initials')];
  expect(initials).toHaveLength(4);
  expect(initials[0]!.className).toBe(initials[1]!.className);
  expect(initials[0]!.className).not.toBe(initials[2]!.className);
  expect(initials[0]!.className).toBe(initials[3]!.className);
  expect(initials[0]!.getAttribute('style')).toBeNull();
  expect(container.querySelector('.fui-Avatar')!.getAttribute('aria-hidden')).toBe('true');
});
