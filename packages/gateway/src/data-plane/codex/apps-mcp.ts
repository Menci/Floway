// Minimal MCP Streamable HTTP server that advertises zero tools, mounted at
// `/api/codex/apps`. codex's 1p client registers a "codex_apps" MCP server
// whose URL is derived from `chatgpt_base_url` by
// `codex_apps_mcp_url_for_base_url` (codex-rs/codex-mcp/src/mcp/mod.rs:422-446):
// when the base contains neither `/backend-api` nor `/api/codex`, codex
// appends `/api/codex/apps` to it. Floway's `chatgpt_base_url` is set to the
// codex namespace root, so this is the path the rmcp client actually POSTs to.
//
// The dashboard's recommended `~/.codex/config.toml` snippet sets
// `[features] apps = false`, which short-circuits the registration and
// removes the startup hop entirely; this stub is the fallback for an
// operator who hasn't taken the snippet (vanilla codex config). A static
// 404 or non-JSON 200 there would fail the rmcp `initialize` handshake
// and surface a hard "MCP startup incomplete (failed: codex_apps)" notice
// in the TUI even though `required: false` keeps the rest of the session
// running, so the stub speaks the protocol — JSON-RPC 2.0 over POST,
// single-shot application/json responses, no SSE channel. Spec reference:
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
//
// The Apps tool set is meant to expose ChatGPT-managed mini-apps; we have
// nothing to expose, so `tools/list` returns `[]`. Everything else is
// answered with JSON-RPC method-not-found.

import type { Context } from 'hono';

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'floway-codex-apps-stub', version: '0.1.0' } as const;

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export const codexAppsMcp = async (c: Context) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error'));
  }

  const isBatch = Array.isArray(body);
  const inputs: unknown[] = isBatch ? (body as unknown[]) : [body];
  const responses = inputs.map(handleMessage).filter((r): r is JsonRpcResponse => r !== null);

  // A request set composed entirely of notifications gets a bodyless 202.
  if (responses.length === 0) return c.body(null, 202);
  return c.json(isBatch ? responses : responses[0]);
};

const handleMessage = (raw: unknown): JsonRpcResponse | null => {
  if (!isRecord(raw) || raw.jsonrpc !== '2.0') {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const msg = raw as JsonRpcMessage;

  // JSON-RPC notifications carry no id and receive no reply.
  if (msg.id === undefined) return null;
  const id = normaliseId(msg.id);

  switch (msg.method) {
  case 'initialize':
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: pickProtocolVersion(msg.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    };
  case 'tools/list':
    return { jsonrpc: '2.0', id, result: { tools: [], nextCursor: null } };
  case 'ping':
    return { jsonrpc: '2.0', id, result: {} };
  default:
    return jsonRpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
};

const pickProtocolVersion = (params: unknown): string => {
  if (isRecord(params) && typeof params.protocolVersion === 'string') {
    return params.protocolVersion;
  }
  return FALLBACK_PROTOCOL_VERSION;
};

const normaliseId = (id: unknown): JsonRpcId => {
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return null;
};

const jsonRpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
