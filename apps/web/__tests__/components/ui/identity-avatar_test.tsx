import { expect, test } from 'vitest';

import { IdentityAvatar } from '../../../src/components/ui/identity-avatar';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Avatar } = fluentComponents;

test.each(['On-call', 'Platform', 'alice', 'External contractors', 'équipe'])('keeps Fluent initials generation and typography for %s', name => {
  const { container } = renderInApp(<>
    <IdentityAvatar color="colorful" name={name} size={24} />
    <Avatar color="colorful" name={name} size={24} />
  </>);
  const initials = [...container.querySelectorAll('.fui-Avatar__initials')];
  expect(initials).toHaveLength(2);
  expect(initials[0]!.className).toBe(initials[1]!.className);
  expect(initials[0]!.textContent).toBe(initials[1]!.textContent);
  expect(initials[0]!.querySelector('.floway-avatar-initials')!.textContent).toBe(initials[1]!.textContent);
});

test.each(['', '研究组'])('keeps the native person icon when initials cannot be generated for %s', name => {
  const { container } = renderInApp(<>
    <IdentityAvatar name={name} size={24} />
    <Avatar name={name} size={24} />
  </>);
  const icons = [...container.querySelectorAll('.fui-Avatar__icon')];
  expect(icons).toHaveLength(2);
  expect(icons[0]!.className).toBe(icons[1]!.className);
  expect(container.querySelector('.floway-avatar-initials')).toBeNull();
});

test.each(['+2', '+12', '+123'])('preserves explicit counter text %s inside the trimmed initials slot', initials => {
  const { container } = renderInApp(<IdentityAvatar color="neutral" initials={initials} name={initials} shape="square" size={24} />);
  expect(container.querySelector('.floway-avatar-initials')?.textContent).toBe(initials);
});
