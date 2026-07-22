import { test } from 'vitest';

import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import { assertEquals } from '@floway-dev/test-utils';

const EMBEDDINGS = { embeddings: {} };
const IMAGES = { imagesGenerations: {}, imagesEdits: {} };
const AUDIO = { audioTranscriptions: {} };

test('inferEndpointsFromModelId returns embeddings for known OpenAI / Voyage / Cohere / Mistral families', () => {
  for (const id of [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'text-embedding-ada-002',
    'voyage-3',
    'voyage-multilingual-2',
    'voyage-code-3',
    'embed-english-v3.0',
    'embed-multilingual-light-v3.0',
    'mistral-embed',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), EMBEDDINGS);
  }
});

test('inferEndpointsFromModelId returns embeddings for common local / open-weight embedding families', () => {
  for (const id of [
    'bge-large-en-v1.5',
    'BAAI/bge-large-en',
    'gte-large-en-v1.5',
    'e5-large-v2',
    'intfloat/multilingual-e5-large',
    'nomic-embed-text-v1',
    'mxbai-embed-large-v1',
    'WhereIsAI/UAE-Large-V1',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), EMBEDDINGS);
  }
});

test('inferEndpointsFromModelId returns null (chat fallback) for typical chat model ids', () => {
  for (const id of [
    'gpt-4o',
    'gpt-5.4-pro',
    'o1-preview',
    'claude-opus-4-7',
    'claude-haiku-4-5',
    'deepseek-v3',
    'llama-3.1-70b-instruct',
    'gemini-2.0-flash',
    'mistral-large-latest',
    'command-r-plus',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), null);
  }
});

test('inferEndpointsFromModelId returns both image endpoints for the gpt-image-* family', () => {
  for (const id of [
    'gpt-image-1',
    'gpt-image-1-mini',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-2-2026-04-21',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), IMAGES);
  }
});

test('inferEndpointsFromModelId returns null for non-OpenAI image families and gpt-4o-image variants', () => {
  for (const id of [
    'dall-e-3',
    'dall-e-2',
    'flux-pro',
    'flux.1-schnell',
    'stable-diffusion-3.5',
    'sdxl-turbo',
    'imagen-4.0-generate-001',
    'gpt-4o-image-experimental',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), null);
  }
});

test('inferEndpointsFromModelId returns audio transcription for standard transcribe and whisper families', () => {
  for (const id of [
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe-2025-12-15',
    'gpt-4o-transcribe-diarize',
    'whisper-1',
    'openai/whisper-large-v3',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), AUDIO);
  }
});
