import { act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import { RulesTable } from '../../../src/components/access-control/rules-table';
import type { useReorderList } from '../../../src/components/ui/reorder-list';
import { renderInApp } from '../../render';

const controllers = vi.hoisted(() => [] as Array<Parameters<typeof useReorderList>[0]>);
const handleIndices = vi.hoisted(() => [] as number[]);
vi.mock('../../../src/components/ui/reorder-list', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/components/ui/reorder-list')>();
  return {
    ...actual,
    useReorderList: (options: Parameters<typeof useReorderList>[0]) => {
      controllers.push(options);
      return {
        listProps: () => ({}), itemProps: () => ({}), position: (index: number) => index,
        handleProps: (index: number) => { handleIndices.push(index); return { disabled: index < 0 }; },
      };
    },
  };
});
type Props = Parameters<typeof RulesTable>[0];
const records: Props['records'] = ['gpt-5', 'gpt-6'].map((value, index) => ({
  id: index + 1, principal: { kind: 'user', id: 2 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value } }, sortOrder: index,
  values: { 'Model.Use': true }, createdAt: '', updatedAt: '',
}));
const data: Props['data'] = { users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [] }], groups: [], models: [], upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', hue: 210, enabled: true, cachedModelCount: 0 }] };
const administratorData: Props['data'] = { ...data, users: [{ ...data.users[0]!, id: 1, username: 'admin', isAdmin: true }] };
const administratorRecords: Props['records'] = records.map(record => ({ ...record, principal: { kind: 'user', id: 1 } }));
const renderTable = (
  onReorder: Props['onReorder'] = vi.fn(async () => records),
  tableData: Props['data'] = data,
  tableRecords: Props['records'] = records,
) => {
  const onReordered = vi.fn();
  const onReorderError = vi.fn(async (_error: unknown) => {});
  const onEdit = vi.fn();
  const onRemove = vi.fn(async () => null);
  return { ...renderInApp(<MemoryRouter><RulesTable admin busy={false} data={tableData} decisions={null} onEdit={onEdit} onRemove={onRemove} onReorder={onReorder} onReordered={onReordered} onReorderError={onReorderError} onScopeSelect={vi.fn()} params={new URLSearchParams()} records={tableRecords} /></MemoryRouter>), onEdit, onRemove, onReorder, onReordered, onReorderError };
};
beforeEach(() => { controllers.length = 0; handleIndices.length = 0; });

test('an administrator principal stays editable, deletable and reorderable', async () => {
  const { onEdit } = renderTable(vi.fn(async () => administratorRecords), administratorData, administratorRecords);
  const rows = [...document.querySelectorAll<HTMLElement>('[data-rule-id]')];
  expect(rows).toHaveLength(2);
  for (const [index, row] of rows.entries()) {
    const edit = within(row).getByRole<HTMLButtonElement>('button', { name: 'Edit rule' });
    expect(edit.disabled).toBe(false);
    expect(within(row).getByRole<HTMLButtonElement>('button', { name: 'Delete rule' }).disabled).toBe(false);
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenLastCalledWith(administratorRecords[index]);
  }
  expect(handleIndices).toEqual([0, 1]);
  expect(controllers[0]!.disabled).toBe(false);
});

test('a pointer drop persists before the controller commits the rendered order', async () => {
  const { onReorder, onReordered } = renderTable();
  await act(async () => { await controllers[0]!.onDrop!(0, 1); });
  expect(onReorder).toHaveBeenCalledWith([1, 2], 0, 1);
  expect(onReordered).not.toHaveBeenCalled();
  act(() => controllers[0]!.onReorder(0, 1));
  expect(onReordered).toHaveBeenCalledExactlyOnceWith(records);
});

test('keyboard reordering persists and commits without a pointer drop phase', async () => {
  const { onReordered } = renderTable();
  await act(async () => { controllers[0]!.onReorder(0, 1); });
  expect(onReordered).toHaveBeenCalledExactlyOnceWith(records);
});

test('filtering a segment away after its write still commits its pending result once', async () => {
  const { onReordered, unmount } = renderTable();
  await act(async () => { await controllers[0]!.onDrop!(0, 1); });
  unmount();
  expect(onReordered).toHaveBeenCalledExactlyOnceWith(records);
});

test('a write completed after filtering its segment away still commits', async () => {
  let complete!: (records: Props['records']) => void;
  const write = new Promise<Props['records']>(resolve => { complete = resolve; });
  const { onReordered, unmount } = renderTable(async () => await write);
  const dropped = controllers[0]!.onDrop!(0, 1);
  unmount();
  await act(async () => { complete(records); await dropped; });
  expect(onReordered).toHaveBeenCalledExactlyOnceWith(records);
});

test('a detached failed drop exposes the original error and never commits', async () => {
  let reject!: (error: Error) => void;
  const write = new Promise<Props['records']>((_resolve, fail) => { reject = fail; });
  const { onReordered, onReorderError, unmount } = renderTable(async () => await write);
  const dropped = controllers[0]!.onDrop!(0, 1);
  const error = new Error('Write failed');
  const rejected = expect(dropped).rejects.toBe(error);
  unmount();
  await act(async () => { reject(error); await rejected; });
  expect(onReorderError).toHaveBeenCalledExactlyOnceWith(error);
  expect(onReordered).not.toHaveBeenCalled();
});
