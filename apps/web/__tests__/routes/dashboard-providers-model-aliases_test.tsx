import { act, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardProvidersModelAliases from '../../src/routes/dashboard-providers-model-aliases';
import { REPOSITION_ANIMATION_MS } from '../../src/winui/motion';
import { renderInApp } from '../render';
import type { ModelAlias } from '@floway-dev/protocols/common';

const mocks = vi.hoisted(() => ({
  aliasList: vi.fn(),
  modelList: vi.fn(),
  aliasUpdate: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    api: {
      aliases: { $get: mocks.aliasList, ':id': { $put: mocks.aliasUpdate } },
      models: { $get: mocks.modelList },
    },
  },
  callApi: (operation: () => unknown) => operation(),
  callApiNoContent: (operation: () => unknown) => operation(),
}));

const aliases: ModelAlias[] = ['alpha', 'bravo', 'charlie'].map((name, index) => ({
  id: `alias_${name}`,
  name,
  kind: 'chat',
  selection: 'first-available',
  display_name: name[0].toUpperCase() + name.slice(1),
  visible_in_models_list: true,
  targets: [{ target_model_id: 'model', rules: {} }],
  announced_metadata: null,
  sort_order: [10, 30, 50][index],
  created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
  updated_at: `2026-01-0${index + 1}T00:00:00.000Z`,
}));

const loaderData = {
  catalog: { aliases, models: [] },
  error: null,
  modelsError: null,
};

const originalRect = Element.prototype.getBoundingClientRect;
const ROW_HEIGHT = 56;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-reorder-list')) {
      return { bottom: ROW_HEIGHT * this.children.length, height: ROW_HEIGHT * this.children.length, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 } as DOMRect;
    }
    if (this.hasAttribute('data-reorder-item') && this.parentElement) {
      const top = [...this.parentElement.children].indexOf(this) * ROW_HEIGHT;
      return { bottom: top + ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0, top, width: 0, x: 0, y: top } as DOMRect;
    }
    return originalRect.call(this);
  };
});

afterAll(() => { Element.prototype.getBoundingClientRect = originalRect; });
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

const renderPage = () => renderInApp(<OutcomeToastProvider><DashboardProvidersModelAliases
  loaderData={loaderData}
  matches={[] as never}
  params={{}}
/></OutcomeToastProvider>);

const listedNames = () => [...document.querySelectorAll('tbody tr')].map(row => row.querySelector('td')?.textContent ?? '');
const grip = (name: string) => screen.getByRole('button', { name: `Reorder alias ${name}` });

describe('model alias list order', () => {
  it('lets the keyboard reorder aliases and writes their normalized sort order', async () => {
    mocks.aliasUpdate.mockImplementation(async ({ param, json }: { param: { id: string }; json: { sort_order: number } }) => ({
      data: { ...aliases.find(alias => alias.id === param.id)!, sort_order: json.sort_order },
    }));
    renderPage();

    const alphaGrip = grip('alpha');
    expect(alphaGrip.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
    await act(async () => { fireEvent.keyDown(alphaGrip, { key: 'ArrowDown', altKey: true, shiftKey: true }); });

    expect(listedNames().map(name => name.includes('Alpha') ? 'alpha' : name.includes('Bravo') ? 'bravo' : 'charlie')).toEqual(['bravo', 'alpha', 'charlie']);
    expect(mocks.aliasUpdate.mock.calls.map(([request]) => [request.param.id, request.json.sort_order])).toEqual([
      ['alias_bravo', 0], ['alias_alpha', 1], ['alias_charlie', 2],
    ]);
  });

  it('persists a pointer drag before committing the displayed order', async () => {
    vi.useFakeTimers();
    mocks.aliasUpdate.mockImplementation(async ({ param, json }: { param: { id: string }; json: { sort_order: number } }) => ({
      data: { ...aliases.find(alias => alias.id === param.id)!, sort_order: json.sort_order },
    }));
    renderPage();
    const alphaGrip = grip('alpha');

    fireEvent.pointerDown(alphaGrip, { button: 0, clientY: 20, isPrimary: true, pointerId: 1 });
    expect(document.querySelector('tbody')?.hasAttribute('data-reordering')).toBe(true);
    fireEvent.pointerMove(window, { clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 150, pointerId: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPOSITION_ANIMATION_MS); });

    expect(mocks.aliasUpdate).toHaveBeenCalledTimes(3);
    expect(mocks.aliasUpdate.mock.calls.map(([request]) => [request.param.id, request.json.sort_order])).toEqual([
      ['alias_bravo', 0], ['alias_charlie', 1], ['alias_alpha', 2],
    ]);
    expect(listedNames().map(name => name.includes('Alpha') ? 'alpha' : name.includes('Bravo') ? 'bravo' : 'charlie')).toEqual(['bravo', 'charlie', 'alpha']);
  });
});
