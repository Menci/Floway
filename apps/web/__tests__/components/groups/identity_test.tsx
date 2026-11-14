import { expect, test } from 'vitest';

import { GroupIdentity } from '../../../src/components/groups/identity';
import { renderInApp } from '../../render';

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
