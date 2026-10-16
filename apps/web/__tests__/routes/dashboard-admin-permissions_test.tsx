import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ResolveTester } from '../../src/routes/dashboard-admin-permissions';
import { renderInApp } from '../render';

test('starts the effective access tester with a concrete non-admin user target', () => {
  renderInApp(<ResolveTester data={{
    users: [
      { id: 1, username: 'admin', isAdmin: true, createdAt: '', groupIds: [], accessRecordCount: 0 },
      { id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [], accessRecordCount: 0 },
    ],
    groups: [],
    upstreams: [],
    models: [],
  }} />);

  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'User' }).value).toBe('alice');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Test access' }).disabled).toBe(false);
  expect(screen.getByText('alice', { selector: '.floway-scope-expression-part' })).not.toBeNull();
});
