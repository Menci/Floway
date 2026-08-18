import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExecutionContext } from 'hono';

type FetchHandler = (request: Request, env?: object, executionCtx?: ExecutionContext) => Promise<Response> | Response;

const gatewayPathPrefixes = [
  '/api/',
  '/auth/',
  '/v1/',
  '/v2/',
  '/v1beta/',
  '/jina/',
  '/voyage/',
  '/azure-api.codex/',
] as const;

const gatewayPaths = new Set([
  '/api',
  '/auth',
  '/favicon.ico',
  '/v1',
  '/v2',
  '/v1beta',
  '/jina',
  '/voyage',
  '/azure-api.codex',
  '/alpha/search',
  '/completions',
  '/chat/completions',
  '/responses',
  '/responses/compact',
  '/messages',
  '/messages/count_tokens',
  '/embeddings',
  '/models',
  '/images/generations',
  '/images/edits',
]);

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// React Router emits browser assets into dist/client. The sibling dist/server
// tree is build-time machinery, not a browser-served application.
const defaultNodeWebDistDir = fileURLToPath(new URL('../../web/dist/client/', import.meta.url));

const isGatewayPath = (pathname: string): boolean =>
  gatewayPaths.has(pathname) || gatewayPathPrefixes.some(prefix => pathname.startsWith(prefix));

const isStaticAssetPath = (pathname: string): boolean =>
  pathname.startsWith('/assets/') || extname(pathname) !== '';

const responseFromFile = async (path: string, requestMethod: string, immutable: boolean): Promise<Response | null> => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const headers = new Headers({
      'content-type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (requestMethod === 'HEAD') return new Response(null, { headers });
    return new Response(await readFile(path), { headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export interface StaticWebOptions {
  distDir: string;
}

// The Node target shares one origin between the gateway and dashboard. API
// prefixes always reach Hono, including its 404s; only non-API GET/HEAD
// requests are candidates for a static asset or SPA history fallback.
export const createNodeFetchHandler = (gatewayFetch: FetchHandler, options: StaticWebOptions): FetchHandler =>
  async (request, env, executionCtx) => {
    const url = new URL(request.url);
    if (isGatewayPath(url.pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return await gatewayFetch(request, env, executionCtx);
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Malformed URL path', { status: 400 });
    }
    const root = resolve(options.distDir);
    const requestedPath = resolve(root, `.${pathname}`);
    const relativePath = relative(root, requestedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
      return new Response('Not found', { status: 404 });
    }

    const asset = await responseFromFile(requestedPath, request.method, pathname.startsWith('/assets/'));
    if (asset) return asset;
    if (isStaticAssetPath(pathname)) return new Response('Not found', { status: 404 });

    const index = await responseFromFile(resolve(root, 'index.html'), request.method, false);
    return index ?? new Response('Dashboard assets are unavailable; run pnpm run build:web before starting the Node target.', { status: 503 });
  };

export const nodeWebDistDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.FLOWAY_WEB_DIST_DIR ?? defaultNodeWebDistDir;
