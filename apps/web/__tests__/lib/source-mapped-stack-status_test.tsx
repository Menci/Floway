import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSourceMappedStack } from '../../src/lib/source-mapped-stack';
import { renderInApp } from '../render';
import { settle } from '../settle';

const SCRIPT = 'https://gateway.test/assets/chunk.js';
const RAW = `Error: boom\n    at handler (${SCRIPT}:1:1)`;

const MAP = {
  version: 3,
  file: 'chunk.js',
  sources: ['../../../src/first.ts'],
  names: [],
  mappings: 'AAAA',
};

function Probe({ stack }: { stack: string | undefined }) {
  const restoration = useSourceMappedStack(stack);
  return <output data-status={restoration.status}>{restoration.stack}</output>;
}

const read = () => {
  const node = screen.getByRole('status');
  return { status: node.dataset.status, stack: node.textContent };
};

describe('what the error page is told about its trace', () => {
  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://gateway.test/dashboard') as unknown as Location);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).endsWith('.map')
        ? new Response(JSON.stringify(MAP), { headers: { 'content-type': 'application/json' } })
        : new Response('const a=1;\n//# sourceMappingURL=chunk.js.map', { headers: { 'content-type': 'text/javascript' } }))));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('says nothing about a page that failed without a trace', async () => {
    vi.stubEnv('DEV', false);
    renderInApp(<Probe stack={undefined} />);
    await settle();
    expect(read()).toEqual({ status: 'settled', stack: '' });
  });

  it('leaves a development build alone, where the trace already names its sources', async () => {
    vi.stubEnv('DEV', true);
    renderInApp(<Probe stack={RAW} />);
    await settle();
    expect(read()).toEqual({ status: 'settled', stack: RAW });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the minified trace while the maps are still coming', () => {
    vi.stubEnv('DEV', false);
    renderInApp(<Probe stack={RAW} />);
    expect(read()).toEqual({ status: 'loading', stack: RAW });
  });

  it('replaces the trace once the maps land', async () => {
    vi.stubEnv('DEV', false);
    renderInApp(<Probe stack={RAW} />);
    await settle();
    expect(read()).toEqual({ status: 'settled', stack: 'Error: boom\n    at handler (/src/first.ts:1:1)' });
  });

  it('keeps the minified trace and says so when the maps cannot be read', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 503 }))));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderInApp(<Probe stack={RAW} />);
    await settle();
    expect(read()).toEqual({ status: 'failed', stack: RAW });
  });

  it('goes back to waiting when a second failure replaces the first', async () => {
    vi.stubEnv('DEV', false);
    const { rerender } = renderInApp(<Probe stack={RAW} />);
    await settle();
    const second = `Error: later\n    at other (${SCRIPT}:1:1)`;
    rerender(<Probe stack={second} />);
    expect(read()).toEqual({ status: 'loading', stack: second });
  });

  it('ignores a superseded restoration that finishes after the current one', async () => {
    vi.stubEnv('DEV', false);
    let releaseFirst = (_response: Response) => {};
    const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve; });
    let scriptRequestCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('.map')) {
        return Promise.resolve(new Response(JSON.stringify(MAP), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      scriptRequestCount += 1;
      return scriptRequestCount === 1
        ? firstResponse
        : Promise.resolve(new Response('const a=1;\n//# sourceMappingURL=chunk.js.map'));
    }));

    const { rerender } = renderInApp(<Probe stack={RAW} />);
    const second = `Error: later\n    at other (${SCRIPT}:1:1)`;
    rerender(<Probe stack={second} />);
    await settle();
    expect(read()).toEqual({ status: 'settled', stack: 'Error: later\n    at other (/src/first.ts:1:1)' });

    await act(async () => {
      releaseFirst(new Response('const a=1;\n//# sourceMappingURL=chunk.js.map'));
    });
    await settle();
    expect(read()).toEqual({ status: 'settled', stack: 'Error: later\n    at other (/src/first.ts:1:1)' });
  });
});
