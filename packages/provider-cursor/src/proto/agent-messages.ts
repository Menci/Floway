import {
  encodeStringField,
  encodeInt32Field,
  encodeMessageField,
  encodeBoolField,
  concatBytes,
  encodeProtobufValue,
} from './encoding.ts';
import { AgentMode } from './types.ts';
import type { OpenAIToolDefinition } from './types.ts';

/**
 * AgentClientMessage + AgentRunRequest encoding.
 *
 * Workers-clean: environment facts (os/shell/cwd/timezone) are passed in via
 * RequestContextEnv — no process.cwd() / node:os / process.env reads here.
 */

const MCP_PROVIDER = 'cursor-tools';

export interface RequestContextEnv {
  workspacePath: string;
  osVersion: string;
  shell: string;
  timezone: string;
}

export function encodeMcpToolDefinition(tool: OpenAIToolDefinition, providerIdentifier = MCP_PROVIDER): Uint8Array {
  const toolName = tool.function.name;
  const combinedName = `${providerIdentifier}-${toolName}`;
  const description = tool.function.description ?? '';
  const inputSchema = tool.function.parameters ?? { type: 'object', properties: {} };

  const parts: Uint8Array[] = [
    encodeStringField(1, combinedName),
    encodeStringField(2, description),
  ];

  if (inputSchema) {
    const schemaValue = encodeProtobufValue(inputSchema);
    parts.push(encodeMessageField(3, schemaValue));
  }

  parts.push(encodeStringField(4, providerIdentifier));
  parts.push(encodeStringField(5, toolName));

  return concatBytes(...parts);
}

export function buildRequestContextEnv(env: RequestContextEnv): Uint8Array {
  return concatBytes(
    encodeStringField(1, env.osVersion),
    encodeStringField(2, env.workspacePath),
    encodeStringField(3, env.shell),
    encodeStringField(10, env.timezone),
    encodeStringField(11, env.workspacePath),
  );
}

export function encodeMcpInstructions(serverName: string, instructions: string): Uint8Array {
  return concatBytes(encodeStringField(1, serverName), encodeStringField(2, instructions));
}

export function buildRequestContext(env: RequestContextEnv, tools?: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];

  const envBytes = buildRequestContextEnv(env);
  parts.push(encodeMessageField(4, envBytes));

  if (tools && tools.length > 0) {
    for (const tool of tools) {
      const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
      parts.push(encodeMessageField(7, mcpTool));
    }

    const toolDescriptions = tools
      .map(t => `- ${t.function.name}: ${t.function.description ?? 'No description'}`)
      .join('\n');
    const instructions = `You have access to the following tools:\n${toolDescriptions}\n\nUse these tools when appropriate to help the user.`;

    const mcpInstr = encodeMcpInstructions(MCP_PROVIDER, instructions);
    parts.push(encodeMessageField(14, mcpInstr));
  }

  return concatBytes(...parts);
}

export interface SelectedImageInput {
  data: Uint8Array;
  mimeType: string;
}

// SelectedImage (agent.v1): inline image bytes. uuid=2, mime_type=7, and the
// raw bytes ride the `data_or_blob_id` oneof at data=8 (length-delimited, same
// wire form as an embedded message). dimension is optional and omitted.
export function encodeSelectedImage(image: SelectedImageInput): Uint8Array {
  return concatBytes(
    encodeStringField(2, crypto.randomUUID()),
    encodeStringField(7, image.mimeType),
    encodeMessageField(8, image.data),
  );
}

// SelectedContext: selected_images is the repeated field 1.
export function encodeSelectedContext(images: readonly SelectedImageInput[]): Uint8Array {
  return concatBytes(...images.map(img => encodeMessageField(1, encodeSelectedImage(img))));
}

export function encodeUserMessage(text: string, messageId: string, mode: AgentMode = AgentMode.ASK, images?: readonly SelectedImageInput[]): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, text), encodeStringField(2, messageId)];
  // UserMessage.selected_context = 3 (before mode to keep ascending field order).
  if (images && images.length > 0) parts.push(encodeMessageField(3, encodeSelectedContext(images)));
  parts.push(encodeInt32Field(4, mode));
  return concatBytes(...parts);
}

export function encodeUserMessageAction(userMessage: Uint8Array, requestContext: Uint8Array): Uint8Array {
  return concatBytes(encodeMessageField(1, userMessage), encodeMessageField(2, requestContext));
}

export function encodeConversationAction(userMessageAction: Uint8Array): Uint8Array {
  return encodeMessageField(1, userMessageAction);
}

export function encodeModelDetails(modelId: string, maxMode?: boolean): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, modelId)];
  // ModelDetails.max_mode (field 7): opt into Cursor's Max Mode — the larger
  // context window / higher-cost tier. Only emitted when enabled so the default
  // wire shape is unchanged.
  if (maxMode) parts.push(encodeBoolField(7, true));
  return concatBytes(...parts);
}

export function encodeMcpTools(tools: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const tool of tools) {
    const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
    parts.push(encodeMessageField(1, mcpTool));
  }
  return concatBytes(...parts);
}

export function encodeMcpDescriptor(
  serverName: string,
  serverIdentifier: string,
  folderPath?: string,
  serverUseInstructions?: string,
): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, serverName), encodeStringField(2, serverIdentifier)];

  if (folderPath) {
    parts.push(encodeStringField(3, folderPath));
  }

  if (serverUseInstructions) {
    parts.push(encodeStringField(4, serverUseInstructions));
  }

  return concatBytes(...parts);
}

export interface McpDescriptorInput {
  serverName: string;
  serverIdentifier: string;
  folderPath?: string;
  serverUseInstructions?: string;
}

export function encodeMcpFileSystemOptions(
  enabled: boolean,
  workspaceProjectDir: string,
  mcpDescriptors: McpDescriptorInput[],
): Uint8Array {
  const parts: Uint8Array[] = [];

  if (enabled) {
    parts.push(encodeBoolField(1, true));
  }

  if (workspaceProjectDir) {
    parts.push(encodeStringField(2, workspaceProjectDir));
  }

  for (const descriptor of mcpDescriptors) {
    const encodedDescriptor = encodeMcpDescriptor(
      descriptor.serverName,
      descriptor.serverIdentifier,
      descriptor.folderPath,
      descriptor.serverUseInstructions,
    );
    parts.push(encodeMessageField(3, encodedDescriptor));
  }

  return concatBytes(...parts);
}

export function encodeAgentRunRequest(
  action: Uint8Array,
  modelDetails: Uint8Array,
  conversationId: string | undefined,
  tools: OpenAIToolDefinition[] | undefined,
  workspacePath: string | undefined,
): Uint8Array {
  // ConversationState: empty message on the wire.
  const parts: Uint8Array[] = [
    encodeMessageField(1, new Uint8Array(0)),
    encodeMessageField(2, action),
    encodeMessageField(3, modelDetails),
  ];

  if (tools && tools.length > 0) {
    const mcpToolsWrapper = encodeMcpTools(tools);
    parts.push(encodeMessageField(4, mcpToolsWrapper));
  }

  if (conversationId) {
    parts.push(encodeStringField(5, conversationId));
  }

  if (tools && tools.length > 0 && workspacePath) {
    const mcpDescriptors: McpDescriptorInput[] = [
      {
        serverName: 'Cursor Tools',
        serverIdentifier: MCP_PROVIDER,
        folderPath: workspacePath,
        serverUseInstructions: 'Use these tools to assist the user with their coding tasks.',
      },
    ];
    const mcpFsOptions = encodeMcpFileSystemOptions(true, workspacePath, mcpDescriptors);
    parts.push(encodeMessageField(6, mcpFsOptions));
  }

  return concatBytes(...parts);
}

export function encodeAgentClientMessage(runRequest: Uint8Array): Uint8Array {
  return encodeMessageField(1, runRequest);
}
