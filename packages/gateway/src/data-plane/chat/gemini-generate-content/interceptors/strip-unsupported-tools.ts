import type { GeminiGenerateContentInterceptor } from './types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Translated targets can only carry function declarations from Gemini's tool
 * groups, so strip the rest after target planning and keep those emitters from
 * seeing unsupported capabilities. A native Gemini upstream keeps every group.
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
  if (ctx.targetApi !== 'geminiGenerateContent') stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
