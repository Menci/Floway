import { act, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { record, stubEventSource } from './dump-stream-stub';
import { flowayTokenStorageKey } from '../../../src/auth/session';
import { useDumpSubscription } from '../../../src/components/requests/use-dump-subscription';
import { setLanguage } from '../../../src/i18n';
import { browserLanguage } from '../../../src/i18n/languages';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

const Harness = ({ keyId }: { keyId: string }) => {
  const subscription = useDumpSubscription(keyId, [record(`${keyId}-1`)]);
  return (
    <section aria-label="Requests">
      {subscription.error ? <p>{subscription.error}</p> : null}
      <ul>{subscription.records.map(entry => <li key={entry.id}>{entry.path}</li>)}</ul>
    </section>
  );
};

describe('dump subscription language change', () => {
  const storage = stubLocalStorage();
  const stream = stubEventSource();

  beforeEach(async () => {
    storage.set(flowayTokenStorageKey, 'session-token');
    // The disconnect path asks for the session, which is where an expired one
    // ends the session; the suite is about the stream, so the call answers.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"user":null}', { status: 200 })));
    await act(async () => { await setLanguage('en'); });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps the stream open when the language changes under it', async () => {
    renderInApp(<StrictMode><Harness keyId="key-a" /></StrictMode>);
    const opened = stream.sources.length;
    const live = stream.liveSource();

    await act(async () => { await setLanguage('zh-Hans'); });

    expect(stream.sources.length).toBe(opened);
    expect(stream.liveSource()).toBe(live);
  });

  // BrowserLanguageSync applies the visitor's language once the tree is
  // mounted, and i18next announces the change whether or not the language it
  // lands on differs from the one it booted in.
  it('keeps the stream open when boot re-applies the language it already has', async () => {
    renderInApp(<StrictMode><Harness keyId="key-a" /></StrictMode>);
    const opened = stream.sources.length;

    await act(async () => { await setLanguage(browserLanguage()); });

    expect(stream.sources.length).toBe(opened);
  });

  it('reports a disconnect in the language the dashboard is now in', async () => {
    renderInApp(<StrictMode><Harness keyId="key-a" /></StrictMode>);

    await act(async () => { await setLanguage('zh-Hans'); });
    stream.liveSource().drop();

    expect(screen.getByText('请求流已断开。')).toBeTruthy();
  });
});
