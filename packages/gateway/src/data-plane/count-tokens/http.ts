import { anthropicMessagesCountTokensPipeline, geminiGenerateContentCountTokensPipeline } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';

export const serveAnthropicMessagesCountTokens = serveHttp(anthropicMessagesCountTokensPipeline);
export const serveGeminiGenerateContentCountTokens = serveHttp(geminiGenerateContentCountTokensPipeline);
