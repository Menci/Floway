#!/usr/bin/env python3

# Convert a Floway /v1/models payload (stdin) into VSCode chat language model
# settings.
#
# Usage:
#   curl --oauth2-bearer '<TOKEN>' http://localhost:18088/v1/models | ./floway-to-vscode.py [NAME] [API_URL]
#   defaults: NAME=Floway, API_URL=http://localhost:18088/v1
#
# Installation:
# 1. Ctrl-Shift-P (Cmd-Shift-P): "Chat: Open Language Models (JSON)", paste in the generated JSON
# 2. Ctrl-Shift-P (Cmd-Shift-P): "Developer: Reload Window"
# 3. Ctrl-Shift-P (Cmd-Shift-P): "Chat: Manage Language Models"
# 4. Right click a model, and choose "Update API Key"
#
# Reference:
#   https://code.visualstudio.com/docs/agent-customization/language-models#_model-configuration-reference

import json
import sys

DEFAULT_UPSTREAM_NAME = "Floway"
DEFAULT_API_URL = "http://localhost:18088/v1"
DEFAULT_CONTEXT_WINDOW = 262144
DEFAULT_MAX_OUTPUT = 65536
# Sent as a literal placeholder; the installer replaces it with the real API
# key before writing chatLanguageModels.json. VSCode accepts a literal apiKey
# and sends it as the bearer token.
SECRET_ID_PLACEHOLDER = "${input:chat.lm.secret.REPLACE_WITH_FLOWAY_API_KEY}"


def model_config(model, api_url):
    chat = model.get("chat", {})
    limits = model.get("limits", {})

    max_context_window_tokens = limits.get("max_context_window_tokens")
    max_input_tokens = limits.get("max_prompt_tokens")
    max_output_tokens = limits.get("max_output_tokens")
    match (
        max_context_window_tokens is not None,
        max_input_tokens is not None,
        max_output_tokens is not None,
    ):
        case False, False, False:
            max_input_tokens = DEFAULT_CONTEXT_WINDOW - DEFAULT_MAX_OUTPUT
            max_output_tokens = DEFAULT_MAX_OUTPUT
        case False, False, True:
            max_input_tokens = max(
                DEFAULT_CONTEXT_WINDOW - max_output_tokens, max_output_tokens
            )
        case False, True, False:
            max_output_tokens = max(max_input_tokens, DEFAULT_MAX_OUTPUT)
        case _, True, True:
            pass
        case True, False, False:
            max_output_tokens = min(max_context_window_tokens // 2, DEFAULT_MAX_OUTPUT)
            max_input_tokens = max_context_window_tokens - max_output_tokens
        case True, False, True:
            max_input_tokens = max_context_window_tokens - max_output_tokens
        case True, True, False:
            max_output_tokens = max_context_window_tokens - max_input_tokens

    config = {
        "id": model["id"],
        "name": model.get("display_name", model["id"]),
        "url": api_url.rstrip("/") + "/responses",
        "toolCalling": True,
        "vision": "image" in chat.get("modalities", {}).get("input", []),
        "thinking": True,  # Force True until we fix Floway's metadata discovery
        "maxInputTokens": max_input_tokens,
        "maxOutputTokens": max_output_tokens,
        "zeroDataRetentionEnabled": True,
    }
    if "reasoning" in chat:
        config["reasoningEffortFormat"] = "responses"
        if (effort := chat["reasoning"].get("effort")).get("supported"):
            config["supportsReasoningEffort"] = list(effort["supported"])
    return config


def main():
    upstream = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UPSTREAM_NAME
    api_url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_URL
    models = (
        m
        for m in json.load(sys.stdin.buffer)["data"]
        if m.get("type") == "model" and m.get("kind") == "chat"
    )
    settings = [
        {
            "name": upstream,
            "vendor": "customendpoint",
            "apiKey": SECRET_ID_PLACEHOLDER,
            "apiType": "responses",
            "models": [model_config(m, api_url) for m in models],
        }
    ]
    print(json.dumps(settings, ensure_ascii=False, indent=4))


if __name__ == "__main__":
    main()
