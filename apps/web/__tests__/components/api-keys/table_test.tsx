import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { KeysTable } from '../../../src/components/api-keys/table';
import { i18n } from '../../../src/i18n';
import { localeForLanguage } from '../../../src/i18n/languages';
import { shortDate } from '../../../src/lib/format-time';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';

// Selecting a key is what the Agent Setup card below the table reads, so it is
// a deliberate act and not a side effect of reaching a row. Fluent raises the
// selection from a click anywhere in a selectable row, and a command button
// sits inside one, so editing, rotating, deleting or copying a key used to
// select it on the way.
const keys: ApiKey[] = [
  { id: 'first', name: 'First key', key: 'sk-first', upstream_ids: null, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, dump_retention_seconds: null, responses_retention_seconds: 0 },
  { id: 'second', name: 'Second key', key: 'sk-second', upstream_ids: null, created_at: '2026-01-02T00:00:00.000Z', last_used_at: null, dump_retention_seconds: null, responses_retention_seconds: 0 },
];

const clipboard = { copy: vi.fn(), outcomeFor: () => 'idle' as const };

const renderTable = (onSelect: (id: string) => void) => renderInApp(
  <KeysTable
    clipboard={clipboard}
    disabled={false}
    keys={keys}
    onDelete={vi.fn()}
    onEdit={vi.fn()}
    onRotate={vi.fn()}
    onSelect={onSelect}
    selectedKeyId=""
    upstreams={[]}
  />,
);

const clickButton = async (view: ReturnType<typeof renderTable>, name: string) => {
  const button = view.getAllByRole('button', { name }).at(-1);
  await act(async () => { button?.click(); });
};

describe('API keys table selection', () => {
  it('does not select the row a command was run from', async () => {
    const onSelect = vi.fn();
    const view = renderTable(onSelect);

    for (const label of ['actions.editNamed', 'actions.rotateNamed', 'actions.deleteNamed'] as const) {
      await clickButton(view, i18n.t(`dashboard.apiKeys.${label}`, { name: 'Second key' }));
    }
    await clickButton(view, i18n.t('dashboard.apiKeys.actions.copy'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the row a click landed on outside its commands', async () => {
    const onSelect = vi.fn();
    const view = renderTable(onSelect);

    await act(async () => { view.getByText('Second key').click(); });

    expect(onSelect).toHaveBeenCalledWith('second');
  });

  // The same table below the width where it becomes a list of rows, whose
  // commands are a menu rather than a strip of buttons. A menu popover is
  // portalled out of the row in the DOM but stays a React child of its trigger,
  // so a click on an item still reaches the row through React's own tree.
  describe('narrow', () => {
    stubMatchMedia(query => query === '(max-width: 760px)');

    it('does not select the row a menu command was run from', async () => {
      const onSelect = vi.fn();
      const view = renderTable(onSelect);

      await clickButton(view, i18n.t('dashboard.apiKeys.table.actions'));
      await act(async () => { view.getByRole('menuitem', { name: i18n.t('dashboard.apiKeys.actions.edit') }).click(); });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('selects the row a click landed on outside its menu', async () => {
      const onSelect = vi.fn();
      const view = renderTable(onSelect);

      await act(async () => { view.getByText('Second key').click(); });

      expect(onSelect).toHaveBeenCalledWith('second');
    });

    // The wide table heads the cell with Last Used; the list has no header, so
    // a date old enough to lose its relative phrase would sit beside the
    // created date as a second bare date.
    it('names what a date too old for a relative phrase is the date of', () => {
      const view = renderInApp(
        <KeysTable
          clipboard={clipboard}
          disabled={false}
          keys={[{ ...keys[0]!, last_used_at: '2020-02-15T00:00:00.000Z' }]}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onRotate={vi.fn()}
          onSelect={vi.fn()}
          selectedKeyId=""
          upstreams={[]}
        />,
      );

      expect(view.getByText(i18n.t('dashboard.apiKeys.table.usedOn', {
        date: shortDate('2020-02-15T00:00:00.000Z', localeForLanguage(i18n.language)),
      }))).toBeTruthy();
    });
  });
});
