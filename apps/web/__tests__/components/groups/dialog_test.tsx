import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { ControlPlaneGroup, ControlPlaneUser } from '../../../src/api/types';
import { GroupDialog } from '../../../src/components/groups/dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const user: ControlPlaneUser = {
  id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [3], accessRecordCount: 0,
};
const group: ControlPlaneGroup = {
  id: 3, name: 'Operators', createdAt: '', deletedAt: null, memberIds: [2], accessRecordCount: 0,
};

test('guards a group name or membership draft before closing', async () => {
  renderInApp(<OutcomeToastProvider><GroupDialog
    accessData={{ groups: [group], models: [], upstreams: [], users: [user] }}
    accessRecords={[]}
    group={group}
    onAccessChanged={async () => {}}
    onOpenChange={vi.fn()}
    onSaved={async () => {}}
    open
    users={[user]}
  /></OutcomeToastProvider>);
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.groupsManagement.fields.name')), { target: { value: 'Renamed' } });

  screen.getByRole('button', { name: i18n.t('common.cancel') }).click();

  expect(await screen.findByText(i18n.t('common.discard.title'))).toBeTruthy();
});
