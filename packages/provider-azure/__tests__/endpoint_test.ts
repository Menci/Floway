import { expect, test } from 'vitest';

import { azureAnthropicBaseUrl, azureDeploymentScopedOpenAIAudioTranscriptionUrl, azureEndpointField, azureOpenAiV1BaseUrl } from '../src/endpoint.ts';

test.each([
  ['https://example.openai.azure.com/', 'example.openai.azure.com'],
  ['https://example.openai.azure.com/openai/v1/', 'example.openai.azure.com'],
  ['https://example.services.ai.azure.com/', 'example.services.ai.azure.com'],
  ['https://example.services.ai.azure.com/api/projects/prod/', 'example.services.ai.azure.com'],
])('audio transcription derives the deployment-scoped URL from %s', (endpoint, host) => {
  const validated = azureEndpointField(endpoint, 'azure upstream config: endpoint');
  expect(azureDeploymentScopedOpenAIAudioTranscriptionUrl(validated, 'transcribe deployment')).toBe(
    `https://${host}/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview`,
  );
});

test('Foundry project endpoints preserve the OpenAI project path and use a resource-wide Anthropic base', () => {
  const endpoint = azureEndpointField('https://example.services.ai.azure.com/api/projects/prod/openai/v1', 'azure upstream config: endpoint');
  expect(azureOpenAiV1BaseUrl(endpoint)).toBe('https://example.services.ai.azure.com/api/projects/prod/openai/v1');
  expect(azureAnthropicBaseUrl(endpoint)).toBe('https://example.services.ai.azure.com/anthropic');
  expect(azureAnthropicBaseUrl('https://example.openai.azure.com/')).toBe('https://example.services.ai.azure.com/anthropic');
});
