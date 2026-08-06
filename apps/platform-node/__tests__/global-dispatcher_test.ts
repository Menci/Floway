import { createServer } from 'node:http';

import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { createNodeGlobalDispatcher, nodePoolOptions } from '../src/global-dispatcher.ts';
import { directFetcher } from '@floway-dev/provider';

describe('Node global dispatcher', () => {
  it('uses the direct agent when no proxy environment is configured', async () => {
    const dispatcher = createNodeGlobalDispatcher({});
    try {
      expect(dispatcher).toBeInstanceOf(Agent);
    } finally {
      await dispatcher.close();
    }
  });

  it.each([
    ['http_proxy', { http_proxy: 'http://audit-user:audit-secret@127.0.0.1:3128' }],
    ['HTTP_PROXY', { HTTP_PROXY: 'http://audit-user:audit-secret@127.0.0.1:3128' }],
    ['https_proxy', { https_proxy: 'http://audit-user:audit-secret@127.0.0.1:3128' }],
    ['HTTPS_PROXY', { HTTPS_PROXY: 'http://audit-user:audit-secret@127.0.0.1:3128' }],
  ] as const)('honours %s without logging proxy credentials', async (_name, env) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dispatcher = createNodeGlobalDispatcher({
      ...env,
      no_proxy: 'localhost',
    });
    try {
      expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await dispatcher.close();
      log.mockRestore();
    }
  });

  it('disables keep-alive only for the Copilot data-plane host family', () => {
    const options = { connections: 3, pipelining: 2 };

    expect(nodePoolOptions('https://api.individual.githubcopilot.com', options)).toEqual({
      connections: 3,
      pipelining: 0,
    });
    expect(nodePoolOptions(new URL('https://githubcopilot.com'), options)).toEqual({
      connections: 3,
      pipelining: 0,
    });
    expect(nodePoolOptions('https://example.com', options)).toBe(options);
    expect(options).toEqual({ connections: 3, pipelining: 2 });
  });

  it('normalizes explicit framing before Node global fetch crosses into the installed dispatcher', async () => {
    let receivedBody: number[] | undefined;
    let receivedContentLength: string | undefined;
    let receivedTransferEncoding: string | undefined;
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = [];
      request.on('data', chunk => { chunks.push(chunk as Uint8Array); });
      request.on('end', () => {
        receivedBody = chunks.flatMap(chunk => [...chunk]);
        receivedContentLength = request.headers['content-length'];
        receivedTransferEncoding = request.headers['transfer-encoding'];
        response.writeHead(200, { 'content-length': '0' });
        response.end();
      });
    });
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('test server has no TCP address');
        resolve(address.port);
      });
    });
    const previous = getGlobalDispatcher();
    const dispatcher = createNodeGlobalDispatcher({});
    setGlobalDispatcher(dispatcher);
    try {
      const response = await directFetcher(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-length': '999', 'transfer-encoding': 'chunked' },
        body: Uint8Array.of(1, 2, 3),
      });

      expect(response.status).toBe(200);
      expect(receivedBody).toEqual([1, 2, 3]);
      expect(receivedContentLength).toBe('3');
      expect(receivedTransferEncoding).toBeUndefined();
    } finally {
      setGlobalDispatcher(previous);
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
      });
    }
  });
});
