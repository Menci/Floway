import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useAccessResolution } from '../../../src/components/access-control/resolution';
import { renderInApp } from '../../render';
import type { AccessPrincipal, AccessScope } from '@floway-dev/gateway/browser';

const principal: AccessPrincipal = { kind: 'group', id: 3 };
const scope: AccessScope = { kind: 'upstream', upstreamId: 'up_a' };
const response = (value: boolean) => Response.json({ values: { 'Model.Use': value }, records: [], decisions: [] });
const Harness = (props: Parameters<typeof useAccessResolution>[0]) => {
  const result = useAccessResolution(props);
  return <output data-testid="result">{JSON.stringify(result)}</output>;
};
const result = () => JSON.parse(screen.getByTestId('result').textContent!);
afterEach(() => vi.unstubAllGlobals());

test('resolves group scopes and excludes the edited record without duplicate requests for equal inputs', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(true));
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderInApp(<Harness enabled excludeRecordId={7} principal={principal} scope={scope} />);
  await waitFor(() => expect(result().data?.values['Model.Use']).toBe(true));
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ principal, scope, excludeRecordId: 7 });
  rerender(<Harness enabled excludeRecordId={7} principal={{ ...principal }} scope={{ ...scope }} />);
  expect(fetch).toHaveBeenCalledOnce();
});

test('aborts stale requests and ignores a late result after the target changes', async () => {
  const requests: Array<{ signal: AbortSignal; complete: (response: Response) => void }> = [];
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(complete => requests.push({ signal: init!.signal!, complete })));
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderInApp(<Harness enabled principal={principal} scope={scope} />);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(result().pending).toBe(true);
  rerender(<Harness enabled principal={principal} scope={{ kind: 'upstreams' }} />);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => { requests[1]!.complete(response(false)); });
  await waitFor(() => expect(result().data?.values['Model.Use']).toBe(false));
  await act(async () => { requests[0]!.complete(response(true)); });
  expect(result().data.values['Model.Use']).toBe(false);
});

test('disabled or root selections never request inherited values', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderInApp(<Harness enabled principal={principal} scope={null} />);
  expect(result()).toEqual({ data: null, error: null, pending: false });
  rerender(<Harness enabled={false} principal={principal} scope={scope} />);
  expect(fetch).not.toHaveBeenCalled();
});

test('resolution failures expose an error without inventing values', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Resolution unavailable' }, { status: 503 })));
  renderInApp(<Harness enabled principal={principal} scope={scope} />);
  await waitFor(() => expect(result()).toEqual({ data: null, error: 'Resolution unavailable', pending: false }));
});
