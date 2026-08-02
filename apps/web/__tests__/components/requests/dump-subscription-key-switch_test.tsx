import { act, screen } from '@testing-library/react';
import { StrictMode, useLayoutEffect, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowayTokenStorageKey } from '../../../src/auth/session';
import { useDumpSubscription } from '../../../src/components/requests/use-dump-subscription';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const record = (id: string): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 0,
  method: 'POST',
  path: `/v1/${id}`,
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  error: null,
});

type Lifecycle = { event: 'open' | 'close'; keyId: string };

const lifecycle: Lifecycle[] = [];
const sources: StubEventSource[] = [];

class StubEventSource {
  static readonly CLOSED = 2;

  readyState = 1;
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    sources.push(this);
    lifecycle.push({ event: 'open', keyId: this.keyId });
  }

  get keyId(): string {
    return decodeURIComponent(new URL(this.url, 'https://dashboard.test').pathname.split('/')[4] ?? '');
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.readyState === StubEventSource.CLOSED) return;
    this.readyState = StubEventSource.CLOSED;
    lifecycle.push({ event: 'close', keyId: this.keyId });
  }

  emit(type: string, data: string): void {
    act(() => {
      this.listeners.get(type)?.forEach(listener => { listener(new MessageEvent(type, { data })); });
    });
  }
}

const liveSource = (): StubEventSource => {
  const open = sources.filter(source => source.readyState !== StubEventSource.CLOSED);
  expect(open).toHaveLength(1);
  return open[0]!;
};

interface Commit { ids: string[]; keyId: string | null }
interface Selection { keyId: string | null; seed: DumpMetadata[] }

// Selecting a key updates the route's state and its loader data in place; the
// hook is never unmounted in between. Feeding the harness from a store rather
// than re-rendering it keeps that true, since a re-render through Testing
// Library would drop the app provider and remount the tree.
const createSelection = (initial: Selection) => {
  const listeners = new Set<() => void>();
  let current = initial;
  return {
    read: () => current,
    show: (keyId: string | null, seed: DumpMetadata[]) => {
      current = { keyId, seed };
      act(() => { listeners.forEach(listener => { listener(); }); });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

const Harness = ({ commits, selection }: { commits: Commit[]; selection: ReturnType<typeof createSelection> }) => {
  const { keyId, seed } = useSyncExternalStore(selection.subscribe, selection.read);
  const subscription = useDumpSubscription(keyId, seed);
  const ids = subscription.records.map(entry => entry.id);
  // Logging from a layout effect rather than from the render body is what makes
  // the render-phase reset observable: a render React throws away never
  // commits, so anything this sees is something the user could have seen.
  useLayoutEffect(() => { commits.push({ ids, keyId }); });
  return (
    <section aria-label={`Requests for ${keyId ?? 'no key'}`}>
      <ul>{subscription.records.map(entry => <li key={entry.id}>{entry.path}</li>)}</ul>
    </section>
  );
};

const renderSubscription = (keyId: string | null, seed: DumpMetadata[]) => {
  const commits: Commit[] = [];
  const selection = createSelection({ keyId, seed });
  renderInApp(<StrictMode><Harness commits={commits} selection={selection} /></StrictMode>);
  return { commits, show: selection.show };
};

describe('dump subscription key switch', () => {
  const storage = stubLocalStorage();
  const originalEventSource = Reflect.getOwnPropertyDescriptor(globalThis, 'EventSource');

  beforeEach(() => {
    storage.set(flowayTokenStorageKey, 'session-token');
    lifecycle.length = 0;
    sources.length = 0;
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: StubEventSource, writable: true });
  });

  afterEach(() => {
    if (originalEventSource) Object.defineProperty(globalThis, 'EventSource', originalEventSource);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });

  it('never shows one key\'s records under another key\'s heading', () => {
    const { commits, show } = renderSubscription('key-a', [record('key-a-1')]);
    liveSource().emit('appended', JSON.stringify(record('key-a-2')));
    expect(screen.getByText('/v1/key-a-2')).toBeTruthy();

    show('key-b', [record('key-b-1')]);

    expect(screen.getByRole('region', { name: 'Requests for key-b' })).toBeTruthy();
    expect(screen.queryByText('/v1/key-a-1')).toBeNull();
    expect(screen.queryByText('/v1/key-a-2')).toBeNull();
    expect(screen.getByText('/v1/key-b-1')).toBeTruthy();
    // Every record id carries its own key, so a commit holding a foreign id is
    // exactly the frame a user would have seen under the wrong heading.
    const foreign = commits.filter(commit => commit.ids.some(id => !id.startsWith(commit.keyId ?? '')));
    expect(foreign).toEqual([]);
  });

  it('closes the stream it is leaving before opening the next one', () => {
    const { show } = renderSubscription('key-a', [record('key-a-1')]);
    show('key-b', [record('key-b-1')]);

    // StrictMode tears the subscription down and reopens it, so the run is
    // several streams long; what has to hold is that it is never two at once.
    expect(sources.length).toBeGreaterThan(1);
    expect(lifecycle.map(entry => entry.event)).toEqual(lifecycle.map((_, index) => (index % 2 === 0 ? 'open' : 'close')));
    expect(sources.filter(source => source.readyState !== StubEventSource.CLOSED).map(source => source.keyId)).toEqual(['key-b']);
  });

  it('does not append a record twice when the reopened stream replays it', () => {
    const { show } = renderSubscription('key-a', [record('key-a-1')]);
    liveSource().emit('appended', JSON.stringify(record('key-a-2')));

    show('key-b', [record('key-b-1')]);
    // The loader re-runs on the way back, so the seed for key-a now carries the
    // record that arrived over the stream the first time round.
    show('key-a', [record('key-a-2'), record('key-a-1')]);
    liveSource().emit('appended', JSON.stringify(record('key-a-2')));

    expect(screen.getAllByText('/v1/key-a-2')).toHaveLength(1);
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['/v1/key-a-2', '/v1/key-a-1']);
  });

  it('throws when the session token is gone', () => {
    storage.delete(flowayTokenStorageKey);

    expect(() => renderSubscription('key-a', [record('key-a-1')])).toThrow('Authenticated dump subscription has no session token');
    expect(sources).toEqual([]);
  });
});
