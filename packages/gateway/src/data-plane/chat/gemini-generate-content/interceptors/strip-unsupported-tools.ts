import type { GeminiGenerateContentInterceptor } from './types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Only function declarations are currently translatable from Gemini tool
 * groups. Strip the rest after target planning so target emitters never see
 * unsupported tool capabilities.
 */
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

export const stripUnsupportedToolsFromPayload = (payload: GeminiGenerateContentPayload): void => {
  if (!payload.tools) return;

  const tools = payload.tools.filter(tool => {
    stripToolCapabilities(tool);
    return tool.functionDeclarations && tool.functionDeclarations.length > 0;
  });

  if (tools.length === 0) {
    delete payload.tools;
  } else {
    payload.tools = tools;
  }
};

export const stripUnsupportedTools: GeminiGenerateContentInterceptor = (ctx, _gatewayCtx, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
