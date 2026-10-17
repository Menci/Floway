import { expect, test } from 'vitest';

import { GroupIdentity } from '../../../src/components/groups/identity';
import { avatarColorForHue } from '../../../src/components/ui/avatar-hue';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Avatar } = fluentComponents;

test('preserves Fluent square Avatar palette and initials typography with an optical surface inset', () => {
  const { container } = renderInApp(<>
    <GroupIdentity group={{ name: 'Research', hue: 150 }} />
    <Avatar aria-hidden color={avatarColorForHue(150)} name="Research" shape="square" size={24} />
  </>);
  const avatars = [...container.querySelectorAll<HTMLElement>('.fui-Avatar')];
  const initials = [...container.querySelectorAll<HTMLElement>('.fui-Avatar__initials')];
  expect(avatars).toHaveLength(2);
  expect(avatars[0]!.className.replace('floway-group-avatar ', '')).toBe(avatars[1]!.className);
  expect(avatars[0]!.classList.contains('floway-group-avatar')).toBe(true);
  expect(initials[0]!.className).toBe(initials[1]!.className);
  expect(initials[0]!.textContent).toBe('R');
  expect(avatars[0]!.getAttribute('style')).toBe(avatars[1]!.getAttribute('style'));
  for (const element of initials) expect(element.getAttribute('style')).toBeNull();
  expect(avatars[0]!.getAttribute('aria-hidden')).toBe('true');
});

test('derives group avatar color from hue rather than group name', () => {
  const { container } = renderInApp(<>
    <GroupIdentity group={{ name: 'Platform', hue: 210 }} />
    <GroupIdentity group={{ name: 'Renamed team', hue: 210 }} />
    <GroupIdentity group={{ name: 'Platform', hue: 355 }} />
  </>);
  const initials = [...container.querySelectorAll<HTMLElement>('.fui-Avatar__initials')];
  expect(initials[0]!.className).toBe(initials[1]!.className);
  expect(initials[0]!.className).not.toBe(initials[2]!.className);
});
