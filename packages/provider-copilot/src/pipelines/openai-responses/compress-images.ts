import type { OpenAIResponsesOperation } from './operations.ts';
import type { CopilotServices } from '../../service.ts';
import { compressDataUrlImages } from '../shared/image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../shared/image-size.ts';
import { mapChanged } from '../shared/map-changed.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

const imageUrls = function* (input: CanonicalOpenAIResponsesInputItem[]): Generator<string> {
  for (const item of input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type === 'input_image' && typeof part.image_url === 'string') yield part.image_url;
    }
  }
};

const compressInlineImages = async <Payload extends { model: string; input: CanonicalOpenAIResponsesInputItem[] }>(
  payload: Payload,
  _model: unknown,
  { copilot }: Readonly<CopilotServices>,
): Promise<Payload> => {
  const compressed = await compressDataUrlImages(imageUrls(payload.input), targetSizeForOpenAIResponsesChat(payload.model), copilot.compressImage);
  if (compressed.size === 0) return payload;

  const rewrite = <Part extends { type: string }>(part: Part): Part => {
    if (part.type !== 'input_image' || !('image_url' in part) || typeof part.image_url !== 'string') return part;
    const url = compressed.get(part.image_url);
    return url === undefined ? part : { ...part, image_url: url };
  };

  const input = mapChanged(payload.input, item => {
    if (item.type === 'message' && Array.isArray(item.content)) {
      const content = mapChanged(item.content, rewrite);
      return content === item.content ? item : { ...item, content } as CanonicalOpenAIResponsesInputItem;
    }
    if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
      const output = mapChanged(item.output, rewrite);
      return output === item.output ? item : { ...item, output };
    }
    return item;
  });
  return { ...payload, input };
};

export const compressImages = (operation: OpenAIResponsesOperation) => rewritePayload(operation, 'compressImages', compressInlineImages);
