/**
 * Cursor Agent protobuf codec barrel.
 *
 * 1:1 mapping of opencode-cursor-proxy's proto/ module, Workers-clean:
 * Uint8Array + DataView + Web Crypto, no Buffer / node:os / process.cwd.
 */

export {
  encodeVarint,
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  encodeDoubleField,
  concatBytes,
  encodeProtobufValue,
  bytesToHex,
  hexToBytes,
} from './encoding.ts';

export { decodeVarint, parseProtoFields, parseProtobufValue, parseProtobufStruct, parseProtobufListValue } from './decoding.ts';
export type { ParsedField } from './decoding.ts';

export {
  addConnectEnvelope,
  readConnectFrame,
  isTrailerFrame,
  isCompressedFrame,
  parseTrailerMetadata,
  decompressGzip,
  FLAG_COMPRESSED,
  FLAG_END_STREAM,
  FLAG_TRAILER,
} from './envelope.ts';
export type { ConnectFrame } from './envelope.ts';

export { AgentMode } from './types.ts';
export type {
  OpenAIToolDefinition,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  RequestContextExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  ExecRequest,
  KvServerMessage,
  ToolCallInfo,
  ParsedToolCall,
  ParsedToolCallStarted,
  ParsedPartialToolCall,
  AgentStreamChunk,
  AgentServiceOptions,
  AgentChatRequest,
  McpResult,
  ShellOutcome,
  WriteResult,
  BlobAnalysis,
  ParsedInteractionUpdate,
} from './types.ts';

export {
  parseExecServerMessage,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithRejectedTool,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
} from './exec.ts';

export { TOOL_FIELD_MAP, TOOL_ARG_SCHEMA, parseToolCall, parseToolCallStartedUpdate, parsePartialToolCallUpdate } from './tool-calls.ts';

export { parseKvServerMessage, buildKvClientMessage, buildAgentClientMessageWithKv, analyzeBlobData, extractAssistantContent } from './kv.ts';
export type { AssistantBlobContent } from './kv.ts';

export { encodeBidiRequestId, encodeBidiAppendRequest } from './bidi.ts';

export {
  encodeMcpToolDefinition,
  buildRequestContextEnv,
  encodeMcpInstructions,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeModelDetails,
  encodeMcpTools,
  encodeMcpDescriptor,
  encodeMcpFileSystemOptions,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
} from './agent-messages.ts';
export type { McpDescriptorInput, RequestContextEnv } from './agent-messages.ts';

export { parseInteractionUpdate, parseCheckpointTokenDetails } from './interaction.ts';
