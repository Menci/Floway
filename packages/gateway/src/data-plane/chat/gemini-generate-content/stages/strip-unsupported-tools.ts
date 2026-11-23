import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

const translatedTools = (tools: GeminiGenerateContentToolGroup[]): GeminiGenerateContentToolGroup[] => tools.flatMap(tool => {
  if (!tool.functionDeclarations?.length) return [];
  const {
    googleSearch: _search, googleSearchRetrieval: _retrieval, codeExecution: _code, computerUse: _computer,
    urlContext: _url, fileSearch: _file, mcpServers: _mcp, googleMaps: _maps, ...forwarded
  } = tool;
  return [forwarded];
});

export const stripUnsupportedTools = rewriteChatRequest(
  'stripUnsupportedTools', 'request.geminiGenerateContent', (payload: GeminiGenerateContentRequest, _candidate, targetApi) => {
    if (targetApi === 'geminiGenerateContent' || !payload.tools) return payload;
    const { tools, ...rest } = payload;
    const forwarded = translatedTools(tools);
    return forwarded.length === 0 ? rest : { ...rest, tools: forwarded };
  },
);
