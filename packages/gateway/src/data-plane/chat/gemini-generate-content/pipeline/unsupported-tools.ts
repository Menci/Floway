import { defineStage } from '../../pipeline/facts.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

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

export const stripUnsupportedToolsFromPayload = <Payload extends Pick<GeminiGenerateContentPayload, 'tools'>>(
  payload: Payload,
): Payload => {
  if (payload.tools == null) return payload;
  const tools = payload.tools.filter(tool => (tool.functionDeclarations?.length ?? 0) > 0).map(stripToolCapabilities);
  const next = { ...payload };
  if (tools.length > 0) next.tools = tools;
  else delete next.tools;
  return next;
};

export const stripGeminiGenerateContentUnsupportedTools = defineStage({
  name: 'geminiGenerateContent.strip-unsupported-tools',
  through: {
    request: { needs: ['geminiGenerateContent', 'chat.target'], provides: ['geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['chat.target'] === 'geminiGenerateContent') return await scope.next(facts);
    return await scope.next({ ...facts, geminiGenerateContent: stripUnsupportedToolsFromPayload(facts.geminiGenerateContent) });
  },
});
