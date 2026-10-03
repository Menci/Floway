#!/usr/bin/env python3

# Convert a Floway /v1/models payload (stdin) into opencode provider settings.
#
# Usage:
#   curl -H 'Authorization: Bearer <TOKEN>' http://localhost:18088/v1/models | ./floway-to-opencode.py [NAME] [API_URL]
#   defaults: NAME=Floway, API_URL=http://localhost:18088/v1

import json
import sys

DEFAULT_UPSTREAM_NAME = "Floway"
DEFAULT_API_URL = "http://localhost:18088/v1"
DEFAULT_CONTEXT_WINDOW = 262144
DEFAULT_MAX_OUTPUT = 65536


def model_config(model):
    rates = {}
    for entry in model.get("pricing", {}).get("entries", []):
        if not entry.get("selector"):
            rates = entry.get("rates", {})
            break
    chat = model.get("chat", {})
    limits = model.get("limits", {})

    config = {
        "id": model["id"],
        "name": model.get("display_name") or model["id"],
        "tool_call": True,
        "limit": {
            "context": limits.get("max_context_window_tokens", DEFAULT_CONTEXT_WINDOW),
            "output": limits.get("max_output_tokens", DEFAULT_MAX_OUTPUT),
        },
    }
    if limits.get("max_prompt_tokens") is not None:
        config["limit"]["input"] = limits["max_prompt_tokens"]
    if chat.get("reasoning"):
        config["reasoning"] = True
        effort = chat["reasoning"].get("effort")
        if effort and effort.get("supported"):
            # opencode exposes reasoning effort levels as model variants, each
            # mapping the level name to the wire `reasoningEffort` it sends.
            # Ref: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts
            config["variants"] = {
                level: {"reasoningEffort": level} for level in effort["supported"]
            }
            # opencode also derives default low/medium/high (and max for
            # deepseek-v4) variants heuristically; disable the ones this model
            # does not actually support so the picker only offers real levels.
            for level in ("low", "medium", "high", "max"):
                if level not in effort["supported"]:
                    config["variants"].setdefault(level, {})["disabled"] = True
    if "image" in chat.get("modalities", {}).get("input", []):
        config["attachment"] = True
    modalities = chat.get("modalities")
    if modalities and (modalities.get("input") or modalities.get("output")):
        config["modalities"] = {
            "input": list(modalities.get("input", [])),
            "output": list(modalities.get("output", [])),
        }
    if model.get("created_at"):
        config["release_date"] = model["created_at"][:10]

    if "input_tokens" in rates and "output_tokens" in rates:
        cost = {
            "input": float(rates["input_tokens"]) * 1e6,
            "output": float(rates["output_tokens"]) * 1e6,
        }
        if "input_cache_read_tokens" in rates:
            cost["cache_read"] = float(rates["input_cache_read_tokens"]) * 1e6
        if "input_cache_write_tokens" in rates:
            cost["cache_write"] = float(rates["input_cache_write_tokens"]) * 1e6
        config["cost"] = cost

    return config


def main():
    upstream = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UPSTREAM_NAME
    api_url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_URL
    models = [
        m
        for m in json.load(sys.stdin.buffer)["data"]
        if m.get("type") == "model" and m.get("kind") == "chat"
    ]

    config = {
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            upstream: {
                "name": upstream,
                "npm": "@ai-sdk/openai-compatible",
                "options": {"baseURL": api_url, "setCacheKey": True},
                "models": {m["id"]: model_config(m) for m in models},
            }
        },
    }
    print(json.dumps(config, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
