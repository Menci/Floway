import type { ChatGPTServices } from '../service.ts';
import type { ChatGPTUpstreamFact } from '../upstream-fact.ts';
import { alphaSearch } from './alpha-search/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses } from './openai-responses/index.ts';
import { openaiResponsesCompact } from './openai-responses-compact/index.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const chatgptPipelines = Object.freeze({ openaiResponses, openaiResponsesCompact, alphaSearch, openaiImagesGenerations, openaiImagesEdits }) satisfies ProviderPipelines<ChatGPTServices, ChatGPTUpstreamFact>;
