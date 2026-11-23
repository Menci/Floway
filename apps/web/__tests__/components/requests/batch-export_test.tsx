import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { BatchExport } from '../../../src/components/requests/batch-export';
import { renderInApp } from '../../render';

afterEach(() => { vi.unstubAllGlobals(); });

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

it('loads metadata and NDJSON artifacts together before downloading', async () => {
  const events = '{"k":"run","seq":1,"tMs":0,"runId":"r","pipeline":"p","startedAt":0}\n{"k":"done","seq":2,"tMs":1,"ok":true}\n';
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/records/loaded/artifact')) return new Response(events, { status: 200 });
    return Response.json({
      meta: { id: 'loaded', startedAt: 0, completedAt: 1, method: 'POST', path: '/v1/x', status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1, error: null },
    });
  }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  renderInApp(<BatchExport keyId="key" selected={new Set(['loaded'])} loadedIds={['loaded']} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export 1 selected' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Combined JSON' }));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
  expect(fetched.some(url => url.endsWith('/records/loaded/artifact'))).toBe(true);
});
