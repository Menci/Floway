import type { ModelMessage } from "ai";

import type { ApiKey, ControlPlaneModel } from "../../api/types";

export type PlaygroundApi = "responses" | "chatCompletions" | "messages";

export interface PlaygroundMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
}

export interface PlaygroundSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  reasoningEffort?: string;
}

export const playgroundApis: PlaygroundApi[] = ["responses", "chatCompletions", "messages"];

export function effectiveUpstreamCap(
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
): readonly string[] | null {
  if (keyUpstreamIds === null && userUpstreamIds === null) return null;
  if (keyUpstreamIds === null) return userUpstreamIds;
  if (userUpstreamIds === null) return keyUpstreamIds;
  const userSet = new Set(userUpstreamIds);
  return keyUpstreamIds.filter((id) => userSet.has(id));
}

function realModelReachable(model: ControlPlaneModel, cap: readonly string[] | null): boolean {
  return cap === null || model.upstreams.some((binding) => cap.includes(binding.id));
}

export function isReachableUnderCap(
  model: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): boolean {
  if (!model.aliasedFrom) return realModelReachable(model, cap);
  return model.aliasedFrom.targets.some((target) => {
    const resolved = catalog.find(
      (candidate) => candidate.id === target.target_model_id && !candidate.aliasedFrom,
    );
    return resolved ? realModelReachable(resolved, cap) : false;
  });
}

export function availableModels(
  catalog: readonly ControlPlaneModel[],
  key: ApiKey | null,
  userUpstreamIds: readonly string[] | null,
  api: PlaygroundApi,
): ControlPlaneModel[] {
  const cap = effectiveUpstreamCap(key?.upstream_ids ?? null, userUpstreamIds);
  return catalog.filter(
    (model) => model.kind === "chat" && api in model.endpoints && isReachableUnderCap(model, catalog, cap),
  );
}

export function supportsImageInput(model: ControlPlaneModel | null): boolean {
  const modalities = model?.chat?.modalities?.input;
  return modalities === undefined || modalities.includes("image");
}

export function maximumOutputTokens(model: ControlPlaneModel | null): number | undefined {
  return model?.limits.max_output_tokens;
}

const reservedFields: Record<PlaygroundApi, readonly string[]> = {
  chatCompletions: ["model", "messages", "stream"],
  responses: ["model", "input", "instructions", "stream"],
  messages: ["model", "messages", "system", "stream"],
};

export type CustomJsonResult =
  | { value: Record<string, unknown>; error: null }
  | { value: null; error: "invalid" | "object" | "reserved"; fields?: string[] };

export function parseCustomJson(api: PlaygroundApi, source: string): CustomJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { value: null, error: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: null, error: "object" };
  }
  const fields = reservedFields[api].filter((field) => Object.hasOwn(parsed, field));
  if (fields.length) return { value: null, error: "reserved", fields };
  return { value: parsed as Record<string, unknown>, error: null };
}

export function mergeWireBody(body: BodyInit | null | undefined, custom: Record<string, unknown>): string {
  if (typeof body !== "string") throw new Error("Playground provider produced a non-JSON request body.");
  const generated = JSON.parse(body) as unknown;
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    throw new Error("Playground provider produced an invalid request body.");
  }
  return JSON.stringify({ ...(generated as Record<string, unknown>), ...custom });
}

function normalizeMessagesSseLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const source = line.slice(5).trimStart();
  try {
    const event = JSON.parse(source) as {
      type?: string;
      message?: { usage?: Record<string, unknown> };
    };
    if (event.type !== "message_start" || !event.message) return line;
    event.message.usage = {
      input_tokens: 0,
      ...event.message.usage,
    };
    return `data: ${JSON.stringify(event)}`;
  } catch {
    return line;
  }
}

function normalizeMessagesStream(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  let pending = "";
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(`${normalizeMessagesSseLine(line)}\n`);
      },
      flush(controller) {
        if (pending) controller.enqueue(normalizeMessagesSseLine(pending));
      },
    }))
    .pipeThrough(new TextEncoderStream());
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeResponsesBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.input)) return body;
    obj.input = (obj.input as unknown[]).map((item: unknown) => {
      if (item && typeof item === "object" && "role" in item && !("type" in item)) {
        return { type: "message", ...(item as Record<string, unknown>) };
      }
      return item;
    });
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

export function createWireFetch(custom: Record<string, unknown>, api?: PlaygroundApi): typeof fetch {
  return async (input, init) => {
    const normalized = api === "responses" ? normalizeResponsesBody(init?.body) : init?.body;
    const response = await fetch(input, { ...init, body: mergeWireBody(normalized, custom) });
    return api === "messages" ? normalizeMessagesStream(response) : response;
  };
}

export function toModelMessages(messages: readonly PlaygroundMessage[]): ModelMessage[] {
  return messages.map((message, index) => {
    if (message.role === "assistant") return { role: "assistant", content: message.text };
    const isLatest = index === messages.length - 1;
    if (!isLatest || !message.imageUrl) return { role: "user", content: message.text };
    return {
      role: "user",
      content: [
        ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
        { type: "image" as const, image: new URL(message.imageUrl) },
      ],
    };
  });
}

export function generationOptions(api: PlaygroundApi, settings: PlaygroundSettings): {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  providerOptions?: Record<string, Record<string, string>>;
} {
  const common = {
    ...(settings.temperature !== undefined && { temperature: settings.temperature }),
    ...(settings.maxOutputTokens !== undefined && { maxOutputTokens: settings.maxOutputTokens }),
    ...(settings.topP !== undefined && { topP: settings.topP }),
    ...(api !== "messages" && settings.frequencyPenalty !== undefined && { frequencyPenalty: settings.frequencyPenalty }),
    ...(api !== "messages" && settings.presencePenalty !== undefined && { presencePenalty: settings.presencePenalty }),
    ...(settings.stopSequences?.length && { stopSequences: settings.stopSequences }),
  };
  if (!settings.reasoningEffort) return common;
  const providerOptions: Record<string, Record<string, string>> = api === "messages"
    ? { anthropic: { effort: settings.reasoningEffort } }
    : { openai: { reasoningEffort: settings.reasoningEffort } };
  return { ...common, providerOptions };
}
