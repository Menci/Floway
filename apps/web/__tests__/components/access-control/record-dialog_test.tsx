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
    { id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [3] },
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
      records={props.records ?? (props.record ? [props.record] : [])}
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

test('an administrator target keeps its permission fields and saves normally', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({ ...record, ...JSON.parse(init!.body as string) }));
  vi.stubGlobal('fetch', fetch);
  await renderDialog({ record: { ...record, principal: { kind: 'user', id: 1 } } });

  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save rule' });
  expect(save.disabled).toBe(false);
  const edit = screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Upstream.Edit') });
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  fireEvent.click(within(edit).getByRole('radio', { name: i18n.t('dashboard.accessControl.states.off') }));
  await act(async () => { fireEvent.click(save); });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
    principal: { kind: 'user', id: 1 },
    values: { 'Model.Use': true, 'Upstream.Edit': 'off' },
  });
});

test('opening and switching scope renders final inherited permission fields immediately without unknown flashes', async () => {
  const records: AccessRecord[] = [
    { ...record, id: 1, principal: { kind: 'group', id: 3 }, scope: { kind: 'upstreams' }, values: { 'Model.Use': true } },
    { ...record, id: 2, principal: { kind: 'group', id: 3 }, scope: { kind: 'groups' }, values: { 'Permission.Audit': true } },
    record,
  ];
  await renderDialog({ record, records });

  const fields = () => [...document.querySelectorAll('[data-permission-field]')].map(field => field.getAttribute('data-permission-field'));
  expect(fields()).toEqual(['Model.Use', 'Upstream.Audit', 'Upstream.Edit']);
  expect(document.querySelector('[data-inheritance-unknown]')).toBeNull();

  const snapshots: string[] = [];
  const observer = new MutationObserver(() => {
    snapshots.push(`${fields().join(',')}|${document.querySelector('[data-inheritance-unknown]') === null ? 'known' : 'unknown'}`);
  });
  observer.observe(screen.getByRole('dialog'), { childList: true, subtree: true, attributes: true });

  fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'JSON' }), { target: { value: JSON.stringify({ kind: 'groups' }) } });
  observer.disconnect();

  expect(fields()).toEqual(['Permission.Audit']);
  const audit = screen.getByRole('radiogroup', { name: i18n.t('dashboard.accessControl.permissions.Permission.Audit') });
  expect(within(audit).getByRole<HTMLInputElement>('radio', { name: i18n.t('dashboard.accessControl.states.on') }).checked).toBe(true);
  expect(snapshots.every(snapshot => snapshot.endsWith('|known'))).toBe(true);
});

test.each(['Visual', 'JSON'])('locks the complete %s form through a save and restores it on failure', async mode => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async () => await new Promise<Response>(resolve => { finish = resolve; })));
  await renderDialog({ record });
  if (mode === 'JSON') fireEvent.click(screen.getByRole('tab', { name: mode }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save rule' })); });
  const principal = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  expect(principal.disabled).toBe(true);
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => input.disabled)).toBe(true);
  expect(screen.getAllByRole<HTMLButtonElement>('tab').every(tab => tab.disabled)).toBe(true);
  if (mode === 'JSON') expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' }).readOnly).toBe(true);
  await act(async () => { finish(Response.json({ error: 'Save failed' }, { status: 503 })); });
  await screen.findByText('Save failed');
  await waitFor(() => expect(principal.disabled).toBe(false));
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.disabled)).toBe(true);
  if (mode === 'JSON') expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' }).readOnly).toBe(false);
});
