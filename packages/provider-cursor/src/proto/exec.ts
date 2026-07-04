/**
 * ExecServerMessage / ExecClientMessage encoding.
 *
 * The Cursor backend sends ExecServerMessage (AgentServerMessage field 2) to
 * request a tool execution; the client replies with ExecClientMessage
 * (AgentClientMessage field 2) carrying the result, then a stream-close
 * control message (AgentClientMessage field 5).
 *
 * Workers-clean: environment facts come via RequestContextEnv — no
 * process.cwd() / node:os / process.env reads here.
 */

import type { RequestContextEnv } from './agent-messages.ts';
import { TEXT_DECODER, parseProtoFields, parseProtobufValue, type ParsedField } from './decoding.ts';
import {
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  concatBytes,
} from './encoding.ts';
import type {
  ExecRequest,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  McpResult,
  WriteResult,
} from './types.ts';

// String helper for length-delimited wire fields. Returns undefined when the
// field is absent — callers coalesce with a default when the proto contract
// treats missing as empty string.
function strField(fields: ParsedField[], num: number): string | undefined {
  for (const f of fields) {
    if (f.fieldNumber === num && f.wireType === 2 && f.value instanceof Uint8Array) {
      return TEXT_DECODER.decode(f.value);
    }
  }
  return undefined;
}

function parseShellArgs(data: Uint8Array): { command: string; cwd?: string } {
  const fields = parseProtoFields(data);
  return { command: strField(fields, 1) ?? '', cwd: strField(fields, 2) };
}

function parseLsArgs(data: Uint8Array): { path: string } {
  return { path: strField(parseProtoFields(data), 1) ?? '' };
}

function parseReadArgs(data: Uint8Array): { path: string } {
  return { path: strField(parseProtoFields(data), 1) ?? '' };
}

function parseGrepArgs(data: Uint8Array): { pattern: string; path?: string; glob?: string } {
  const fields = parseProtoFields(data);
  return {
    pattern: strField(fields, 1) ?? '',
    path: strField(fields, 2),
    glob: strField(fields, 3),
  };
}

function parseWriteArgs(data: Uint8Array): {
  path: string;
  fileText: string;
  toolCallId?: string;
  returnFileContentAfterWrite?: boolean;
  fileBytes?: Uint8Array;
} {
  const fields = parseProtoFields(data);
  let returnFileContentAfterWrite: boolean | undefined;
  let fileBytes: Uint8Array | undefined;

  for (const field of fields) {
    if (field.fieldNumber === 4 && field.wireType === 0) {
      returnFileContentAfterWrite = field.value === 1;
    } else if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      fileBytes = field.value;
    }
  }

  return {
    path: strField(fields, 1) ?? '',
    fileText: strField(fields, 2) ?? '',
    toolCallId: strField(fields, 3),
    returnFileContentAfterWrite,
    fileBytes,
  };
}

function parseMcpArgs(data: Uint8Array): Omit<McpExecRequest, 'id' | 'execId'> {
  const fields = parseProtoFields(data);
  const args: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const entryFields = parseProtoFields(field.value);
      const key = strField(entryFields, 1);
      let value: unknown = undefined;
      for (const ef of entryFields) {
        if (ef.fieldNumber === 2 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          value = parseProtobufValue(ef.value);
        }
      }
      if (key) args[key] = value;
    }
  }

  return {
    name: strField(fields, 1) ?? '',
    args,
    toolCallId: strField(fields, 3) ?? '',
    providerIdentifier: strField(fields, 4) ?? '',
    toolName: strField(fields, 5) ?? '',
  };
}

/**
 * Parse an ExecServerMessage into a typed ExecRequest.
 *
 * Field 1 = id (uint32), field 15 = exec_id (string). The oneof tool payload
 * is carried in a tool-type-specific field (2/14 shell, 3 write, 5 grep,
 * 7 read, 8 ls, 10 request_context, 11 mcp).
 */
export function parseExecServerMessage(data: Uint8Array): ExecRequest | null {
  const fields = parseProtoFields(data);
  let id = 0;
  let result: ExecRequest | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      id = field.value as number;
      break;
    }
  }
  const execId = strField(fields, 15);

  for (const field of fields) {
    if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;

    switch (field.fieldNumber) {
    case 2:
    case 14: {
      const shellArgs = parseShellArgs(field.value);
      result = { type: 'shell', id, execId, command: shellArgs.command, cwd: shellArgs.cwd } as ShellExecRequest;
      break;
    }
    case 3: {
      const writeArgs = parseWriteArgs(field.value);
      result = {
        type: 'write',
        id,
        execId,
        path: writeArgs.path,
        fileText: writeArgs.fileText,
        toolCallId: writeArgs.toolCallId,
        returnFileContentAfterWrite: writeArgs.returnFileContentAfterWrite,
        fileBytes: writeArgs.fileBytes,
      } as WriteExecRequest;
      break;
    }
    case 5: {
      const grepArgs = parseGrepArgs(field.value);
      result = {
        type: 'grep',
        id,
        execId,
        pattern: grepArgs.pattern,
        path: grepArgs.path,
        glob: grepArgs.glob,
      } as GrepExecRequest;
      break;
    }
    case 7: {
      const readArgs = parseReadArgs(field.value);
      result = { type: 'read', id, execId, path: readArgs.path } as ReadExecRequest;
      break;
    }
    case 8: {
      const lsArgs = parseLsArgs(field.value);
      result = { type: 'ls', id, execId, path: lsArgs.path } as LsExecRequest;
      break;
    }
    case 10: {
      result = { type: 'request_context', id, execId };
      break;
    }
    case 11: {
      const mcpArgs = parseMcpArgs(field.value);
      result = { type: 'mcp', id, execId, ...mcpArgs } as McpExecRequest & { type: 'mcp' };
      break;
    }
    }

    if (result) break;
  }

  return result;
}

// --- Result encoders ---

// Every build*Result wraps its inner encoding with the same 3-part envelope:
// id (field 1, uint32), optional exec_id (field 15, string), and the
// tool-specific inner message on a per-tool field number.
function wrapExecClient(id: number, execId: string | undefined, innerField: number, innerBytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(innerField, innerBytes));
  return concatBytes(...parts);
}

function encodeMcpTextContent(text: string): Uint8Array {
  return encodeStringField(1, text);
}

function encodeMcpToolResultContentItem(text: string): Uint8Array {
  const textContent = encodeMcpTextContent(text);
  return encodeMessageField(1, textContent);
}

function encodeMcpSuccess(content: string, isError = false): Uint8Array {
  const parts: Uint8Array[] = [];
  const contentItem = encodeMcpToolResultContentItem(content);
  parts.push(encodeMessageField(1, contentItem));
  if (isError) {
    parts.push(encodeBoolField(2, true));
  }
  return concatBytes(...parts);
}

function encodeMcpError(error: string): Uint8Array {
  return encodeStringField(1, error);
}

function encodeMcpResult(result: McpResult): Uint8Array {
  if (result.success) {
    const success = encodeMcpSuccess(result.success.content, result.success.isError);
    return encodeMessageField(1, success);
  }
  if (result.error) {
    const error = encodeMcpError(result.error);
    return encodeMessageField(2, error);
  }
  return encodeMessageField(1, encodeMcpSuccess(''));
}

export function buildExecClientMessageWithMcpResult(
  id: number,
  execId: string | undefined,
  result: McpResult,
): Uint8Array {
  return wrapExecClient(id, execId, 11, encodeMcpResult(result));
}

function encodeShellResult(
  command: string,
  cwd: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  executionTimeMs?: number,
): Uint8Array {
  const shellOutcome = concatBytes(
    encodeStringField(1, command),
    encodeStringField(2, cwd),
    encodeInt32Field(3, exitCode),
    encodeStringField(4, ''),
    encodeStringField(5, stdout),
    encodeStringField(6, stderr),
    executionTimeMs ? encodeInt32Field(7, executionTimeMs) : new Uint8Array(0),
  );
  const resultField = exitCode === 0 ? 1 : 2;
  return encodeMessageField(resultField, shellOutcome);
}

function buildExecClientMessageWithShellResult(
  id: number,
  execId: string | undefined,
  command: string,
  cwd: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  executionTimeMs?: number,
): Uint8Array {
  return wrapExecClient(id, execId, 2, encodeShellResult(command, cwd, stdout, stderr, exitCode, executionTimeMs));
}

function encodeLsResult(filesString: string): Uint8Array {
  const lsSuccess = encodeStringField(1, filesString);
  return encodeMessageField(1, lsSuccess);
}

function buildExecClientMessageWithLsResult(
  id: number,
  execId: string | undefined,
  filesString: string,
): Uint8Array {
  return wrapExecClient(id, execId, 8, encodeLsResult(filesString));
}

function encodeRequestContextResult(env: RequestContextEnv): Uint8Array {
  const envBytes = concatBytes(
    encodeStringField(1, env.osVersion),
    encodeStringField(2, env.workspacePath),
    encodeStringField(3, env.shell),
    encodeStringField(10, env.timezone),
    encodeStringField(11, env.workspacePath),
  );

  const requestContext = encodeMessageField(4, envBytes);
  const success = encodeMessageField(1, requestContext);
  return encodeMessageField(1, success);
}

export function buildExecClientMessageWithRequestContextResult(
  id: number,
  execId: string | undefined,
  env: RequestContextEnv,
): Uint8Array {
  return wrapExecClient(id, execId, 10, encodeRequestContextResult(env));
}

function encodeReadResult(
  content: string,
  path: string,
  totalLines?: number,
  fileSize?: bigint,
  truncated?: boolean,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, path));
  parts.push(encodeStringField(2, content));
  if (totalLines !== undefined && totalLines > 0) {
    parts.push(encodeInt32Field(3, totalLines));
  }
  if (fileSize !== undefined) {
    parts.push(encodeInt64Field(4, fileSize));
  }
  if (truncated) {
    parts.push(encodeBoolField(6, true));
  }
  const readSuccess = concatBytes(...parts);
  return encodeMessageField(1, readSuccess);
}

function buildExecClientMessageWithReadResult(
  id: number,
  execId: string | undefined,
  content: string,
  path: string,
  totalLines?: number,
  fileSize?: bigint,
  truncated?: boolean,
): Uint8Array {
  return wrapExecClient(id, execId, 7, encodeReadResult(content, path, totalLines, fileSize, truncated));
}

function encodeGrepFilesResult(files: string[], totalFiles: number, truncated = false): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(encodeStringField(1, file));
  }
  parts.push(encodeInt32Field(2, totalFiles));
  if (truncated) {
    parts.push(encodeBoolField(3, true));
  }
  return concatBytes(...parts);
}

function encodeGrepUnionResult(files: string[], totalFiles: number, truncated = false): Uint8Array {
  const filesResult = encodeGrepFilesResult(files, totalFiles, truncated);
  return encodeMessageField(2, filesResult);
}

function encodeGrepSuccess(pattern: string, path: string, files: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, pattern));
  parts.push(encodeStringField(2, path));
  parts.push(encodeStringField(3, 'files_with_matches'));
  const unionResult = encodeGrepUnionResult(files, files.length);
  const mapEntry = concatBytes(encodeStringField(1, path), encodeMessageField(2, unionResult));
  parts.push(encodeMessageField(4, mapEntry));
  return concatBytes(...parts);
}

function encodeGrepResult(pattern: string, path: string, files: string[]): Uint8Array {
  const success = encodeGrepSuccess(pattern, path, files);
  return encodeMessageField(1, success);
}

function buildExecClientMessageWithGrepResult(
  id: number,
  execId: string | undefined,
  pattern: string,
  path: string,
  files: string[],
): Uint8Array {
  return wrapExecClient(id, execId, 5, encodeGrepResult(pattern, path, files));
}

function encodeWriteSuccess(
  path: string,
  linesCreated: number,
  fileSize: number,
  fileContentAfterWrite?: string,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, path));
  parts.push(encodeInt32Field(2, linesCreated));
  parts.push(encodeInt32Field(3, fileSize));
  if (fileContentAfterWrite) {
    parts.push(encodeStringField(4, fileContentAfterWrite));
  }
  return concatBytes(...parts);
}

function encodeWriteError(path: string, error: string): Uint8Array {
  return concatBytes(encodeStringField(1, path), encodeStringField(2, error));
}

function encodeWriteResult(result: WriteResult): Uint8Array {
  if (result.success) {
    const success = encodeWriteSuccess(
      result.success.path,
      result.success.linesCreated,
      result.success.fileSize,
      result.success.fileContentAfterWrite,
    );
    return encodeMessageField(1, success);
  }
  if (result.error) {
    const error = encodeWriteError(result.error.path, result.error.error);
    return encodeMessageField(5, error);
  }
  return encodeMessageField(1, encodeWriteSuccess('', 0, 0));
}

function buildExecClientMessageWithWriteResult(
  id: number,
  execId: string | undefined,
  result: WriteResult,
): Uint8Array {
  return wrapExecClient(id, execId, 3, encodeWriteResult(result));
}

// --- Rejected-tool encoders ---
//
// Floway is a stateless gateway: it cannot execute Cursor's built-in agent
// tools (shell/read/write/grep/ls). When the backend requests one, we reply
// with a result that signals "unavailable" so the model can adapt and keep
// streaming, then close the exec stream. request_context is environmental
// metadata, not a tool — it gets a real (placeholder-env) response upstream,
// not a rejection.

/**
 * Build an ExecClientMessage that rejects a built-in tool request with the
 * given reason. `mcp` and `request_context` are not rejected here — mcp is
 * translated to downstream tool_calls (no reply sent on this channel), and
 * request_context is answered with the gateway env.
 */
export function buildExecClientMessageWithRejectedTool(
  execRequest: ExecRequest,
  reason: string,
): Uint8Array {
  switch (execRequest.type) {
  case 'shell':
    return buildExecClientMessageWithShellResult(
      execRequest.id,
      execRequest.execId,
      execRequest.command,
      execRequest.cwd ?? '',
      '',
      reason,
      1,
    );
  case 'read':
    return buildExecClientMessageWithReadResult(
      execRequest.id,
      execRequest.execId,
      `[tool unavailable: ${reason}]`,
      execRequest.path,
    );
  case 'grep':
    return buildExecClientMessageWithGrepResult(
      execRequest.id,
      execRequest.execId,
      execRequest.pattern,
      execRequest.path ?? '',
      [],
    );
  case 'ls':
    return buildExecClientMessageWithLsResult(
      execRequest.id,
      execRequest.execId,
      `[tool unavailable: ${reason}]`,
    );
  case 'write':
    return buildExecClientMessageWithWriteResult(execRequest.id, execRequest.execId, {
      error: { path: execRequest.path, error: reason },
    });
  case 'mcp':
    return buildExecClientMessageWithMcpResult(execRequest.id, execRequest.execId, {
      error: reason,
    });
  case 'request_context':
    // Caller should answer with env, not reject. Fall through to mcp-style
    // error as a defensive last resort.
    return buildExecClientMessageWithMcpResult(execRequest.id, execRequest.execId, { error: reason });
  }
}

// --- Control / wrapper messages ---

export function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

function encodeExecClientStreamClose(id: number): Uint8Array {
  return encodeUint32Field(1, id);
}

export function buildExecClientControlMessage(id: number): Uint8Array {
  const streamClose = encodeExecClientStreamClose(id);
  return encodeMessageField(1, streamClose);
}

export function buildAgentClientMessageWithExecControl(execClientControlMessage: Uint8Array): Uint8Array {
  return encodeMessageField(5, execClientControlMessage);
}
