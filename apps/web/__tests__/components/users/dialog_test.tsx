import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessRecord, ControlPlaneGroup, ControlPlaneUser } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UserDialog } from '../../../src/components/users/dialog';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const user: ControlPlaneUser = {
  id: 2,
  username: 'operator',
  isAdmin: false,
  groupIds: [],
  accessRecordCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const group: ControlPlaneGroup = {
  id: 3, name: 'Operators', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, memberIds: [2], accessRecordCount: 1,
};
const inheritedRecord: AccessRecord = {
  id: 4,
  principal: { kind: 'group', id: 3 },
  scope: { kind: 'upstreams' },
  sortOrder: 0,
  values: { 'Model.Use': true },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('user account dialog', () => {
  it.each(['create', 'edit'] as const)('saves %s without embedding access records', async mode => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(mode === 'create' ? { user } : user));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn(async () => {});
    renderInApp(<OutcomeToastProvider><UserDialog
      {...(mode === 'create' ? { mode } : { mode, user })}
      accessData={{ groups: [], models: [], upstreams: [], users: [user] }}
      accessRecords={[]}
      actorId={1}
      groups={[]}
      onAccessChanged={async () => {}}
      onOpenChange={vi.fn()}
      onSaved={onSaved}
      open
    /></OutcomeToastProvider>);
    if (mode === 'create') {
      fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.username')), { target: { value: 'operator' } });
      fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.password')), { target: { value: 'password' } });
    }

    await act(async () => {
      screen.getByRole('button', { name: i18n.t(mode === 'create' ? 'dashboard.users.actions.create' : 'dashboard.users.actions.save') }).click();
    });

    expect(onSaved).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.lastCall!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('upstreamIds');
    expect(body.username).toBe('operator');
  });

  it('opens an inherited record source only after the user dialog can close', () => {
    const onOpenChange = vi.fn();
    const onOpenGroup = vi.fn();
    renderInApp(<OutcomeToastProvider><UserDialog
      accessData={{ groups: [group], models: [], upstreams: [], users: [{ ...user, groupIds: [3] }] }}
      accessRecords={[inheritedRecord]}
      actorId={1}
      groups={[group]}
      mode="edit"
      onAccessChanged={async () => {}}
      onOpenChange={onOpenChange}
      onOpenGroup={onOpenGroup}
      onSaved={async () => {}}
      open
      user={{ ...user, groupIds: [3] }}
    /></OutcomeToastProvider>);

    screen.getByRole('button', { name: group.name }).click();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenGroup).toHaveBeenCalledWith(group);
  });

  it('guards inherited source navigation when the user form is dirty', async () => {
    const onOpenGroup = vi.fn();
    renderInApp(<OutcomeToastProvider><UserDialog
      accessData={{ groups: [group], models: [], upstreams: [], users: [{ ...user, groupIds: [3] }] }}
      accessRecords={[inheritedRecord]}
      actorId={1}
      groups={[group]}
      mode="edit"
      onAccessChanged={async () => {}}
      onOpenChange={vi.fn()}
      onOpenGroup={onOpenGroup}
      onSaved={async () => {}}
      open
      user={{ ...user, groupIds: [3] }}
    /></OutcomeToastProvider>);
    fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.username')), { target: { value: 'renamed' } });

    screen.getByRole('button', { name: group.name }).click();

    expect(await screen.findByText(i18n.t('common.discard.title'))).toBeTruthy();
    expect(onOpenGroup).not.toHaveBeenCalled();
  });
});
