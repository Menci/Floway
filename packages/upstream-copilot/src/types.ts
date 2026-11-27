// Copilot's `/models` wire shape. Lives here (not in the provider-neutral
// layer) because no other provider consumes these fields — `capabilities.type`
// is read by the endpoint-routing logic; `supports.*` fields are consumed by
// both the raw variant selector (reasoning_effort) and the chat capability
// mapper (vision, min/max_thinking_budget, adaptive_thinking).

export interface CopilotRawModel {
  id: string;
  name?: string;
  version?: string;
  owned_by?: string;
  created?: number;
  display_name?: string;
  supported_endpoints?: string[];
  capabilities?: {
    type?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: {
      vision?: boolean;
      reasoning_effort?: string[];
      min_thinking_budget?: number;
      max_thinking_budget?: number;
      adaptive_thinking?: boolean;
    };
  };
}

export interface CopilotModelsResponse {
  object: string;
  data: CopilotRawModel[];
}
