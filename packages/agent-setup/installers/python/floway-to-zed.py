#!/usr/bin/env python3

# Convert a Floway /v1/models payload (stdin) into Zed language-model settings.
#
# Usage:
#   curl --oauth2-bearer '<TOKEN>' http://localhost:18088/v1/models | ./floway-to-zed.py [NAME] [API_URL]
#   defaults: NAME=Floway, API_URL=http://localhost:18088/v1
#
# Install to ~/.config/zed/global_settings.json
# Then, go to Zed Settings → User → AI → General → LLM Providers to configure your API key.
#
# Reference:
#   https://zed.dev/docs/ai/use-api-access#openai-compatible
#   zed://schemas/settings

import json
import sys

DEFAULT_UPSTREAM_NAME = "Floway"
DEFAULT_API_URL = "http://localhost:18088/v1"
DEFAULT_CONTEXT_WINDOW = 262144


def model_config(model):
    chat = model.get("chat", {})
    limits = model.get("limits", {})

    config = {
        "name": model["id"],
        "display_name": model.get("display_name", model["id"]),
        "max_tokens": limits.get("max_context_window_tokens", DEFAULT_CONTEXT_WINDOW),
        "capabilities": {
            "tools": True,
            "images": "image" in chat.get("modalities", {}).get("input", []),
            "parallel_tool_calls": True,
            "prompt_cache_key": True,
            "chat_completions": False,
            "interleaved_reasoning": True,
        },
    }
    return config


def main():
    upstream = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UPSTREAM_NAME
    api_url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_URL
    models = (
        m
        for m in json.load(sys.stdin.buffer)["data"]
        if m.get("type") == "model" and m.get("kind") == "chat"
    )

    settings = {
        "language_models": {
            "openai_compatible": {
                upstream: {
                    "api_url": api_url,
                    "available_models": [model_config(m) for m in models],
                }
            }
        }
    }
    print(json.dumps(settings, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
