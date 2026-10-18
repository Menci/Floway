import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, test } from 'vitest';

import { Sidebar } from '../../../src/components/sidebar/nav';
import { renderInApp } from '../../render';

const renderSidebar = (canViewUpstreams: boolean) => renderInApp(<RouterProvider router={createMemoryRouter([{
  path: '/', Component: () => <Sidebar user={{ id: 2, username: 'operator', isAdmin: false, canViewUpstreams }} />,
}], { initialEntries: ['/'] })} />);

test('shows Upstreams only when the signed-in operator can see an existing upstream', () => {
  const hidden = renderSidebar(false);
  expect(screen.queryByRole('link', { name: 'Upstreams' })).toBeNull();
  hidden.unmount();

  renderSidebar(true);
  expect(screen.getByRole('link', { name: 'Upstreams' })).toBeTruthy();
});
