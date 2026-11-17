import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AccessRecord } from '../../../src/api/types';
import { AccessRecordDialog } from '../../../src/components/access-control/record-dialog';
import type { ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

vi.mock('../../../src/components/ui/json-editor', () => ({
  JsonEditor: ({ active, invalid, label, onChange, readOnly, value }: { active: boolean; invalid: boolean; label: string; onChange: (value: string) => void; readOnly?: boolean; value: string }) =>
    <textarea aria-invalid={invalid} aria-label={label} hidden={!active} onChange={event => onChange(event.target.value)} readOnly={readOnly} value={value} />,
}));

const data: ScopeExpressionData = {
  users: [
    { id: 1, username: 'admin', isAdmin: true, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [] },
    { id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [] },
  ],
  groups: [{ hue: 120, id: 3, name: 'operators', createdAt: '', deletedAt: null, memberIds: [2] }],
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

const renderDialog = async (props: Partial<Parameters<typeof AccessRecordDialog>[0]> = {}) => {
  const result = renderInApp(
    <OutcomeToastProvider><AccessRecordDialog
      data={data}
      principalData={data}
      onOpenChange={vi.fn()}
      onSaved={async () => {}}
      open
      {...props}
    /></OutcomeToastProvider>,
  );
  await screen.findByRole('dialog');
  return result;
};

test('new records start at the root slash and reject an incomplete scope inline', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await renderDialog();

  expect(screen.getByRole('button', { name: i18n.t('dashboard.accessControl.scope.kind') }).querySelector('svg')).toBeTruthy();
  expect(screen.getByRole('group', { name: i18n.t('dashboard.accessControl.fields.scope') }).textContent).toBe('/');
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: i18n.t('dashboard.accessControl.fields.principal') }).value).toBe('alice');
  expect(screen.queryByText(i18n.t('dashboard.accessControl.scope.kinds.upstream'))).toBeNull();

  await act(async () => { screen.getByRole('button', { name: i18n.t('dashboard.accessControl.actions.save') }).click(); });

  expect(screen.getByText(i18n.t('dashboard.accessControl.validation.scopeRequired'))).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

test('updates permission controls from each valid JSON scope draft', async () => {
  const groupRecord: AccessRecord = {
    ...record,
    scope: { kind: 'group', groupId: 3 },
    values: { 'User.Audit': true, 'Permission.Audit': true },
  };
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'PUT'
    ? { ...groupRecord, ...JSON.parse(init.body as string) }
    : { values: { 'User.Audit': false, 'Permission.Audit': false }, records: [], decisions: [] }));
  vi.stubGlobal('fetch', fetch);
  await renderDialog({ record: groupRecord });
  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  const editor = screen.getByRole('textbox', { name: 'JSON' });

  fireEvent.change(editor, { target: { value: JSON.stringify({ kind: 'groups' }) } });
  await vi.waitFor(() => expect(screen.queryByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.User.Audit') })).toBeNull());
  expect(screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Permission.Audit') })).toBeTruthy();

  fireEvent.change(editor, { target: { value: JSON.stringify({ kind: 'group', groupId: 3 }) } });
  const userAudit = await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.User.Audit') });
  fireEvent.click(within(userAudit).getByRole('radio', { name: i18n.t('dashboard.accessControl.states.on') }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.accessControl.actions.save') })); });

  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(write[1]!.body as string)).toMatchObject({
    scope: { kind: 'group', groupId: 3 },
    values: { 'User.Audit': true, 'Permission.Audit': true },
  });
});

test('an administrator target keeps its permission fields and saves normally', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'PUT'
    ? { ...record, ...JSON.parse(init.body as string) }
    : { values: { 'Model.Use': true, 'Upstream.Audit': true, 'Upstream.Edit': 'full' }, records: [], decisions: [] }));
  vi.stubGlobal('fetch', fetch);
  await renderDialog({ record: { ...record, principal: { kind: 'user', id: 1 } } });

  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save rule' });
  expect(save.disabled).toBe(false);
  const edit = await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  fireEvent.click(within(edit).getByRole('radio', { name: i18n.t('dashboard.accessControl.states.off') }));
  await act(async () => { fireEvent.click(save); });
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(write).toBeTruthy();
  expect(JSON.parse(write![1]!.body as string)).toMatchObject({
    principal: { kind: 'user', id: 1 },
    values: { 'Model.Use': true, 'Upstream.Edit': 'off' },
  });
});

test('switching scope keeps the settled permission fields disabled until the new inherited values resolve', async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { scope } = JSON.parse(init!.body as string) as { scope: { kind: string } };
    if (scope.kind === 'upstream') return Response.json({ values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'off' }, records: [], decisions: [] });
    return await new Promise<Response>(resolve => { pending.push(resolve); });
  }));
  await renderDialog({ record });
  const modelUse = await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Model.Use') });
  await vi.waitFor(() => expect(within(modelUse).getByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.on') }).checked).toBe(true));
  const fields = () => [...document.querySelectorAll('[data-permission-field]')].map(field => field.getAttribute('data-permission-field'));
  const snapshots: string[] = [];
  const observer = new MutationObserver(() => {
    snapshots.push(`${fields().join(',')}|${document.querySelector('[data-inheritance-unknown]') === null ? 'known' : 'unknown'}`);
  });
  observer.observe(screen.getByRole('dialog'), { childList: true, subtree: true, attributes: true });

  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'JSON' }), { target: { value: JSON.stringify({ kind: 'upstreams' }) } });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(fields()).toEqual(['Model.Use', 'Upstream.Audit', 'Upstream.Edit']);
  expect(within(modelUse).getByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.on') }).checked).toBe(true);
  const editor = document.querySelector('[data-permission-editor]')!;
  expect(editor.getAttribute('aria-busy')).toBe('true');
  expect(within(editor as HTMLElement).getAllByRole<HTMLInputElement>('radio').every(input => input.disabled)).toBe(true);
  const save = screen.getByRole<HTMLButtonElement>('button', { name: i18n.t('dashboard.accessControl.actions.save') });
  expect(save.disabled).toBe(false);
  await act(async () => { fireEvent.click(save); });
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

  fireEvent.change(screen.getByRole('textbox', { name: 'JSON' }), { target: { value: JSON.stringify({ kind: 'groups' }) } });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[1]!(Response.json({ values: { 'Permission.Audit': true }, records: [], decisions: [] })); });
  await vi.waitFor(() => expect(fields()).toEqual(['Permission.Audit']));
  observer.disconnect();

  const audit = screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Permission.Audit') });
  expect(within(audit).getByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.on') }).checked).toBe(true);
  expect(document.querySelector('[data-permission-editor]')!.getAttribute('aria-busy')).toBe('false');
  expect(within(audit).getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  expect(snapshots.every(snapshot => snapshot.endsWith('|known'))).toBe(true);
  expect(new Set(snapshots.map(snapshot => snapshot.split('|')[0]))).toEqual(new Set(['Model.Use,Upstream.Audit,Upstream.Edit', 'Permission.Audit']));
});

test.each(['Visual', 'JSON'])('locks the complete %s form through a save and restores it on failure', async mode => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT'
    ? await new Promise<Response>(resolve => { finish = resolve; })
    : Response.json({ values: { 'Model.Use': false, 'Upstream.Audit': false, 'Upstream.Edit': 'off' }, records: [], decisions: [] })));
  await renderDialog({ record });
  // Save does nothing while the target resolves, so the lock this test drives
  // cannot begin before its fields are there to be locked.
  await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Model.Use') });
  if (mode === 'JSON') fireEvent.click(screen.getByRole('tab', { name: mode }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save rule' })); });
  const principal = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  expect(principal.disabled).toBe(true);
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => input.disabled)).toBe(true);
  expect(screen.getAllByRole<HTMLButtonElement>('tab').every(tab => tab.disabled)).toBe(true);
  if (mode === 'JSON') expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' }).readOnly).toBe(true);
  else expect(document.querySelector('.floway-scope-editor')!.getAttribute('aria-disabled')).toBe('true');
  await act(async () => { finish(Response.json({ error: 'Save failed' }, { status: 503 })); });
  await screen.findByText('Save failed');
  await waitFor(() => expect(principal.disabled).toBe(false));
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  if (mode === 'JSON') expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' }).readOnly).toBe(false);
});
