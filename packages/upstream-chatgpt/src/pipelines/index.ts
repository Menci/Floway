import type { ChatGPTServices } from '../service.ts';
import { alphaSearchDial } from './alpha-search/dial.ts';
import { compose } from './facts.ts';
import { openAIImagesEditsDial } from './openai-images-edits/dial.ts';
import { openAIImagesGenerationsDial } from './openai-images-generations/dial.ts';
import { openAIResponsesDial } from './openai-responses/dial.ts';
import { openAIResponsesHttp } from './openai-responses/http.ts';
import { openAIResponsesCompactDial } from './openai-responses-compact/dial.ts';
import { stripHeaders } from './strip-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const chatgptPipelines: Readonly<{
  alphaSearch: UpstreamPipeline<'alphaSearch', ChatGPTServices>;
  openaiImagesEdits: UpstreamPipeline<'openaiImagesEdits', ChatGPTServices>;
  openaiImagesGenerations: UpstreamPipeline<'openaiImagesGenerations', ChatGPTServices>;
  openaiResponses: UpstreamPipeline<'openaiResponses', ChatGPTServices>;
  openaiResponsesCompact: UpstreamPipeline<'openaiResponsesCompact', ChatGPTServices>;
}> = Object.freeze({
  alphaSearch: compose('chatgpt.alphaSearch', {
    entry: ['http', 'upstream', 'model', 'alphaSearch'],
    exit: ['http', 'alphaSearch'],
    stages: [stripHeaders, alphaSearchDial],
    ending: httpTerminal,
  }),
  openaiImagesEdits: compose('chatgpt.openaiImagesEdits', {
    entry: ['http', 'upstream', 'model', 'openaiImagesEdits'],
    exit: ['http', 'openaiImagesEdits'],
    stages: [stripHeaders, openAIImagesEditsDial],
    ending: httpTerminal,
  }),
  openaiImagesGenerations: compose('chatgpt.openaiImagesGenerations', {
    entry: ['http', 'upstream', 'model', 'openaiImagesGenerations'],
    exit: ['http', 'openaiImagesGenerations'],
    stages: [stripHeaders, openAIImagesGenerationsDial],
    ending: httpTerminal,
  }),
  openaiResponses: compose('chatgpt.openaiResponses', {
    entry: ['http', 'upstream', 'model', 'openaiResponses'],
    exit: ['http', 'openaiResponses'],
    stages: [stripHeaders, openAIResponsesDial],
    ending: openAIResponsesHttp,
  }),
  openaiResponsesCompact: compose('chatgpt.openaiResponsesCompact', {
    entry: ['http', 'upstream', 'model', 'openaiResponsesCompact'],
    exit: ['http', 'openaiResponsesCompact'],
    stages: [stripHeaders, openAIResponsesCompactDial],
    ending: httpTerminal,
  }),
});
