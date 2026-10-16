import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AccessRecord } from '../../../src/api/types';
import { AccessRecordDialog } from '../../../src/components/access-control/record-dialog';
import type { ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const data: ScopeExpressionData = {
  users: [
    { id: 1, username: 'admin', isAdmin: true, createdAt: '', groupIds: [], accessRecordCount: 0 },
    { id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [], accessRecordCount: 0 },
  ],
  groups: [{ hue: 120, id: 3, name: 'operators', createdAt: '', deletedAt: null, memberIds: [2], accessRecordCount: 0 }],
  upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', enabled: true, hue: 210, cachedModelCount: 0 }],
  models: [],
};
const record: AccessRecord = {
  id: 7,
  principal: { kind: 'user', id: 2 },
  scope: { kind: 'upstream', upstreamId: 'up_a' },
  sortOrder: 0,
  values: { 'Model.Use': true },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

const renderDialog = (props: Partial<Parameters<typeof AccessRecordDialog>[0]> = {}) => renderInApp(
  <OutcomeToastProvider><AccessRecordDialog
    data={data}
    onOpenChange={vi.fn()}
    onSaved={async () => {}}
    open
    {...props}
  /></OutcomeToastProvider>,
);

test('new records start at the root slash and reject an incomplete scope inline', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderDialog();

  expect(screen.getByRole('button', { name: i18n.t('dashboard.accessControl.scope.kind') }).textContent).toBe('/');
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: i18n.t('dashboard.accessControl.fields.principal') }).value).toBe('alice');
  expect(screen.queryByText(i18n.t('dashboard.accessControl.scope.kinds.upstream'))).toBeNull();

  await act(async () => { screen.getByRole('button', { name: i18n.t('dashboard.accessControl.actions.save') }).click(); });

  expect(screen.getByText(i18n.t('dashboard.accessControl.validation.scopeRequired'))).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

test('keeps an invalid JSON scope in JSON mode until it satisfies the schema', async () => {
  renderDialog();
  screen.getByRole('tab', { name: 'JSON' }).click();
  const json = await screen.findByLabelText('JSON');
  fireEvent.change(json, { target: { value: '{"kind":"user","userId":"alice"}' } });

  screen.getByRole('tab', { name: 'Visual' }).click();

  expect(await screen.findByLabelText('JSON')).toBeTruthy();
  expect(json.getAttribute('aria-invalid')).toBe('true');
});

test('shows the exact inherited upstream edit level for a concrete user target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' },
  })));
  renderDialog({ record });

  const edit = await screen.findByRole<HTMLInputElement>('combobox', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  expect(edit.value).toBe(i18n.t('dashboard.accessControl.states.inheritModels'));
});

test('does not invent an inherited value for a group principal', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderDialog({ fixedPrincipal: { kind: 'group', id: 3 }, record: { ...record, principal: { kind: 'group', id: 3 } } });

  const edit = screen.getByRole<HTMLInputElement>('combobox', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  expect(edit.value).toBe(i18n.t('dashboard.accessControl.states.inherit'));
  expect(fetch).not.toHaveBeenCalled();
});
