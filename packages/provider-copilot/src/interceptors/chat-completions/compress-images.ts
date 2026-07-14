import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ChatCompletionsBoundaryCtx, CopilotChatCompletionsBoundaryInterceptor } from './types.ts';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

const compressInlineImages = async (ctx: ChatCompletionsBoundaryCtx): Promise<void> => {
  const targets: { url: string }[] = [];
  for (const message of ctx.payload.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) targets.push(part.image_url);
    }
  }

  if (targets.length === 0) return;

  const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
  await Promise.all(
    targets.map(async target => {
      target.url = await compress(target.url);
    }),
  );
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
