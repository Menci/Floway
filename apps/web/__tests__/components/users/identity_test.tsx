import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { UserIdentity } from '../../../src/components/users/identity';
import { renderInApp } from '../../render';

test.each([true, false])('keeps the shared identity and renders administrator metadata when %s', isAdmin => {
  const { container } = renderInApp(<UserIdentity isAdmin={isAdmin} username="alice" />);
  expect(container.querySelector('.floway-identity-name')?.textContent).toBe('alice');
  expect(container.querySelector('.floway-avatar-initials')?.textContent).toBe('A');
  expect(screen.queryByRole('img', { name: 'Administrator' }) !== null).toBe(isAdmin);
  if (isAdmin) {
    const icon = container.querySelector<SVGElement>('.floway-admin-indicator svg')!;
    expect(icon.style.width).toBe('16px');
    expect(icon.style.height).toBe('16px');
  }
});
