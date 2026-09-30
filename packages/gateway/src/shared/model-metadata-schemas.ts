import { z } from 'zod';

import type { AnnouncedMetadata, CodexChatModelInfo } from '@floway-dev/protocols/common';
import { assertCodexContextWindow, codexChatField } from '@floway-dev/provider/model-config';

export const refineCodexContextWindow = (metadata: AnnouncedMetadata, context: z.RefinementCtx): void => {
  try {
    assertCodexContextWindow(metadata.chat?.codex, metadata.limits, 'metadata');
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['chat', 'codex'], message: error instanceof Error ? error.message : String(error) });
  }
};

export const codexMetadataSchema = z.unknown().transform((value, context): CodexChatModelInfo => {
  try {
    return codexChatField(value, 'chat.codex');
  } catch (error) {
    context.issues.push({ code: 'custom', message: error instanceof Error ? error.message : String(error), input: value });
    return z.NEVER;
  }
});

export const verbosityMetadataSchema = z.object({ supported: z.boolean() });
