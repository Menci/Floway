import assert from 'node:assert/strict';

import { cloudflareFetch } from '../../src/fetch.ts';
import { cloudflareSocketDial } from '../../src/socket-dial.ts';
import { sendHttpRequest } from '@floway-dev/http';

interface Env { ORIGIN: string }

const send = (url: string, signal: AbortSignal) =>
  sendHttpRequest(cloudflareFetch, { url, method: 'GET', headers: [], body: null }, signal);

export const abortFetchHead = {
  async test(_controller: unknown, env: Env) {
    const caller = new AbortController();
    const response = send(`${env.ORIGIN}/head`, caller.signal);
    await cloudflareFetch(`${env.ORIGIN}/observed-head`, {});
    const reason = new Error('cancel while waiting for headers');
    caller.abort(reason);
    const result = await response;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected fetch to be cancelled');
    assert.equal(result.error.kind, 'abort');
    assert.equal((result.error.cause as Error).cause, reason);
  },
};

export const abortFetchBody = {
  async test(_controller: unknown, env: Env) {
    for (const phase of ['before', 'pending', 'between'] as const) {
      const caller = new AbortController();
      const result = await send(`${env.ORIGIN}/stall`, caller.signal);
      assert.equal(result.ok, true);
      if (!result.ok || result.value.body === null) throw new Error('expected a streaming response');
      assert.equal(result.value.status, 200);
      const body = result.value.body;
      if (phase !== 'before') {
        const first = await body.next();
        if (first.done || !first.value.ok) throw new Error('expected response bytes');
        assert.equal(new TextDecoder().decode(first.value.value), 'prefix');
      }
      const pending = phase === 'pending' ? body.next() : undefined;
      const reason = new Error(`cancel ${phase}`);
      caller.abort(reason);
      const terminal = await (pending ?? body.next());
      if (terminal.done || terminal.value.ok) throw new Error('expected a terminal abort');
      assert.equal(terminal.value.error.kind, 'abort');
      assert.equal((terminal.value.error.cause as Error).cause, reason);
      assert.equal((await body.next()).done, true);
    }
  },
};

export const tagFetchBodyLoss = {
  async test(_controller: unknown, env: Env) {
    const caller = new AbortController();
    const response = await cloudflareFetch(`${env.ORIGIN}/loss`, { signal: caller.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'prefix');
    const rejected = reader.read().catch((cause: unknown) => cause);
    await cloudflareFetch(`${env.ORIGIN}/drop`, {});
    const failure = await rejected;
    const classified = response.classifyBodyFailure?.(failure);
    assert.equal(classified?.kind, 'transport', String(failure));
    assert.equal(classified.cause, failure);
    caller.abort(new Error('late cancellation'));
    await assert.rejects(reader.read(), (cause: unknown) => {
      assert.equal(cause, failure);
      return true;
    });
  },
};

export const abortSocketRead = {
  async test(_controller: unknown, env: Env) {
    const url = new URL(env.ORIGIN);
    const caller = new AbortController();
    const socket = await cloudflareSocketDial.connect(url.hostname, Number(url.port), { signal: caller.signal });
    const reader = socket.readable.getReader();
    const pending = reader.read();
    const reason = new Error('cancel pending socket read');
    caller.abort(reason);
    await assert.rejects(pending, (cause: unknown) => {
      assert.equal(cause, reason);
      return true;
    });
    reader.releaseLock();
    await socket.close();
  },
};

export const preserveUploadFailure = {
  async test(_controller: unknown, env: Env) {
    for (const replay of [false, true]) {
      const bug = Object.assign(new Error('Network connection lost.'), { retryable: true });
      let failed = false;
      const open = () => new ReadableStream<Uint8Array>({
        pull(controller) {
          failed = true;
          controller.error(bug);
        },
      });
      await assert.rejects(cloudflareFetch(`${env.ORIGIN}/upload`, {
        method: 'POST', body: replay ? { contentLength: 10, open } : open(),
      }), (cause: unknown) => {
        assert.equal(cause, bug);
        return true;
      });
      assert.equal(failed, true);
    }
  },
};

export const preserveActiveUploadFailureAfterHead = {
  async test(_controller: unknown, env: Env) {
    for (const replay of [false, true]) {
      const pulling = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const bug = new TypeError('second upload chunk violated an invariant');
      let sent = false;
      const open = () => new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array([120]));
            return;
          }
          pulling.resolve();
          await release.promise;
          throw bug;
        },
      }, { highWaterMark: 0 });
      const upload = replay ? { contentLength: 2, open } : open();
      const url = `${env.ORIGIN}/duplex-upload`;
      const result = await sendHttpRequest(
        (target, init) => cloudflareFetch(target, { ...init, body: upload }),
        { url, method: 'POST', headers: [], body: null },
        new AbortController().signal,
      );
      if (!result.ok || result.value.body === null) throw new Error('expected a streaming response');
      assert.equal(result.value.status, 200);
      const body = result.value.body;
      const first = await body.next();
      if (first.done || !first.value.ok) throw new Error('expected valid response bytes');
      assert.equal(new TextDecoder().decode(first.value.value), 'a');
      await pulling.promise;
      const pending = body.next();
      release.resolve();
      await assert.rejects(pending, (cause: unknown) => {
        assert.equal(cause, bug);
        return true;
      });
    }
  },
};

export const fixedLengthUpload = {
  async test(_controller: unknown, env: Env) {
    const response = await cloudflareFetch(`${env.ORIGIN}/upload`, {
      method: 'POST',
      body: { contentLength: 7, open: () => new Blob(['payload']).stream() },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-observed-length'), '7');
    assert.equal(await response.text(), 'payload');
  },
};
