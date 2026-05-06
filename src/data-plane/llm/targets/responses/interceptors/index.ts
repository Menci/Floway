import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../../lib/responses-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitInput } from "../../emit-types.ts";
import { withSmallMaxOutputTokensRaised } from "./raise-small-max-output-tokens.ts";
import { withConnectionMismatchRetried } from "./retry-connection-mismatch.ts";
import { withCyberPolicyRetried } from "./retry-cyber-policy.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";
import { withOutputItemIdsSynchronized } from "./synchronize-output-item-ids.ts";
import { withResponsesWebSearchShim } from "./web-search-shim.ts";

export const responsesTargetInterceptors = [
  withResponsesWebSearchShim,
  withServiceTierStripped,
  withSmallMaxOutputTokensRaised,
  withConnectionMismatchRetried,
  withOutputItemIdsSynchronized,
  withCyberPolicyRetried,
] satisfies readonly TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
>[];
