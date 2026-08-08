import { withEmptyNamespaceDescriptionsFilled } from './fill-empty-namespace-descriptions.ts';
import type { AzureResponsesBoundaryInterceptor } from './types.ts';

// Azure-specific Responses workarounds stay behind the provider boundary so
// the gateway and OpenAI-compatible providers retain the canonical wire value.
export const AZURE_RESPONSES_BOUNDARY = [
  withEmptyNamespaceDescriptionsFilled,
] as const satisfies readonly AzureResponsesBoundaryInterceptor[];
