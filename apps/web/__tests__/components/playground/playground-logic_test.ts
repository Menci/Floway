import { describe, expect, it } from "vitest";

import type { ApiKey, ControlPlaneModel } from "../../../src/api/types";
import {
  availableModels,
  effectiveUpstreamCap,
  generationOptions,
  maximumOutputTokens,
  mergeWireBody,
  parseCustomJson,
  supportsImageInput,
} from "../../../src/components/playground/playground-logic";

const model = (id: string, upstreams: string[], extra: Partial<ControlPlaneModel> = {}): ControlPlaneModel => ({
  id, object: "model", type: "model", display_name: id, kind: "chat", limits: {},
  endpoints: { responses: {}, chatCompletions: {}, messages: {} },
  upstreams: upstreams.map((upstream) => ({ id: upstream, name: upstream, kind: "custom", color: null })),
  ...extra,
});
const key = (upstream_ids: string[] | null): ApiKey => ({
  id: "key", name: "Key", key: "secret", created_at: "", last_used_at: null,
  upstream_ids, dump_retention_seconds: null,
});

describe("playground reachability", () => {
  it("intersects key and user caps", () => {
    expect(effectiveUpstreamCap(null, null)).toBeNull();
    expect(effectiveUpstreamCap(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(effectiveUpstreamCap(null, ["a"])).toEqual(["a"]);
  });

  it("resolves aliases and filters endpoint support", () => {
    const real = model("real", ["a"], { endpoints: { responses: {} } });
    const alias = model("alias", [], {
      endpoints: { responses: {} },
      aliasedFrom: { selection: "first-available", targets: [{ target_model_id: "real", rules: {} }] },
    });
    const chatOnly = model("chat", ["a"], { endpoints: { chatCompletions: {} } });
    expect(availableModels([real, alias, chatOnly], key(["a"]), ["a"], "responses").map((m) => m.id))
      .toEqual(["real", "alias"]);
    expect(availableModels([real, alias], key(["b"]), null, "responses")).toEqual([]);
  });
});

describe("custom JSON", () => {
  it("rejects invalid, non-object and reserved fields", () => {
    expect(parseCustomJson("responses", "{").error).toBe("invalid");
    expect(parseCustomJson("messages", "[]").error).toBe("object");
    expect(parseCustomJson("chatCompletions", '{"stream":false}')).toMatchObject({ error: "reserved", fields: ["stream"] });
  });

  it("overrides generated wire fields", () => {
    expect(JSON.parse(mergeWireBody('{"model":"m","temperature":0.2}', { temperature: 0.9, seed: 2 })))
      .toEqual({ model: "m", temperature: 0.9, seed: 2 });
  });
});

describe("parameters and capabilities", () => {
  it("maps reasoning and omits unsupported Messages penalties", () => {
    expect(generationOptions("responses", { reasoningEffort: "high" })).toMatchObject({ providerOptions: { openai: { reasoningEffort: "high" } } });
    expect(generationOptions("messages", { reasoningEffort: "max", frequencyPenalty: 1 })).toEqual({ providerOptions: { anthropic: { effort: "max" } } });
  });

  it("reads image and output limits conservatively", () => {
    expect(supportsImageInput(model("unknown", []))).toBe(true);
    expect(supportsImageInput(model("text", [], { chat: { modalities: { input: ["text"], output: ["text"] } } }))).toBe(false);
    expect(maximumOutputTokens(model("limited", [], { limits: { max_output_tokens: 4096 } }))).toBe(4096);
  });
});
