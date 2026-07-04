/**
 * Cursor Agent protobuf message types.
 *
 * Field numbers mirror the agent/v1 + aiserver/v1 protos reversed across
 * opencode-cursor-proxy, cursor-byok, and OmniRoute. See
 * cursor-http11-bidi-protocol memory for the endpoint lineage.
 */

import type { SelectedImageInput } from './agent-messages.ts';

export enum AgentMode {
  UNSPECIFIED = 0,
  AGENT = 1,
  ASK = 2,
  PLAN = 3,
  DEBUG = 4,
  TRIAGE = 5,
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface McpExecRequest {
  id: number;
  execId?: string;
  name: string;
  args: Record<string, unknown>;
  toolCallId: string;
  providerIdentifier: string;
  toolName: string;
}

export interface ShellExecRequest {
  type: 'shell';
  id: number;
  execId?: string;
  command: string;
  cwd?: string;
}

export interface LsExecRequest {
  type: 'ls';
  id: number;
  execId?: string;
  path: string;
}

export interface RequestContextExecRequest {
  type: 'request_context';
  id: number;
  execId?: string;
}

export interface ReadExecRequest {
  type: 'read';
  id: number;
  execId?: string;
  path: string;
}

export interface GrepExecRequest {
  type: 'grep';
  id: number;
  execId?: string;
  pattern: string;
  path?: string;
  glob?: string;
}

export interface WriteExecRequest {
  type: 'write';
  id: number;
  execId?: string;
  path: string;
  fileText: string;
  toolCallId?: string;
  returnFileContentAfterWrite?: boolean;
  fileBytes?: Uint8Array;
}

export type ExecRequest =
  | (McpExecRequest & { type: 'mcp' })
  | ShellExecRequest
  | LsExecRequest
  | RequestContextExecRequest
  | ReadExecRequest
  | GrepExecRequest
  | WriteExecRequest;

export interface KvServerMessage {
  id: number;
  messageType: 'get_blob_args' | 'set_blob_args' | 'unknown';
  blobId?: Uint8Array;
  blobData?: Uint8Array;
}

export interface ToolCallInfo {
  callId: string;
  modelCallId?: string;
  toolType: string;
  name: string;
  arguments: string;
}

export interface ParsedToolCall {
  toolType: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedToolCallStarted {
  callId: string;
  modelCallId: string;
  toolCall: ParsedToolCall | null;
}

export interface ParsedPartialToolCall {
  callId: string;
  modelCallId: string;
  argsTextDelta: string;
  toolCall: ParsedToolCall | null;
}

export interface AgentStreamChunk {
  type:
    | 'text'
    | 'thinking'
    | 'token'
    | 'checkpoint'
    | 'done'
    | 'error'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'partial_tool_call'
    | 'exec_request'
    | 'heartbeat'
    | 'exec_server_abort'
    | 'interaction_query'
    | 'kv_blob_assistant';
  content?: string;
  error?: string;
  toolCall?: ToolCallInfo;
  partialArgs?: string;
  execRequest?: ExecRequest;
  queryId?: number;
  queryType?: string;
  blobContent?: string;
  // token chunk: cursor's TokenDeltaUpdate.tokens increment (output ticker).
  tokens?: number;
  // checkpoint chunk: cursor's ConversationTokenDetails — live context
  // occupancy (usedTokens) against the active model's window (maxTokens).
  usedTokens?: number;
  maxTokens?: number;
}

export interface AgentServiceOptions {
  baseUrl?: string;
  privacyMode?: boolean;
  workspacePath?: string;
  clientVersion?: string;
  osVersion?: string;
  shell?: string;
  timezone?: string;
}

export interface AgentChatRequest {
  message: string;
  model?: string;
  mode?: AgentMode;
  conversationId?: string;
  tools?: OpenAIToolDefinition[];
  // Opt into Cursor Max Mode (larger context window) for this turn.
  maxMode?: boolean;
  // Inline images for the current user turn (SelectedContext.selected_images).
  images?: readonly SelectedImageInput[];
}

export interface McpResult {
  success?: { content: string; isError?: boolean };
  error?: string;
}

export interface ShellOutcome {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs?: number;
}

export interface WriteResult {
  success?: {
    path: string;
    linesCreated: number;
    fileSize: number;
    fileContentAfterWrite?: string;
  };
  error?: {
    path: string;
    error: string;
  };
}

export interface BlobAnalysis {
  type: 'json' | 'text' | 'protobuf' | 'binary';
  json?: unknown;
  text?: string;
  protoFields?: Array<{
    num: number;
    wire: number;
    size: number;
    text?: string;
  }>;
}

export interface ParsedInteractionUpdate {
  text: string | null;
  thinking: string | null;
  isComplete: boolean;
  isHeartbeat: boolean;
  // TokenDeltaUpdate.tokens (field 8) — a streamed output-token increment.
  // null when this update carries no token_delta.
  tokenDelta: number | null;
  toolCallStarted: {
    callId: string;
    modelCallId: string;
    toolType: string;
    name: string;
    arguments: string;
  } | null;
  toolCallCompleted: {
    callId: string;
    modelCallId: string;
    toolType: string;
    name: string;
    arguments: string;
  } | null;
  partialToolCall: {
    callId: string;
    argsTextDelta: string;
  } | null;
}
