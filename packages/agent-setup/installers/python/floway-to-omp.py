#!/usr/bin/env python3

# Convert a Floway /v1/models payload (stdin) into oh-my-pi provider settings.
#
# Usage:
#   curl --oauth2-bearer '<TOKEN>' http://localhost:18088/v1/models | ./floway-to-omp.py [NAME] [API_URL]
#   defaults: NAME=Floway, API_URL=http://localhost:18088/v1
#
# Install to ~/.omp/agent/models.yml
#
# Reference:
#   https://github.com/can1357/oh-my-pi/blob/main/docs/models.md

import decimal
import json
import sys

import yaml

DEFAULT_UPSTREAM_NAME = "Floway"
DEFAULT_API_URL = "http://localhost:18088/v1"


def model_config(model):
    chat = model.get("chat", {})
    limits = model.get("limits", {})
    rates = {}
    for entry in model.get("pricing", {}).get("entries", []):
        if not entry.get("selector"):
            rates = entry.get("rates", {})
            break

    config = {
        "id": model["id"],
        "name": model.get("display_name", model["id"]),
        "reasoning": True,  # Force True until we fix Floway's metadata discovery
    }
    if "input" in (modalities := chat.get("modalities", {})):
        config["input"] = modalities["input"]
    if "max_context_window_tokens" in limits:
        config["contextWindow"] = limits["max_context_window_tokens"]
    if "max_output_tokens" in limits:
        config["maxTokens"] = limits["max_output_tokens"]
    if (
        "input_tokens" in rates
        or "output_tokens" in rates
        or "input_cache_read_tokens" in rates
        or "input_cache_write_tokens" in rates
    ):
        config["cost"] = {
            "input": float(decimal.Decimal(rates.get("input_tokens", 0)).scaleb(6)),
            "output": float(decimal.Decimal(rates.get("output_tokens", 0)).scaleb(6)),
            "cacheRead": float(
                decimal.Decimal(rates.get("input_cache_read_tokens", 0)).scaleb(6)
            ),
            "cacheWrite": float(
                decimal.Decimal(rates.get("input_cache_write_tokens", 0)).scaleb(6)
            ),
        }
    config["compat"] = {
        "supportsStore": True,
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
        "providers": {
            upstream: {
                "baseUrl": api_url,
                "apiKey": upstream.upper() + "_API_KEY",
                "api": "openai-responses",
                "models": [model_config(m) for m in models],
            }
        }
    }
    print(yaml.safe_dump(settings), end='')


if __name__ == "__main__":
    main()
