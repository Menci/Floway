import { DurableObject } from 'cloudflare:workers';

const PROBE_KEY = '__floway_deployment_probe_missing__';
const ONE_PIXEL_GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const imageStream = () => {
  const bytes = Uint8Array.from(atob(ONE_PIXEL_GIF), character => character.charCodeAt(0));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

const checks = {
  DB: async (env) => {
    const row = await env.DB.prepare('SELECT 1 AS value').first();
    if (row?.value !== 1) throw new Error(`D1 returned ${JSON.stringify(row)} for SELECT 1`);
  },
  FILES: async (env) => {
    await env.FILES.head(PROBE_KEY);
  },
  IMAGES: async (env) => {
    const info = await env.IMAGES.info(imageStream());
    if (!('width' in info) || info.width !== 1 || info.height !== 1) {
      throw new Error(`Images returned ${JSON.stringify(info)}`);
    }
  },
  KV: async (env) => {
    await env.KV.get(PROBE_KEY);
  },
  BROADCAST_DO: async (env) => {
    const id = env.BROADCAST_DO.idFromName(PROBE_KEY);
    const response = await env.BROADCAST_DO.get(id).fetch(new Request('https://deployment-probe.internal/'));
    if (!response.ok || await response.text() !== 'Hello World') {
      throw new Error(`Durable Object probe returned HTTP ${response.status}`);
    }
  },
};

const probe = async env => Promise.all(Object.values(checks).map(check => check(env)));

export class BroadcastDO extends DurableObject {
  fetch() {
    return new Response('Hello World');
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/deployment-probe') return new Response('Not Found', { status: 404 });

    try {
      await probe(env);
      return new Response('Hello World', {
        headers: { 'x-floway-binding-probe': 'DB,FILES,IMAGES,KV,BROADCAST_DO' },
      });
    } catch (error) {
      const detail = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { value: String(error) };
      return Response.json({ message: 'Binding probe failed', error: detail }, { status: 500 });
    }
  },
  scheduled() {
    return undefined;
  },
};
