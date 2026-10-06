
export interface GeminiGenerateContentPayload {
  contents: GeminiGenerateContentContent[];
  systemInstruction?: GeminiGenerateContentContent;
  tools?: GeminiGenerateContentToolGroup[];
  toolConfig?: GeminiGenerateContentToolConfig;
  generationConfig?: GeminiGenerateContentGenerationConfig;
  safetySettings?: GeminiGenerateContentSafetySetting[];
  cachedContent?: string;
  serviceTier?: string;
  labels?: Record<string, string>;
  store?: boolean;
}
export interface GeminiGenerateContentRequest extends GeminiGenerateContentPayload { model: string }
export interface GeminiCountTokensPayload {
  contents?: GeminiGenerateContentContent[];
  generateContentRequest?: GeminiGenerateContentRequest;
}
export interface GeminiGenerateContentContent { role?: 'user' | 'model' | (string & {}); parts?: GeminiGenerateContentPart[] }
export interface GeminiGenerateContentPartMetadata {
  thought?: boolean;
  thoughtSignature?: string;
  videoMetadata?: { startOffset?: string; endOffset?: string; fps?: number };
  partMetadata?: Record<string, unknown>;
  mediaResolution?: { level?: string };
  mediaProcessing?: string;
  speechMetadata?: { speaker?: string; style?: string };
  audioTranscription?: { text: string; speakerLabel?: string; words?: { word: string; startOffset?: string; endOffset?: string }[] };
}
export interface GeminiGenerateContentFunctionCall { name: string; args?: Record<string, unknown>; id?: string }
export interface GeminiGenerateContentFunctionResponse { name: string; response: Record<string, unknown>; id?: string; parts?: GeminiGenerateContentFunctionResponsePart[]; willContinue?: boolean; scheduling?: string }
export interface GeminiGenerateContentFunctionResponseBlob { mimeType: string; data: string }
export interface GeminiGenerateContentFunctionResponsePart { inlineData: GeminiGenerateContentFunctionResponseBlob }
export interface GeminiGenerateContentBlob { mimeType: string; data: string; displayName?: string }
export interface GeminiGenerateContentToolCall { toolType: string; id?: string; toolName?: string; args?: Record<string, unknown> }
export interface GeminiGenerateContentToolResponse { toolType: string; id?: string; response?: Record<string, unknown> }
export interface GeminiGenerateContentPartData {
  text?: string;
  inlineData?: GeminiGenerateContentBlob;
  fileData?: { fileUri: string; mimeType?: string; displayName?: string };
  functionCall?: GeminiGenerateContentFunctionCall;
  functionResponse?: GeminiGenerateContentFunctionResponse;
  executableCode?: { language: string; code: string; id?: string };
  codeExecutionResult?: { outcome: string; output?: string; id?: string };
  toolCall?: GeminiGenerateContentToolCall;
  toolResponse?: GeminiGenerateContentToolResponse;
}
// A Part may carry only metadata, including a standalone thoughtSignature.
// https://github.com/googleapis/js-genai/blob/ca5690c0999f499f69bb69ea6187ef29d26ddfef/test/unit/types_test.ts#L125-L140
export type GeminiGenerateContentPart = GeminiGenerateContentPartMetadata & (
  | { [Key in keyof GeminiGenerateContentPartData]-?: Required<Pick<GeminiGenerateContentPartData, Key>> & Partial<Record<Exclude<keyof GeminiGenerateContentPartData, Key>, never>> }[keyof GeminiGenerateContentPartData]
  | Partial<Record<keyof GeminiGenerateContentPartData, never>>
);
export interface GeminiGenerateContentSchema {
  type: string;
  format?: string; title?: string; description?: string; nullable?: boolean;
  enum?: string[]; properties?: Record<string, GeminiGenerateContentSchema>; items?: GeminiGenerateContentSchema; anyOf?: GeminiGenerateContentSchema[];
  required?: string[]; propertyOrdering?: string[]; minimum?: number; maximum?: number; pattern?: string;
  default?: unknown; example?: unknown;
  minItems?: string; maxItems?: string; minLength?: string; maxLength?: string; minProperties?: string; maxProperties?: string;
}
export interface GeminiGenerateContentVoiceConfig { voice?: string; prebuiltVoiceConfig?: { voiceName?: string } }
export interface GeminiGenerateContentGenerationConfig {
  temperature?: number; topP?: number; topK?: number; maxOutputTokens?: number; stopSequences?: string[]; candidateCount?: number;
  presencePenalty?: number; frequencyPenalty?: number; seed?: number;
  responseMimeType?: string; responseSchema?: GeminiGenerateContentSchema; responseJsonSchema?: unknown;
  responseModalities?: string[]; responseLogprobs?: boolean; logprobs?: number; mediaResolution?: string;
  thinkingConfig?: GeminiGenerateContentThinkingConfig;
  imageConfig?: { aspectRatio?: string; imageSize?: string };
  speechConfig?: { languageCode?: string; voiceConfig?: GeminiGenerateContentVoiceConfig; multiSpeakerVoiceConfig?: { speakerVoiceConfigs: { speaker: string; voiceConfig: GeminiGenerateContentVoiceConfig }[] } };
  enableAffectiveDialog?: boolean; enableEnhancedCivicAnswers?: boolean;
  translationConfig?: { targetLanguageCode: string; echoTargetLanguage?: boolean };
  audioTranscriptionConfig?: { languageCodes?: string[]; adaptationPhrases?: string[]; customVocabulary?: string[]; wordTimestamp?: boolean; diarization?: boolean; mode?: string; languageHints?: { languageCodes: string[] }; languageAuto?: Record<string, never> };
  responseFormat?: { text?: { mimeType?: string; schema?: unknown }; image?: { mimeType?: string; delivery?: string; aspectRatio?: string; imageSize?: string }; audio?: { mimeType?: string; sampleRate?: number; bitRate?: number; delivery?: string } };
}
export interface GeminiGenerateContentThinkingConfig { thinkingBudget?: number; thinkingLevel?: 'THINKING_LEVEL_UNSPECIFIED' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | (string & {}); includeThoughts?: boolean }
export interface GeminiGenerateContentFunctionCallingConfig { mode?: 'MODE_UNSPECIFIED' | 'AUTO' | 'NONE' | 'ANY' | 'VALIDATED' | (string & {}); allowedFunctionNames?: string[] }
export interface GeminiGenerateContentToolConfig { functionCallingConfig?: GeminiGenerateContentFunctionCallingConfig; retrievalConfig?: { latLng?: { latitude?: number; longitude?: number }; languageCode?: string }; includeServerSideToolInvocations?: boolean }
export interface GeminiGenerateContentToolGroup {
  functionDeclarations?: GeminiGenerateContentFunctionDeclaration[];
  googleSearch?: { timeRangeFilter?: { startTime?: string; endTime?: string }; searchTypes?: { imageSearch?: Record<string, never>; webSearch?: Record<string, never> } };
  googleSearchRetrieval?: { dynamicRetrievalConfig?: { mode?: string; dynamicThreshold?: number } };
  codeExecution?: Record<string, never>;
  computerUse?: { environment: string; excludedPredefinedFunctions?: string[]; disabledSafetyPolicies?: string[]; enablePromptInjectionDetection?: boolean };
  urlContext?: Record<string, never>;
  fileSearch?: { fileSearchStoreNames: string[]; topK?: number; metadataFilter?: string };
  mcpServers?: { name?: string; streamableHttpTransport?: { url?: string; headers?: Record<string, string>; timeout?: string; sseReadTimeout?: string; terminateOnClose?: boolean } }[];
  googleMaps?: { enableWidget?: boolean };
}
export interface GeminiGenerateContentFunctionDeclaration { name: string; description?: string; parameters?: GeminiGenerateContentSchema; parametersJsonSchema?: unknown; response?: GeminiGenerateContentSchema; responseJsonSchema?: unknown; behavior?: string }
export interface GeminiGenerateContentSafetySetting { category: string; threshold: string }
export interface GeminiGenerateContentSafetyRating { category: string; probability: string; blocked?: boolean }
export interface GeminiGenerateContentCitationMetadata { citationSources?: { startIndex?: number; endIndex?: number; uri?: string; license?: string }[] }
export interface GeminiGenerateContentLogprobCandidate { token?: string; tokenId?: number; logProbability?: number }
export interface GeminiGenerateContentGroundingChunk {
  web?: { uri?: string; title?: string };
  retrievedContext?: { uri?: string; title?: string; text?: string; fileSearchStore?: string; mediaId?: string; pageNumber?: number; customMetadata?: { key?: string; stringValue?: string; numericValue?: number; stringListValue?: { values?: string[] } }[] };
  maps?: { uri?: string; title?: string; text?: string; placeId?: string; placeAnswerSources?: { reviewSnippets?: { reviewId?: string; title?: string; googleMapsUri?: string }[] } };
  image?: { imageUri?: string; sourceUri?: string; domain?: string; title?: string };
}
export interface GeminiGenerateContentGroundingMetadata {
  webSearchQueries?: string[]; imageSearchQueries?: string[];
  searchEntryPoint?: { renderedContent?: string; sdkBlob?: string };
  groundingChunks?: GeminiGenerateContentGroundingChunk[];
  groundingSupports?: { groundingChunkIndices?: number[]; confidenceScores?: number[]; renderedParts?: number[]; segment?: { partIndex?: number; startIndex?: number; endIndex?: number; text?: string } }[];
  retrievalMetadata?: { googleSearchDynamicRetrievalScore?: number };
  googleMapsWidgetContextToken?: string;
}
export interface GeminiGenerateContentCandidate {
  index?: number; content?: GeminiGenerateContentContent;
  finishReason?: GeminiGenerateContentFinishReason; finishMessage?: string;
  safetyRatings?: GeminiGenerateContentSafetyRating[];
  tokenCount?: number; avgLogprobs?: number;
  citationMetadata?: GeminiGenerateContentCitationMetadata;
  logprobsResult?: { chosenCandidates?: GeminiGenerateContentLogprobCandidate[]; topCandidates?: { candidates?: GeminiGenerateContentLogprobCandidate[] }[]; logProbabilitySum?: number };
  groundingMetadata?: GeminiGenerateContentGroundingMetadata;
  groundingAttributions?: { sourceId?: { groundingPassage?: { passageId?: string; partIndex?: number }; semanticRetrieverChunk?: { source?: string; chunk?: string } }; content?: GeminiGenerateContentContent }[];
  urlContextMetadata?: { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] };
}
export type GeminiGenerateContentFinishReason = 'FINISH_REASON_UNSPECIFIED' | 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'LANGUAGE' | 'OTHER' | 'BLOCKLIST' | 'PROHIBITED_CONTENT' | 'SPII' | 'MALFORMED_FUNCTION_CALL' | 'IMAGE_SAFETY' | 'IMAGE_PROHIBITED_CONTENT' | 'IMAGE_OTHER' | 'NO_IMAGE' | 'IMAGE_RECITATION' | 'UNEXPECTED_TOOL_CALL' | 'TOO_MANY_TOOL_CALLS' | 'MISSING_THOUGHT_SIGNATURE' | 'MALFORMED_RESPONSE' | 'ESCALATION' | 'PUP_LIMITED_DISABLED' | (string & {});
export interface GeminiGenerateContentModalityTokenCount { modality?: string; tokenCount?: number }
export interface GeminiGenerateContentUsageMetadata {
  promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number;
  promptTokensDetails?: GeminiGenerateContentModalityTokenCount[]; cacheTokensDetails?: GeminiGenerateContentModalityTokenCount[]; candidatesTokensDetails?: GeminiGenerateContentModalityTokenCount[]; toolUsePromptTokensDetails?: GeminiGenerateContentModalityTokenCount[];
  serviceTier?: string;
}
export interface GeminiGenerateContentResult {
  candidates?: GeminiGenerateContentCandidate[]; usageMetadata?: GeminiGenerateContentUsageMetadata; modelVersion?: string; responseId?: string;
  promptFeedback?: { blockReason?: string; safetyRatings?: GeminiGenerateContentSafetyRating[] };
  modelStatus?: { retirementTime?: string; message?: string; modelStage?: string };
}
export interface GeminiGenerateContentErrorResponse { error: { code: number; message: string; status: string; details?: Record<string, unknown>[] } }
export type GeminiGenerateContentStreamEvent = GeminiGenerateContentResult | GeminiGenerateContentErrorResponse;

export { GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, GEMINI_GENERATE_CONTENT_RESULT_KEYS } from './field-keys.ts';
export { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, collectGeminiGenerateContentProtocolEventsToResult } from './to-result.ts';
export { reassembleGeminiGenerateContentEvents } from './reassemble.ts';
export { geminiGenerateContentProtocolFrameToSSEFrame } from './to-sse.ts';
