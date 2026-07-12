import type { ResponsesTool } from './index.ts';

// Delimiter used to encode a `namespace` container's name into its unpacked
// sub-tools' names. Chosen to satisfy the Chat Completions function-name
// regex `^[a-zA-Z0-9_-]{1,64}$` (rules out `.`) while being unlikely to
// collide with real sub-tool names. Constraint: sub-tool names inside a
// namespace MUST NOT contain this delimiter — Codex's own conventions
// (`spawn_agent`, `send_message`, `followup_task`, ...) comply. When a
// legit sub-tool name contains `__`, the reverse-strip on the response
// side will misidentify the split and Codex will not route the tool call.
// Ref: https://developers.openai.com/api/docs/guides/tools-tool-search
export const NAMESPACE_NAME_DELIMITER = '__';

// Expand any hosted `type: 'namespace'` container entries into their nested
// `tools[]`, prefixing each sub-tool's `name` with `<namespace>__` to preserve
// the container's grouping semantic. Preserves order and drops the container
// itself. Leaves non-namespace entries (function, custom, other hosted types)
// untouched. One-level expansion — nested namespaces are not in the OpenAI
// schema; a namespace found inside another namespace's `tools[]` after one
// pass is malformed and passed through untouched for upstream to reject.
export const unpackNamespaceTools = (tools: ResponsesTool[]): ResponsesTool[] => {
  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    if (tool.type !== 'namespace') {
      out.push(tool);
      continue;
    }
    const container = tool as { name?: unknown; tools?: unknown };
    if (!Array.isArray(container.tools)) {
      out.push(tool);
      continue;
    }
    const nsName = typeof container.name === 'string' ? container.name : null;
    for (const sub of container.tools as ResponsesTool[]) {
      if (nsName !== null && 'name' in sub && typeof (sub as { name?: unknown }).name === 'string') {
        const prefixed = `${nsName}${NAMESPACE_NAME_DELIMITER}${(sub as { name: string }).name}`;
        out.push({ ...(sub as object), name: prefixed } as ResponsesTool);
      } else {
        out.push(sub);
      }
    }
  }
  return out;
};

// Reverse of `unpackNamespaceTools`'s name prefixing. Splits on the LAST
// delimiter occurrence, so a namespace name that itself contains `__` round-
// trips safely. Returns null when the name doesn't look prefixed; caller
// passes the original name through untouched in that case.
export const unprefixNamespaceToolCall = (name: string): { namespace: string; name: string } | null => {
  const idx = name.lastIndexOf(NAMESPACE_NAME_DELIMITER);
  if (idx <= 0) return null;
  const suffixStart = idx + NAMESPACE_NAME_DELIMITER.length;
  if (suffixStart >= name.length) return null;
  return {
    namespace: name.slice(0, idx),
    name: name.slice(suffixStart),
  };
};

// One-pass desugaring of the tool_search family features on a Responses
// tools[] to a legacy tools[]-only shape:
//   1. drop `type: 'tool_search'` and `type: 'programmatic_tool_calling'` entries
//   2. unpack `type: 'namespace'` containers via `unpackNamespaceTools`
//      (sub-tool names prefixed with `<namespace>__`)
//   3. strip `defer_loading` and `allowed_callers` fields from remaining
//      function/custom tools (they have no meaning without tool_search / PTC)
export const flattenToolSearchFamilyTools = (tools: ResponsesTool[]): ResponsesTool[] => {
  const withoutFamilyHosted = tools.filter(t => t.type !== 'tool_search' && t.type !== 'programmatic_tool_calling');
  const unpacked = unpackNamespaceTools(withoutFamilyHosted);
  return unpacked.map(stripToolSearchFamilyFields);
};

const stripToolSearchFamilyFields = (tool: ResponsesTool): ResponsesTool => {
  if (tool.type !== 'function' && tool.type !== 'custom') return tool;
  const source = tool as unknown as Record<string, unknown>;
  if (source.defer_loading === undefined && source.allowed_callers === undefined) return tool;
  const { defer_loading: _dl, allowed_callers: _ac, ...rest } = source;
  return rest as unknown as ResponsesTool;
};
