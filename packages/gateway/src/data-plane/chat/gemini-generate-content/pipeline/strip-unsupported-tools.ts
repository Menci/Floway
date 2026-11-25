import { geminiGenerateContentPayload, servesNativeGeminiGenerateContent } from './native-target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.geminiGenerateContent';

export const stripUnsupportedTools = defineStage({
  name: 'geminiGenerateContent.strip-unsupported-tools',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (servesNativeGeminiGenerateContent(facts['serve.candidate'])) return facts;
      const { tools, ...payload } = geminiGenerateContentPayload(facts[key]);
      if (tools === undefined) return facts;
      const supported = tools.map(functionTools).filter(group => (group.functionDeclarations?.length ?? 0) > 0);
      return { ...facts, [key]: move({ ...payload, ...(supported.length > 0 ? { tools: supported } : {}) }) };
    },
  })),
});

const functionTools = ({
  googleSearch: _search,
  googleSearchRetrieval: _retrieval,
  codeExecution: _code,
  computerUse: _computer,
  urlContext: _url,
  fileSearch: _file,
  mcpServers: _mcp,
  googleMaps: _maps,
  ...group
}: GeminiGenerateContentToolGroup): GeminiGenerateContentToolGroup => group;
