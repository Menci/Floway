// Official SDK wire declarations.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/beta/responses/responses.ts

import type * as ResponsesAPI from './sdk-beta.ts';

export namespace BetaResponseInputItem {
  export interface AgentMessage {
    author: string;
    content: Array<
      | ResponsesAPI.BetaResponseInputTextContent
      | ResponsesAPI.BetaResponseInputImageContent
      | AgentMessage.EncryptedContent
    >;
    recipient: string;
    type: 'agent_message';
    id?: string | null;
    agent?: AgentMessage.Agent | null;
  }
  export namespace AgentMessage {
    export interface EncryptedContent {
      encrypted_content: string;
      type: 'encrypted_content';
    }
    export interface Agent {
      agent_name: string;
    }
  }
  export interface MultiAgentCall {
    action:
      | 'spawn_agent'
      | 'interrupt_agent'
      | 'list_agents'
      | 'send_message'
      | 'followup_task'
      | 'wait_agent';
    arguments: string;
    call_id: string;
    type: 'multi_agent_call';
    id?: string | null;
    agent?: MultiAgentCall.Agent | null;
  }
  export namespace MultiAgentCall {
    export interface Agent {
      agent_name: string;
    }
  }
  export interface MultiAgentCallOutput {
    action:
      | 'spawn_agent'
      | 'interrupt_agent'
      | 'list_agents'
      | 'send_message'
      | 'followup_task'
      | 'wait_agent';
    call_id: string;
    output: Array<MultiAgentCallOutput.Output>;
    type: 'multi_agent_call_output';
    id?: string | null;
    agent?: MultiAgentCallOutput.Agent | null;
  }
  export namespace MultiAgentCallOutput {
    export interface Output {
      text: string;
      type: 'output_text';
      annotations?: Array<Output.FileCitation | Output.URLCitation | Output.ContainerFileCitation>;
    }
    export namespace Output {
      export interface FileCitation {
        file_id: string;
        filename: string;
        index: number;
        type: 'file_citation';
      }
      export interface URLCitation {
        end_index: number;
        start_index: number;
        title: string;
        type: 'url_citation';
        url: string;
      }
      export interface ContainerFileCitation {
        container_id: string;
        end_index: number;
        file_id: string;
        filename: string;
        start_index: number;
        type: 'container_file_citation';
      }
    }
    export interface Agent {
      agent_name: string;
    }
  }
}

export namespace BetaResponseOutputItem {
  export interface AgentMessage {
    id: string;
    author: string;
    content: Array<
      | ResponsesAPI.BetaResponseInputText
      | ResponsesAPI.BetaResponseOutputText
      | AgentMessage.Text
      | AgentMessage.SummaryText
      | AgentMessage.ReasoningText
      | ResponsesAPI.BetaResponseOutputRefusal
      | ResponsesAPI.BetaResponseInputImage
      | AgentMessage.ComputerScreenshot
      | ResponsesAPI.BetaResponseInputFile
      | AgentMessage.EncryptedContent
    >;
    recipient: string;
    type: 'agent_message';
    agent?: AgentMessage.Agent;
  }
  export namespace AgentMessage {
    export interface Text {
      text: string;
      type: 'text';
    }
    export interface SummaryText {
      text: string;
      type: 'summary_text';
    }
    export interface ReasoningText {
      text: string;
      type: 'reasoning_text';
    }
    export interface ComputerScreenshot {
      detail: ResponsesAPI.BetaImageDetail;
      file_id: string | null;
      image_url: string | null;
      type: 'computer_screenshot';
      prompt_cache_breakpoint?: ComputerScreenshot.PromptCacheBreakpoint;
    }
    export namespace ComputerScreenshot {
      export interface PromptCacheBreakpoint {
        mode: 'explicit';
      }
    }
    export interface EncryptedContent {
      encrypted_content: string;
      type: 'encrypted_content';
    }
    export interface Agent {
      agent_name: string;
    }
  }
  export interface MultiAgentCall {
    id: string;
    action:
      | 'spawn_agent'
      | 'interrupt_agent'
      | 'list_agents'
      | 'send_message'
      | 'followup_task'
      | 'wait_agent';
    arguments: string;
    call_id: string;
    type: 'multi_agent_call';
    agent?: MultiAgentCall.Agent;
  }
  export namespace MultiAgentCall {
    export interface Agent {
      agent_name: string;
    }
  }
  export interface MultiAgentCallOutput {
    id: string;
    action:
      | 'spawn_agent'
      | 'interrupt_agent'
      | 'list_agents'
      | 'send_message'
      | 'followup_task'
      | 'wait_agent';
    call_id: string;
    output: Array<ResponsesAPI.BetaResponseOutputText>;
    type: 'multi_agent_call_output';
    agent?: MultiAgentCallOutput.Agent;
  }
  export namespace MultiAgentCallOutput {
    export interface Agent {
      agent_name: string;
    }
  }
}

export interface BetaResponseInputTextContent {
  text: string;
  type: 'input_text';
  prompt_cache_breakpoint?: BetaResponseInputTextContent.PromptCacheBreakpoint | null;
}

export namespace BetaResponseInputTextContent {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface BetaResponseInputImageContent {
  type: 'input_image';
  detail?: BetaImageDetail | null;
  file_id?: string | null;
  image_url?: string | null;
  prompt_cache_breakpoint?: BetaResponseInputImageContent.PromptCacheBreakpoint | null;
}

export namespace BetaResponseInputImageContent {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface BetaResponseInputText {
  text: string;
  type: 'input_text';
  prompt_cache_breakpoint?: BetaResponseInputText.PromptCacheBreakpoint;
}

export namespace BetaResponseInputText {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface BetaResponseInputImage {
  detail: BetaImageDetail;
  type: 'input_image';
  file_id?: string | null;
  image_url?: string | null;
  prompt_cache_breakpoint?: BetaResponseInputImage.PromptCacheBreakpoint;
}

export namespace BetaResponseInputImage {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface BetaResponseInputFile {
  type: 'input_file';
  detail?: 'auto' | 'low' | 'high';
  file_data?: string;
  file_id?: string | null;
  file_url?: string;
  filename?: string;
  prompt_cache_breakpoint?: BetaResponseInputFile.PromptCacheBreakpoint;
}

export namespace BetaResponseInputFile {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface BetaResponseOutputText {
  annotations: Array<
    | BetaResponseOutputText.FileCitation
    | BetaResponseOutputText.URLCitation
    | BetaResponseOutputText.ContainerFileCitation
    | BetaResponseOutputText.FilePath
  >;
  text: string;
  type: 'output_text';
  logprobs?: Array<BetaResponseOutputText.Logprob>;
}

export namespace BetaResponseOutputText {
  export interface FileCitation {
    file_id: string;
    filename: string;
    index: number;
    type: 'file_citation';
  }
  export interface URLCitation {
    end_index: number;
    start_index: number;
    title: string;
    type: 'url_citation';
    url: string;
  }
  export interface ContainerFileCitation {
    container_id: string;
    end_index: number;
    file_id: string;
    filename: string;
    start_index: number;
    type: 'container_file_citation';
  }
  export interface FilePath {
    file_id: string;
    index: number;
    type: 'file_path';
  }
  export interface Logprob {
    token: string;
    bytes: Array<number>;
    logprob: number;
    top_logprobs: Array<Logprob.TopLogprob>;
  }
  export namespace Logprob {
    export interface TopLogprob {
      token: string;
      bytes: Array<number>;
      logprob: number;
    }
  }
}

export interface BetaResponseOutputRefusal {
  refusal: string;
  type: 'refusal';
}

export type BetaImageDetail = 'low' | 'high' | 'auto' | 'original';
