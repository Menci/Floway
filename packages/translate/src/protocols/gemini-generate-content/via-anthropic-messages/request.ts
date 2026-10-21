import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesFromIR } from '../../anthropic-messages/as-target/input-from.ts';
import { anthropicMessagesToolInputSchema } from '../../anthropic-messages/as-target/tool-input-schema.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentContentsToIRTurns, geminiGenerateContentDropsReasoning } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionDeclarations, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesTool,
} from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';

interface ThinkingConfigFields {
  thinking?: NonNullable<AnthropicMessagesPayload['thinking']>;
  outputConfig: NonNullable<AnthropicMessagesPayload['output_config']>;
}

const applyThinkingConfig = (thinkingConfig?: GeminiGenerateContentThinkingConfig): ThinkingConfigFields => {
  if (!thinkingConfig) return { outputConfig: {} };

  let thinking: ThinkingConfigFields['thinking'];
  if (thinkingConfig.thinkingBudget === -1) {
    thinking = { type: 'adaptive' };
  } else if (thinkingConfig.thinkingBudget !== undefined && thinkingConfig.thinkingBudget > 0) {
    thinking = {
      type: 'enabled',
      budget_tokens: thinkingConfig.thinkingBudget,
    };
  } else if (thinkingConfig.thinkingBudget === 0) {
    thinking = { type: 'disabled' };
  }

  const effort = thinkingConfig?.thinkingLevel;
  return {
    ...(thinking !== undefined ? { thinking } : {}),
    outputConfig: effort !== undefined ? { effort } : {},
  };
};

const applyGenerationConfig = (request: AnthropicMessagesPayload, generationConfig: GeminiGenerateContentGenerationConfig | undefined, fallbackMaxOutputTokens: number): NonNullable<AnthropicMessagesPayload['output_config']> => {
  request.max_tokens = generationConfig?.maxOutputTokens ?? fallbackMaxOutputTokens;

  if (!generationConfig) return {};

  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }
  if (generationConfig.topK !== undefined) {
    request.top_k = generationConfig.topK;
  }
  if (generationConfig.stopSequences !== undefined) {
    request.stop_sequences = klona(generationConfig.stopSequences);
  }
  const schema = geminiResponseSchema(generationConfig);
  return schema === undefined ? {} : { format: { type: 'json_schema', schema } };
};

const buildTools = (payload: GeminiGenerateContentPayload): AnthropicMessagesTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'all').map(declaration => ({
    type: 'custom' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    input_schema: anthropicMessagesToolInputSchema(geminiFunctionParameters(declaration) ?? { type: 'object', properties: {} }),
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
  options: { fallbackMaxOutputTokens: number | undefined },
): Promise<AnthropicMessagesPayload> => {
  // Gemini generateContent can omit maxOutputTokens, but AnthropicMessagesPayload requires max_tokens.
  // Prefer the model's advertised `/models` cap when one is known; otherwise
  // fall back to the gateway policy default shared with the other
  // `*-via-anthropic-messages` translators.
  const fallbackMaxOutputTokens = options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  const request: AnthropicMessagesPayload = {
    model,
    stream: true,
    max_tokens: fallbackMaxOutputTokens,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  const system = geminiGenerateContentText(payload.systemInstruction);
  if (system !== null) {
    const systemBlocks: AnthropicMessagesTextBlockParam[] = [{ type: 'text', text: system }];
    applyLastSystemCacheBreakpoint(systemBlocks);
    request.system = systemBlocks;
  }

  const restoredMessages = new Set<AnthropicMessagesPayload['messages'][number]>();
  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesPayload['messages'][number]>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'anthropicMessages', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        restoredMessages.add(roundTrip.turn);
        if (Array.isArray(roundTrip.turn.content)) for (const block of roundTrip.turn.content) {
          if (block.type !== 'tool_use' && block.type !== 'server_tool_use') continue;
          unmatchedToolCallIds[block.name] ??= [];
          unmatchedToolCallIds[block.name].push(block.id);
        }
        contentIndex += turn.items.length;
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'anthropicMessages');
    }
    pieces.push(...geminiGenerateContentContentsToIRTurns(turn, contentIndex, unmatchedToolCallIds, 'Anthropic Messages'));
    contentIndex += turn.items.length;
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { request.messages.push(piece.turn); continue; }
    const translated = await anthropicMessagesFromIR({ turns: piece.turns }, false, { oneMessagePerItem: true, allowFileContent: true });
    request.messages.push(...translated.messages);
  }

  const generationOutputConfig = applyGenerationConfig(request, payload.generationConfig, fallbackMaxOutputTokens);
  const { thinking, outputConfig: thinkingOutputConfig } = applyThinkingConfig(payload.generationConfig?.thinkingConfig);
  const outputConfig = { ...generationOutputConfig, ...thinkingOutputConfig };
  const hasGenerationOutputConfig = Object.keys(generationOutputConfig).length > 0;
  const attachOutputConfig = (): void => {
    request.output_config = outputConfig;
  };

  // Preserve request-key insertion order: a structured-output format precedes
  // `thinking`, while an effort-only `output_config` follows it.
  if (hasGenerationOutputConfig) attachOutputConfig();
  if (thinking !== undefined) request.thinking = thinking;
  if (!hasGenerationOutputConfig && Object.keys(outputConfig).length > 0) attachOutputConfig();

  const tools = buildTools(payload);
  if (tools) request.tools = tools;
  applyLastToolCacheBreakpoint(request.tools);
  applyLastMessageCacheBreakpoint(request.messages.filter(message => !restoredMessages.has(message)));

  const intent = geminiGenerateContentFunctionCallingIntent(payload.toolConfig?.functionCallingConfig);
  switch (intent?.type) {
  case 'none':
    request.tool_choice = { type: 'none' };
    break;
  case 'auto':
    request.tool_choice = { type: 'auto' };
    break;
  case 'any':
    request.tool_choice = { type: 'any' };
    break;
  case 'named':
    request.tool_choice = { type: 'tool', name: intent.name };
    break;
  }

  return request;
};
