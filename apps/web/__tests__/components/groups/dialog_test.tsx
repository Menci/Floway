import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { ControlPlaneGroup } from '../../../src/api/types';
import { GroupDialog } from '../../../src/components/groups/dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const group: ControlPlaneGroup = {
  id: 3, name: 'Operators', hue: 120, createdAt: '', deletedAt: null,
};

test('guards a group draft before closing', async () => {
  renderInApp(<OutcomeToastProvider><GroupDialog
    group={group}
    onOpenChange={vi.fn()}
    onSaved={async () => {}}
    open
    groups={[group]}
  /></OutcomeToastProvider>);
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.groupsManagement.fields.name')), { target: { value: 'Renamed' } });

  screen.getByRole('button', { name: i18n.t('common.cancel') }).click();

  expect(await screen.findByText(i18n.t('common.discard.title'))).toBeTruthy();
});
