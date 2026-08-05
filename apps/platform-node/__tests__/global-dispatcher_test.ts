import { Agent, EnvHttpProxyAgent } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { createNodeGlobalDispatcher, nodePoolOptions } from '../src/global-dispatcher.ts';

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
});
