import { describe, expect, it } from 'vitest';

import { callApi, callApiNoContent } from '../../src/api/client';
import { isAbortError } from '../../src/lib/error-message';

const respond = (response: Response) => () => Promise.resolve(response);

describe('callApi', () => {
  it('parses a JSON body on a 200', async () => {
    const result = await callApi(respond(Response.json({ id: 'alias_1' })));
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ id: 'alias_1' });
  });

  it('surfaces the gateway error message from a failed response', async () => {
    const result = await callApi(respond(Response.json({ error: 'Alias not found' }, { status: 404 })));
    expect(result.error).toEqual({ status: 404, message: 'Alias not found', raw: { error: 'Alias not found' } });
  });

  it('falls back to the status line when the failure carries no JSON body', async () => {
    const result = await callApi(respond(new Response(null, { status: 502 })));
    expect(result.error?.status).toBe(502);
    expect(result.error?.message).toBe('HTTP 502');
  });

  it('reports a malformed body on a status that promised one', async () => {
    const result = await callApi(respond(new Response('not json', { status: 200 })));
    expect(result.error?.status).toBe(200);
    expect(result.data).toBeUndefined();
  });

  it('reports a body-less 204 as an error, which is what callApiNoContent exists to avoid', async () => {
    const result = await callApi(respond(new Response(null, { status: 204 })));
    expect(result.data).toBeUndefined();
    expect(result.error?.status).toBe(204);
  });

  it('reports a transport failure as status 0 and keeps what was thrown', async () => {
    const thrown = new Error('network down');
    const result = await callApi(() => Promise.reject(thrown));
    expect(result.error).toEqual({ status: 0, message: 'network down', cause: thrown });
  });

  it('keeps an abort distinguishable from any other transport failure', async () => {
    const result = await callApi(() => Promise.reject(AbortSignal.abort().reason));
    expect(result.error?.status).toBe(0);
    expect(isAbortError(result.error?.cause)).toBe(true);
  });
});

describe('callApiNoContent', () => {
  it('reports a 204 as a success', async () => {
    const result = await callApiNoContent(respond(new Response(null, { status: 204 })));
    expect(result.error).toBeUndefined();
    expect(result.data).toBeUndefined();
  });

  it('surfaces a failure the same way callApi does', async () => {
    const result = await callApiNoContent(respond(Response.json({ error: 'Proxy is referenced by upstreams' }, { status: 409 })));
    expect(result.error?.status).toBe(409);
    expect(result.error?.message).toBe('Proxy is referenced by upstreams');
    expect(result.error?.raw).toEqual({ error: 'Proxy is referenced by upstreams' });
  });

  it('reports a transport failure as status 0 and keeps what was thrown', async () => {
    const thrown = new Error('network down');
    const result = await callApiNoContent(() => Promise.reject(thrown));
    expect(result.error).toEqual({ status: 0, message: 'network down', cause: thrown });
  });
});
