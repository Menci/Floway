import { describe, expect, it } from 'vitest';

import { callApi } from '../../src/api/client.ts';

const respond = (response: Response) => () => Promise.resolve(response);

describe('callApi', () => {
  it('reports a 204 as a success carrying no data', async () => {
    const result = await callApi(respond(new Response(null, { status: 204 })));
    expect(result.error).toBeUndefined();
    expect(result.data).toBeUndefined();
  });

  it('parses a JSON body on a 200', async () => {
    const result = await callApi<{ id: string }>(respond(Response.json({ id: 'alias_1' })));
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ id: 'alias_1' });
  });

  it('surfaces the gateway error message from a failed response', async () => {
    const result = await callApi(respond(Response.json({ error: 'Alias not found' }, { status: 404 })));
    expect(result.error).toEqual({ status: 404, message: 'Alias not found', raw: { error: 'Alias not found' } });
  });

  it('reports a malformed body on a status that promised one', async () => {
    const result = await callApi(respond(new Response('not json', { status: 200 })));
    expect(result.error?.status).toBe(200);
    expect(result.data).toBeUndefined();
  });

  it('reports a transport failure as status 0', async () => {
    const result = await callApi(() => Promise.reject(new Error('network down')));
    expect(result.error).toEqual({ status: 0, message: 'network down' });
  });
});
