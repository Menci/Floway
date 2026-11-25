import type { CopilotService } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import { compressImageDataUrlToWebp } from '../shared/image-compression.ts';
import { openAIImageSize } from '../shared/image-size.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesOutputRefusal, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

const compressRequests = async <Payload extends Pick<CanonicalOpenAIResponsesPayload, 'input'>>(payload: Payload, model: string, compress: CopilotService['compressImage']): Promise<Payload> => {
  const sources = new Set<string>();
  for (const item of payload.input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type === 'input_image' && typeof part.image_url === 'string' && isBase64ImageDataUrl(part.image_url)) {
        sources.add(part.image_url);
      }
    }
  }
  if (sources.size === 0) return payload;

  const size = openAIImageSize(model);
  const compressed = new Map(await Promise.all([...sources].map(async url => [url, await compressImageDataUrlToWebp(compress, url, size)] as const)));
  const rewrite = <Part extends OpenAIResponsesInputContent | OpenAIResponsesToolOutputContent | OpenAIResponsesOutputRefusal>(parts: Part[]): Part[] => parts.map(part => {
    if (part.type !== 'input_image' || typeof part.image_url !== 'string') return part;
    const url = compressed.get(part.image_url);
    return url === undefined ? part : { ...part, image_url: url };
  });

  return {
    ...payload,
    input: payload.input.map(item => {
      if (item.type === 'message' && Array.isArray(item.content)) {
        return { ...item, content: rewrite(item.content) } as CanonicalOpenAIResponsesInputItem;
      }
      if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
        return { ...item, output: rewrite(item.output) };
      }
      return item;
    }),
  };
};

export const compressImages = defineCopilotStage({
  name: 'copilot.openaiResponses.compressImages',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(scope => ({
    async request(facts) {
      const payload = facts['request.openaiResponses'];
      const compressed = await compressRequests(payload, facts['provider.model'].id, scope.services.copilot.compressImage);
      return compressed === payload ? facts : { ...facts, 'request.openaiResponses': move(compressed) };
    },
  })),
});
