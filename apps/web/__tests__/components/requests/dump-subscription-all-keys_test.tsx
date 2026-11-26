import { act, fireEvent, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { record, stubEventSource } from './dump-stream-stub';
import { flowayTokenStorageKey } from '../../../src/auth/session';
import { useDumpSubscription } from '../../../src/components/requests/use-dump-subscription';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const keyRef = { id: 'key-b', name: 'Key B', suffix: 'bbb2' };
const withKey = (id: string, key: DumpMetadata['key']): DumpMetadata => ({ ...record(id), key });

const Harness = () => {
  const subscription = useDumpSubscription({ keyId: null, keyIds: ['key-a', 'key-b'] }, [record('seed')]);
  return <section aria-label="Requests">
    <button onClick={() => void subscription.loadOlder()}>older</button>
    <ul>{subscription.records.map(entry => <li key={entry.id}>{entry.path}</li>)}</ul>
  </section>;
};

describe('all-keys dump subscription', () => {
  const storage = stubLocalStorage();
  const stream = stubEventSource();

  beforeEach(() => { storage.set(flowayTokenStorageKey, 'session-token'); });

  it('opens the merged stream rather than any key\'s', () => {
    renderInApp(<StrictMode><Harness /></StrictMode>);

    expect(stream.liveSource().url).toContain('/api/dump/stream?');
  });

  it('follows the merged snapshot and appended frames', () => {
    renderInApp(<StrictMode><Harness /></StrictMode>);

    act(() => {
      stream.liveSource().emit('snapshot', JSON.stringify({ records: [withKey('snap', keyRef)] }));
    });
    expect(screen.getByText('/v1/snap')).toBeTruthy();

    act(() => {
      stream.liveSource().emit('appended', JSON.stringify(withKey('live', keyRef)));
    });
    expect(screen.getByText('/v1/live')).toBeTruthy();
  });

  it('pages the merged log through the all-keys endpoint', async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL) => Response.json({ records: [] }));
    vi.stubGlobal('fetch', fetchStub);
    renderInApp(<StrictMode><Harness /></StrictMode>);

    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await act(async () => { await Promise.resolve(); });

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain('/api/dump/records?');
    expect(url).toContain('before=seed');
    vi.unstubAllGlobals();
  });
});
