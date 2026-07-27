import type { Context } from 'hono';

import { ANCHORS, isIpV4, isIpV6 } from './egress-probe.ts';
import { backoffRowToJson, proxyRecordToJson } from './serialize.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { shortId } from '../../shared/short-id.ts';
import type { createProxyBody, resetBackoffBody, testProxyBody, updateProxyBody } from '../schemas.ts';
import { getSocketDial } from '@floway-dev/platform';
import { parseProxyUri, ProxyDialError, runProxiedRequest, type ProxyConfig, type ProxyRequestTarget } from '@floway-dev/proxy';

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

  if (result.urlChanged) {
    // The new URL might point at a healthy server; the old URL's backoff
    // state must not stop the dial layer from retrying immediately.
    await repo.proxyBackoffs.resetForProxy(id);
  }

  return c.json(proxyRecordToJson(result.record));
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

  // Sweep orphaned backoff rows; proxy_upstream_backoffs has no FK to proxies, so the cleanup is unconditional.
  await repo.proxyBackoffs.resetForProxy(id);
  return c.body(null, 204);
};

export const testProxy = async (c: CtxWithJson<typeof testProxyBody>) => {
  const body = c.req.valid('json');
  const anchorName = body.anchor ?? 'ipify';
  const anchor = ANCHORS[anchorName];

  // The endpoint runs against the live URL the operator is editing, so a
  // parse failure here is a form-validation failure (400), not a dial
  // failure (which would be reported through the result envelope).
  let config: ProxyConfig;
  try {
    config = parseProxyUri(body.url);
  } catch (err) {
    return c.json({ error: proxyUriValidationError(err) }, 400);
  }

  try {
    const target: ProxyRequestTarget = {
      host: anchor.host,
      port: anchor.port,
      tls: true,
    };
    const response = await runProxiedRequest(
      config,
      target,
      {
        method: 'GET',
        path: anchor.path,
        headers: { 'User-Agent': 'floway-proxy-test/1' },
      },
      {
        socketDial: getSocketDial(),
        ...(body.dial_timeout_seconds == null ? {} : { dialTimeoutMs: body.dial_timeout_seconds * 1000 }),
      },
    );
    if (!response.ok) {
      return c.json({ ok: false, error: `anchor returned status ${response.status}` });
    }
    const truncated = (await response.text()).slice(0, 256).trim();
    if (!isIpV4(truncated) && !isIpV6(truncated)) {
      return c.json({ ok: false, error: `anchor returned non-IP body: ${truncated.slice(0, 80)}` });
    }
    // 6.ident.me is v6-only (AAAA-only), so a v4-only proxy fails to dial
    // it at all and never reaches this branch. The v4-shape rejection is
    // defense-in-depth in case the anchor's records change upstream, or a
    // NAT64/DNS64 synthesizer hands the runtime a v4 path that round-trips
    // a v4 address through a "v6" check.
    if (anchorName === 'ident.me-v6' && !truncated.includes(':')) {
      return c.json({ ok: false, error: `v6 anchor returned a v4 address (${truncated}); proxy has no v6 path` });
    }
    return c.json({ ok: true, egress_ip: truncated });
  } catch (err) {
    // Every dial-shaped failure inside runProxiedRequest surfaces as a typed
    // ProxyDialError carrying the stage tag. Programmer errors (TypeError
    // from a typo, RangeError, etc.) and AbortError MUST propagate to the
    // framework's top-level handler instead of getting flattened into a
    // green-channel ok:false reply.
    if (err instanceof ProxyDialError) {
      return c.json({ ok: false, error: `[${err.stage}] ${err.message}` });
    }
    throw err;
  }
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
