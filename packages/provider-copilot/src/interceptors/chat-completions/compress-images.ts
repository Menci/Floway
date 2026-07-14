import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ChatCompletionsBoundaryCtx, CopilotChatCompletionsBoundaryInterceptor } from './types.ts';
import type { ChatCompletionsContentPart, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

type ChatCompletionsImagePart = Extract<ChatCompletionsContentPart, { type: 'image_url' }>;

const compressInlineImages = async (ctx: ChatCompletionsBoundaryCtx): Promise<void> => {
  const targets: ChatCompletionsImagePart[] = [];
  for (const message of ctx.payload.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) targets.push(part);
    }
  }

  if (targets.length === 0) return;

  const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
  const compressedUrls = new Map<ChatCompletionsImagePart, string>();
  await Promise.all(
    targets.map(async target => {
      compressedUrls.set(target, await compress(target.image_url.url));
    }),
  );
  const hasCompressedImage = (part: ChatCompletionsContentPart): part is ChatCompletionsImagePart =>
    part.type === 'image_url' && compressedUrls.has(part);
  const rewriteImage = (part: ChatCompletionsImagePart): ChatCompletionsImagePart => {
    const url = compressedUrls.get(part);
    if (url === undefined) throw new Error('Missing compressed Chat Completions image URL');
    return { ...part, image_url: { ...part.image_url, url } };
  };
  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map((message): ChatCompletionsMessage => {
      if (!Array.isArray(message.content) || !message.content.some(hasCompressedImage)) return message;
      return {
        ...message,
        content: message.content.map(part => hasCompressedImage(part) ? rewriteImage(part) : part),
      };
    }),
  };
};

// Recompresses every inline base64 image (`data:image/*;base64,...` in an
// `image_url` part) in the outgoing Chat Completions payload to WebP before
// the Copilot upstream call. Remote https image references are left untouched.
export const withInlineImagesCompressed: CopilotChatCompletionsBoundaryInterceptor = async (ctx, _request, run) => {
  // Finish this nested activation before starting the upstream call. Its
  // request-local memoizer keys are the full source data URLs, which can be
  // several megabytes each and must not stay live for the response stream.
  await compressInlineImages(ctx);
  return await run();
};
