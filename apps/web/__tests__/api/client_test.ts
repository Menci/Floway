import { describe, expect, it } from 'vitest';

import { callApi } from '../../src/api/client';

const respond = (response: Response) => () => Promise.resolve(response);

describe('callApi', () => {
  it('surfaces the gateway error message from a failed response', async () => {
    const result = await callApi(respond(Response.json({ error: 'Alias not found' }, { status: 404 })));
    expect(result.error).toEqual({ status: 404, message: 'Alias not found', raw: { error: 'Alias not found' } });
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
});
