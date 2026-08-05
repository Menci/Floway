import type { Context } from 'hono';

import { probeProxyEgress } from './egress-probe.ts';
import { backoffRowToJson, proxyRecordToJson } from './serialize.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { shortId } from '../../shared/short-id.ts';
import type { createProxyBody, resetBackoffBody, testProxyBody, updateProxyBody } from '../schemas.ts';
import { getSocketDial } from '@floway-dev/platform';
import { parseProxyUri, runProxiedRequest, type ProxyConfig } from '@floway-dev/proxy';

const proxyUriValidationError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  // The URL-constructor branch of parseProxyUri prepends "malformed proxy
  // URI: ..." which would double up under our own "Invalid proxy URI: "
  // wrap. Strip the doubled prefix.
  return `Invalid proxy URI: ${raw.replace(/^malformed proxy URI: /, '')}`;
};

export const listProxies = async (c: Context) => {
  const proxies = await getRepo().proxies.list();
  return c.json(proxies.map(proxyRecordToJson));
};

export const createProxy = async (c: CtxWithJson<typeof createProxyBody>) => {
  const body = c.req.valid('json');

  // Validate the URI up front so a parse failure surfaces as a 400 instead
  // of waiting for the first dial attempt.
  try {
    parseProxyUri(body.url);
  } catch (err) {
    return c.json({ error: proxyUriValidationError(err) }, 400);
  }

  const repo = getRepo();
  const record = await repo.proxies.insert({
    id: shortId('proxy'),
    name: body.name,
    url: body.url,
    dialTimeoutSeconds: body.dial_timeout_seconds ?? null,
  });
  return c.json(proxyRecordToJson(record), 201);
};

export const updateProxy = async (c: CtxWithJson<typeof updateProxyBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');

  if (body.url !== undefined) {
    try {
      parseProxyUri(body.url);
    } catch (err) {
      return c.json({ error: proxyUriValidationError(err) }, 400);
    }
  }

  const repo = getRepo();
  const result = await repo.proxies.patch(id, {
    name: body.name,
    url: body.url,
    // Forward the absent / null distinction so the repo can tell "leave it"
    // from "clear it back to default" — Object.hasOwn carries the bit
    // through the spread below.
    ...(Object.hasOwn(body, 'dial_timeout_seconds') ? { dialTimeoutSeconds: body.dial_timeout_seconds } : {}),
  });
  if (!result) return c.json({ error: 'Proxy not found' }, 404);
  return c.json(proxyRecordToJson(result));
};

export const deleteProxy = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const repo = getRepo();

  // Refuse to orphan an upstream's `proxy_fallback_list`: the foreign-key
  // semantics are "remove the reference first, then drop the proxy". 409
  // returns the referencing upstream ids so the caller can detach before
  // retrying.
  const referencing = await repo.proxies.findUpstreamsReferencing(id);
  if (referencing.length > 0) {
    return c.json({ error: 'Proxy is referenced by upstreams', referencing_upstream_ids: referencing }, 409);
  }

  // The DELETE predicate re-checks referencing in the same statement to
  // close the TOCTOU window between the read above and the write — a
  // concurrent admin PATCH that adds a reference now blocks the delete
  // atomically. If 0 rows changed, distinguish "raced into 409" from
  // "really not found" by re-reading the reference list.
  const ok = await repo.proxies.delete(id);
  if (!ok) {
    const racedRefs = await repo.proxies.findUpstreamsReferencing(id);
    if (racedRefs.length > 0) {
      return c.json({ error: 'Proxy is referenced by upstreams', referencing_upstream_ids: racedRefs }, 409);
    }
    return c.json({ error: 'Proxy not found' }, 404);
  }

  return c.body(null, 204);
};

export const testProxy = async (c: CtxWithJson<typeof testProxyBody>) => {
  const body = c.req.valid('json');
  const anchorName = body.anchor ?? 'ipify';

  // The endpoint runs against the live URL the operator is editing, so a
  // parse failure here is a form-validation failure (400), not a dial
  // failure (which would be reported through the result envelope).
  let config: ProxyConfig;
  try {
    config = parseProxyUri(body.url);
  } catch (err) {
    return c.json({ error: proxyUriValidationError(err) }, 400);
  }

  return c.json(await probeProxyEgress(
    {
      config,
      anchorName,
      dialTimeoutSeconds: body.dial_timeout_seconds,
    },
    { runProxiedRequest, socketDial: getSocketDial() },
  ));
};

export const listAllBackoffs = async (c: Context) => {
  const rows = await getRepo().proxyBackoffs.listAll();
  return c.json(rows.map(backoffRowToJson));
};

export const listProxyBackoffs = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const rows = await getRepo().proxyBackoffs.listForProxy(id);
  return c.json(rows.map(backoffRowToJson));
};

export const resetProxyBackoffs = async (c: CtxWithJson<typeof resetBackoffBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');
  const repo = getRepo();

  if (body.upstream_id !== undefined) {
    await repo.proxyBackoffs.reset(id, body.upstream_id);
  } else {
    await repo.proxyBackoffs.resetForProxy(id);
  }
  return c.json({ ok: true });
};
