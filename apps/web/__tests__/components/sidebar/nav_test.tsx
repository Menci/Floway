import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, test } from 'vitest';

import { Sidebar } from '../../../src/components/sidebar/nav';
import { renderInApp } from '../../render';

const renderSidebar = (canViewUpstreams: boolean, canViewPermissions: boolean) => renderInApp(<RouterProvider router={createMemoryRouter([{
  path: '/', Component: () => <Sidebar user={{ id: 2, username: 'operator', isAdmin: false, canViewPermissions, canViewUpstreams, preferences: { quotaDisplay: 'remaining' as const, language: null } }} />,
}], { initialEntries: ['/'] })} />);

test('renders the management section with its translated label for an administrator', () => {
  renderInApp(<RouterProvider router={createMemoryRouter([{
    path: '/', Component: () => <Sidebar user={{ id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } }} />,
  }], { initialEntries: ['/'] })} />);
  expect(screen.getByText('Management')).toBeTruthy();
  expect(screen.queryByText('dashboard.groups.management')).toBeNull();
});

test('shows capability-gated management pages independently', () => {
  const hidden = renderSidebar(false, false);
  expect(screen.queryByRole('link', { name: 'Upstreams' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Permissions' })).toBeNull();
  hidden.unmount();

  renderSidebar(true, true);
  expect(screen.getByRole('link', { name: 'Upstreams' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Permissions' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
});
