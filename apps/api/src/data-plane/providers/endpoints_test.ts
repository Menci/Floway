import { test } from 'vitest';

import { kindForEndpoints, modelEndpointToPublicPath, modelEndpointsToPublicPaths, publicPathToModelEndpoint } from './endpoints.ts';
import { assertEquals } from '../../test-assert.ts';

test('publicPathToModelEndpoint maps both prefix variants for image endpoints', () => {
  assertEquals(publicPathToModelEndpoint('/images/generations'), 'images_generations');
  assertEquals(publicPathToModelEndpoint('/v1/images/generations'), 'images_generations');
  assertEquals(publicPathToModelEndpoint('/images/edits'), 'images_edits');
  assertEquals(publicPathToModelEndpoint('/v1/images/edits'), 'images_edits');
});

test('modelEndpointToPublicPath returns the canonical path for image endpoints', () => {
  assertEquals(modelEndpointToPublicPath('images_generations'), '/images/generations');
  assertEquals(modelEndpointToPublicPath('images_edits'), '/images/edits');
});

test('modelEndpointsToPublicPaths preserves order and dedupes for image endpoints', () => {
  assertEquals(modelEndpointsToPublicPaths(['images_generations', 'images_edits']), ['/images/generations', '/images/edits']);
  assertEquals(modelEndpointsToPublicPaths(['images_generations', 'images_generations', 'images_edits']), ['/images/generations', '/images/edits']);
});

test('kindForEndpoints returns image when either images endpoint is present', () => {
  assertEquals(kindForEndpoints(['images_generations']), 'image');
  assertEquals(kindForEndpoints(['images_edits']), 'image');
  assertEquals(kindForEndpoints(['images_generations', 'images_edits']), 'image');
});

test('kindForEndpoints still returns embedding for embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints(['embeddings']), 'embedding');
  assertEquals(kindForEndpoints(['chat_completions']), 'chat');
  assertEquals(kindForEndpoints(['messages']), 'chat');
});
