import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { UserGroupsField } from '../../../src/components/groups/field';
import type { DirectoryGroupOption } from '../../../src/components/users/directory';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const groups: DirectoryGroupOption[] = [
  { id: 1, name: 'Platform', hue: 250, memberCount: 0 },
  { id: 2, name: 'Research', hue: 150, memberCount: 0 },
];

function Form() {
  const [value, setValue] = useState(['1']);
  return <><UserGroupsField disabled={false} groups={groups} onChange={setValue} value={value} /><output>{JSON.stringify(value)}</output></>;
}

test('searches unselected groups, joins one, and removes a selected tag', async () => {
  renderInApp(<Form />);
  const input = screen.getByRole('combobox', { name: i18n.t('dashboard.users.table.groups') });
  await act(async () => { fireEvent.click(input); fireEvent.change(input, { target: { value: 'Res' } }); });
  const option = await screen.findByRole('option', { name: /Research/ });
  await act(async () => { option.click(); });
  expect(screen.getByRole('status').textContent).toBe('["1","2"]');
  await act(async () => { fireEvent.click(screen.getByLabelText(i18n.t('dashboard.groupsManagement.actions.leave', { name: 'Platform' }))); });
  expect(screen.getByRole('status').textContent).toBe('["2"]');
});
