import type { GeminiInterceptor } from '../../../interceptors.ts';
import type { GeminiGenerateContentRequest, GeminiToolGroup } from '@floway-dev/protocols/gemini';

/**
 * Only function declarations are currently translatable from Gemini tool
 * groups. Strip the rest after target planning so target emitters never see
 * unsupported tool capabilities.
 *
 * TODO: Support Gemini googleSearch through the existing web-search shim
 * instead of dropping it here.
 */
const stripToolCapabilities = (tool: GeminiToolGroup): void => {
  delete tool.googleSearch;
  delete tool.googleSearchRetrieval;
  delete tool.codeExecution;
  delete tool.computerUse;
  delete tool.urlContext;
  delete tool.fileSearch;
  delete tool.mcpServers;
  delete tool.googleMaps;
};

export const stripUnsupportedToolsFromPayload = (payload: GeminiGenerateContentRequest): void => {
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

export const stripUnsupportedTools: GeminiInterceptor = (ctx, _request, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
