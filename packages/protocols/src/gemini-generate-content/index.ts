
export interface GeminiGenerateContentPayload {
  contents?: GeminiGenerateContentContent[];
  systemInstruction?: GeminiGenerateContentContent;
  tools?: GeminiGenerateContentToolGroup[];
  toolConfig?: { functionCallingConfig?: GeminiGenerateContentFunctionCallingConfig };
  generationConfig?: GeminiGenerateContentGenerationConfig;
  safetySettings?: GeminiGenerateContentSafetySetting[];
  cachedContent?: string;
}

export interface GeminiGenerateContentContent {
  role?: 'user' | 'model';
  parts: GeminiGenerateContentPart[];
}

export interface GeminiGenerateContentPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
  fileData?: { mimeType: string; fileUri: string };
  executableCode?: unknown;
  codeExecutionResult?: unknown;
}

export interface GeminiGenerateContentGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseMimeType?: string;
  responseSchema?: unknown;
  thinkingConfig?: GeminiGenerateContentThinkingConfig;
}

export interface GeminiGenerateContentThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});
  includeThoughts?: boolean;
}

export interface GeminiGenerateContentFunctionCallingConfig {
  mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
  allowedFunctionNames?: string[];
}

export interface GeminiGenerateContentToolGroup {
  functionDeclarations?: GeminiGenerateContentFunctionDeclaration[];
  googleSearch?: unknown;
  googleSearchRetrieval?: unknown;
  codeExecution?: unknown;
  computerUse?: unknown;
  urlContext?: unknown;
  fileSearch?: unknown;
  mcpServers?: unknown;
  googleMaps?: unknown;
}

export interface GeminiGenerateContentFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiGenerateContentSafetySetting {
  category: string;
  threshold: string;
}

export interface GeminiGenerateContentResult {
  candidates?: GeminiGenerateContentCandidate[];
  usageMetadata?: GeminiGenerateContentUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

export interface GeminiGenerateContentCandidate {
  content: GeminiGenerateContentContent;
  finishReason?: GeminiGenerateContentFinishReason;
  finishMessage?: string;
  safetyRatings?: GeminiGenerateContentSafetyRating[];
  index: number;
}

export interface GeminiGenerateContentSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

export type GeminiGenerateContentFinishReason = 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | 'MALFORMED_FUNCTION_CALL' | 'FINISH_REASON_UNSPECIFIED';

export interface GeminiGenerateContentUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiGenerateContentErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

export type GeminiGenerateContentStreamEvent = GeminiGenerateContentResult | GeminiGenerateContentErrorResponse;

export { GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, GEMINI_GENERATE_CONTENT_RESULT_KEYS } from './field-keys.ts';
export { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, collectGeminiGenerateContentProtocolEventsToResult } from './to-result.ts';
export { reassembleGeminiGenerateContentEvents } from './reassemble.ts';
export { geminiGenerateContentProtocolFrameToSSEFrame } from './to-sse.ts';
