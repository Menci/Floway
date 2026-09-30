import { activate, announce, DYNAMIC_TOOL_SERVER_SEARCH, DynamicToolInputError, type DynamicToolCatalog } from './catalog.ts';
import type { ServerToolRegistration, ServerToolResultSlot } from '../server-tool-shim.ts';
import type { OpenAIResponsesInvocation } from '../types.ts';
import type { OpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const catalogByInvocation = new WeakMap<OpenAIResponsesInvocation, DynamicToolCatalog>();

export const bindDynamicToolCatalog = (invocation: OpenAIResponsesInvocation, catalog: DynamicToolCatalog): void => {
  catalogByInvocation.set(invocation, catalog);
};

export const unbindDynamicToolCatalog = (invocation: OpenAIResponsesInvocation): void => {
  catalogByInvocation.delete(invocation);
};

const findByPath = (catalog: DynamicToolCatalog, paths: readonly string[]): OpenAIResponsesTool[] => {
  const indexed = new Map(catalog.searchable.map(tool => [tool.name, tool]));
  return [...new Set(paths)].flatMap(path => {
    const tool = indexed.get(path);
    return tool === undefined ? [] : [tool];
  });
};

const convertServerSearchHistory = (input: OpenAIResponsesInputItem[], catalog: DynamicToolCatalog, toolName: string): OpenAIResponsesInputItem[] =>
  input.flatMap(item => {
    if (item.type === 'tool_search_call' && item.execution === 'server') {
      if (typeof item.call_id !== 'string') return [];
      return [{
        type: 'function_call',
        call_id: item.call_id,
        name: toolName,
        arguments: JSON.stringify(item.arguments),
        status: 'completed',
      }];
    }
    if (item.type !== 'tool_search_output' || item.execution !== 'server') return [item];
    const added = activate(catalog, item.tools);
    const output: OpenAIResponsesInputItem[] = typeof item.call_id === 'string'
      ? [{ type: 'function_call_output', call_id: item.call_id, output: JSON.stringify({ loaded: added.map(tool => tool.handle) }) }]
      : [];
    output.push(added.length > 0
      ? announce(added, 'tool_search_output')
      : { type: 'message', role: 'system', content: 'Tool search returned no matching tools.' });
    return output;
  });

export const dynamicToolSearchServerTool: ServerToolRegistration = invocation => {
  const catalog = catalogByInvocation.get(invocation);
  if (catalog?.serverSearchDefinition === undefined) return { type: 'inactive' };

  return {
    type: 'active',
    baseToolName: DYNAMIC_TOOL_SERVER_SEARCH,
    transformItems: (items, toolName) => convertServerSearchHistory(items, catalog, toolName),
    hosted: {
      hostedTypes: ['tool_search'],
      canonicalize: tool => tool.type === 'tool_search' ? tool : undefined,
      buildFunctionTool: (_tool, toolName) => ({
        type: 'function',
        name: toolName,
        description: 'Load deferred tools by exact catalog path. A namespace path loads its deferred tools. Use the loaded tools through call_additional_tool after this search completes.',
        parameters: {
          type: 'object',
          properties: { paths: { type: 'array', items: { type: 'string' } } },
          required: ['paths'],
          additionalProperties: false,
        },
        strict: false,
      }),
      dispatcher: ({ intercepted }): ServerToolResultSlot[] => {
        const paths = intercepted.arguments?.paths;
        if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
          throw new DynamicToolInputError('Tool search requires an array of exact paths.');
        }
        const selected = findByPath(catalog, paths);
        const searchCallId = `tsc_${crypto.randomUUID().replaceAll('-', '')}`;
        const searchOutputId = `tso_${crypto.randomUUID().replaceAll('-', '')}`;
        const args = { paths };
        return [
          {
            id: searchCallId,
            startItem: { type: 'tool_search_call', call_id: intercepted.callId, arguments: args, execution: 'server', status: 'in_progress' },
            startEvents: [],
            run: async function* run() {
              return {
                item: { type: 'tool_search_call', call_id: intercepted.callId, arguments: args, execution: 'server', status: 'completed' },
                endEvents: [],
              };
            },
          },
          {
            id: searchOutputId,
            startItem: { type: 'tool_search_output', call_id: intercepted.callId, tools: [], execution: 'server', status: 'in_progress' },
            startEvents: [],
            run: async function* run() {
              activate(catalog, selected);
              return {
                item: { type: 'tool_search_output', call_id: intercepted.callId, tools: selected, execution: 'server', status: 'completed' },
                endEvents: [],
              };
            },
          },
        ];
      },
    },
  };
};
