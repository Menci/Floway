import { geminiTranslationStage } from './translation-stage.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Translated targets can only carry function declarations from Gemini's tool
 * groups, so strip the rest after target planning and keep those emitters from
 * seeing unsupported capabilities. A native Gemini upstream keeps every group.
 */
const stripToolCapabilities = ({
  googleSearch: _search,
  googleSearchRetrieval: _retrieval,
  codeExecution: _code,
  computerUse: _computer,
  urlContext: _url,
  fileSearch: _files,
  mcpServers: _mcp,
  googleMaps: _maps,
  ...tool
}: GeminiGenerateContentToolGroup): GeminiGenerateContentToolGroup => tool;

export const stripUnsupportedToolsFromPayload = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => {
  const { tools, ...rest } = payload;
  if (!tools) return payload;
  const supported = tools.filter(tool => tool.functionDeclarations && tool.functionDeclarations.length > 0).map(stripToolCapabilities);
  return supported.length > 0 ? { ...rest, tools: supported } : rest;
};

export const stripUnsupportedTools = geminiTranslationStage('strip-unsupported-tools', stripUnsupportedToolsFromPayload);
