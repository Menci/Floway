import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWireFetch } from "../../../src/components/playground/playground-logic";

afterEach(() => vi.unstubAllGlobals());

describe("playground provider wire requests", () => {

  it.each([
    {
      name: "Responses",
      path: "/v1/responses",
      model: () => createOpenAI({ baseURL: "/v1", apiKey: "secret", fetch: createWireFetch({ seed: 9 }) }).responses("test-model"),
      events: [
        { type: "response.created", sequence_number: 0, response: { id: "resp_1", object: "response", created_at: 1, model: "test-model", status: "in_progress", output: [], error: null, incomplete_details: null } },
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
        { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
        { type: "response.completed", sequence_number: 4, response: { id: "resp_1", object: "response", created_at: 1, model: "test-model", status: "completed", output: [], error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ],
    },
    {
      name: "Chat Completions",
      path: "/v1/chat/completions",
      model: () => createOpenAI({ baseURL: "/v1", apiKey: "secret", fetch: createWireFetch({ seed: 9 }) }).chat("test-model"),
      events: [
        { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ],
    },
    {
      name: "Messages",
      path: "/v1/messages",
      model: () => createAnthropic({ baseURL: "/v1", apiKey: "secret", fetch: createWireFetch({ metadata: { test: true } }, "messages") })("test-model"),
      events: [
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ],
    },
  ])("streams text from $name and sets stream true", async ({ events, model, path }) => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      const body = events.map((event) => {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        return typeof event === "object" && "type" in event ? `event: ${event.type}\ndata: ${data}` : `data: ${data}`;
      }).join("\n\n") + "\n\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const result = streamText({ model: model(), prompt: "hello", maxRetries: 0 });
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "text-delta") text += part.text;
    }
    expect(text).toBe("ok");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.body));
    expect(body).toMatchObject({ model: "test-model", stream: true });
    if (path === "/v1/messages") expect(body).toMatchObject({ metadata: { test: true } });
    else expect(body).toMatchObject({ seed: 9 });
  });

  it("surfaces provider stream errors instead of treating them as empty text", async () => {
    vi.stubGlobal("fetch", async () => new Response([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"orphaned"}',
      "",
      "",
    ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const model = createOpenAI({ baseURL: "/v1", apiKey: "secret", fetch: createWireFetch({}) }).responses("test-model");
    const result = streamText({ model, prompt: "hello", maxRetries: 0 });

    await expect(async () => {
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
      }
    }).rejects.toBeTruthy();
  });
});
