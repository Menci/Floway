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

test('places scope mode tabs beside the scope label while leaving controls outside the label', async () => {
  await renderDialog();
  const tabs = screen.getByRole('tablist', { name: i18n.t('dashboard.accessControl.fields.scope') });
  const header = tabs.closest('[data-scope-editor-header]')!;
  expect(header).toBeTruthy();
  expect(header.querySelector('.fui-Field__label')!.textContent).toBe(i18n.t('dashboard.accessControl.fields.scope'));
  expect(tabs.closest('label')).toBeNull();
  expect(header.classList.contains('floway-scope-editor-header')).toBe(true);
  expect(screen.getByRole('group', { name: i18n.t('dashboard.accessControl.fields.scope') }).parentElement!.classList.contains('floway-scope-editor')).toBe(true);
});

test('round trips the default root through JSON and still requires a concrete scope when saving', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await renderDialog();
  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' });
  expect(editor.value).toBe('null');
  fireEvent.click(screen.getByRole('tab', { name: 'Visual' }));
  expect(screen.getByRole('tab', { name: 'Visual' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('textbox', { name: 'JSON' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  expect(screen.getByRole('textbox', { name: 'JSON' })).toBe(editor);
  await act(async () => { screen.getByRole('button', { name: i18n.t('dashboard.accessControl.actions.save') }).click(); });
  expect(screen.getByText(i18n.t('dashboard.accessControl.validation.scopeRequired'))).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

test('keeps an invalid JSON scope in JSON mode until it satisfies the schema', async () => {
  await renderDialog();
  screen.getByRole('tab', { name: 'JSON' }).click();
  const json = await screen.findByLabelText('JSON');
  fireEvent.change(json, { target: { value: '{"kind":"user","userId":"alice"}' } });

  screen.getByRole('tab', { name: 'Visual' }).click();

  expect(await screen.findByLabelText('JSON')).toBeTruthy();
  expect(json.getAttribute('aria-invalid')).toBe('true');
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
  expect(screen.queryByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.User.Audit') })).toBeNull();
  expect(screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Permission.Audit') })).toBeTruthy();

  fireEvent.change(editor, { target: { value: JSON.stringify({ kind: 'group', groupId: 3 }) } });
  const userAudit = screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.User.Audit') });
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
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  const edit = await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  fireEvent.click(within(edit).getByRole('radio', { name: i18n.t('dashboard.accessControl.states.off') }));
  await act(async () => { fireEvent.click(save); });
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(write).toBeTruthy();
  expect(JSON.parse(write![1]!.body as string)).toMatchObject({
    principal: { kind: 'user', id: 1 },
    values: { 'Model.Use': true, 'Upstream.Edit': 'off' },
  });
});

test('shows the exact inherited upstream edit level for a concrete user target', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' },
  })));
  await renderDialog({ record });

  const edit = await screen.findByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  const inherited = await within(edit).findByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.models') });
  await vi.waitFor(() => expect(inherited.checked).toBe(true));
  expect(screen.queryByRole('spinbutton')).toBeNull();
});

test('resolves group inheritance through the same API as personal inheritance', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ values: { 'Model.Use': false, 'Upstream.Audit': true, 'Upstream.Edit': 'full' }, records: [], decisions: [] }));
  vi.stubGlobal('fetch', fetch);
  await renderDialog({ record: { ...record, principal: { kind: 'group', id: 3 } } });

  const edit = screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  const inherited = await within(edit).findByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.full') });
  await vi.waitFor(() => expect(inherited.checked).toBe(true));
  expect(fetch).toHaveBeenCalledOnce();
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body).toEqual({ principal: { kind: 'group', id: 3 }, scope: record.scope, excludeRecordId: record.id });
});

test('moving a fixed rule into a model boundary uses the available append order', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'PUT' ? { ...record, ...JSON.parse(init.body as string) } : { values: { 'Model.Use': true }, records: [], decisions: [] }));
  vi.stubGlobal('fetch', fetch);
  await renderDialog({ record, suggestedSortOrder: 99 });
  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'JSON' }), { target: { value: JSON.stringify({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }) } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save rule' })); });
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(write[1]!.body as string).sortOrder).toBe(99);
});

test.each(['Visual', 'JSON'])('locks the complete %s form through a save and restores it on failure', async mode => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT'
    ? await new Promise<Response>(resolve => { finish = resolve; })
    : Response.json({ values: { 'Model.Use': false, 'Upstream.Audit': false, 'Upstream.Edit': 'off' }, records: [], decisions: [] })));
  await renderDialog({ record });
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
