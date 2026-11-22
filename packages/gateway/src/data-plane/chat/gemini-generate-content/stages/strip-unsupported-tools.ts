import type { ChatPipelineServices, GeminiGenerateContentAttemptInput } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';
import type { ChatTargetApi } from '@floway-dev/provider';

interface Facts extends GeminiGenerateContentAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const stripToolCapabilities = (tool: GeminiGenerateContentToolGroup): void => {
  delete tool.googleSearch;
  delete tool.googleSearchRetrieval;
  delete tool.codeExecution;
  delete tool.computerUse;
  delete tool.urlContext;
  delete tool.fileSearch;
  delete tool.mcpServers;
  delete tool.googleMaps;
};

const stripUnsupportedToolsFromPayload = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  if (payload.tools === undefined) return payload;
  const tools = payload.tools.flatMap(source => {
    const tool = { ...source };
    stripToolCapabilities(tool);
    return tool.functionDeclarations !== undefined && tool.functionDeclarations.length > 0 ? [tool] : [];
  });
  const { tools: _tools, ...rest } = payload;
  return tools.length === 0 ? rest : { ...rest, tools };
};

// Translated targets can carry function declarations but not Gemini's native
// search, execution, or retrieval tool groups.
export const stripUnsupportedTools = defineRequestStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  never,
  ChatPipelineServices
>({
  name: 'stripUnsupportedTools',
  provides: ['request.payload'],
  execute: async (facts, next) => facts['route.targetApi'] === 'geminiGenerateContent'
    ? await next({ 'request.payload': facts['request.payload'] })
    : await next({ 'request.payload': stripUnsupportedToolsFromPayload(facts['request.payload']) }),
});
