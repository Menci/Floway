import { fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { BatchExport } from '../../../src/components/requests/batch-export';
import { renderInApp } from '../../render';

it('keeps export actions in a menu and preserves selections outside the loaded filter', () => {
  const onChange = vi.fn();
  renderInApp(<BatchExport keyId="key" selected={new Set(['loaded', 'outside'])} loadedIds={['loaded']} onChange={onChange} />);
  expect(screen.queryByRole('menuitem', { name: 'Combined JSON' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Export 2 selected' }));
  expect(screen.getByRole('menuitem', { name: 'Combined JSON' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Separate files (.tar)' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select loaded records' }));
  expect(onChange).toHaveBeenLastCalledWith(new Set(['outside']));
});
