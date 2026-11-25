import type { KimiCodeUpstreamConfig } from './config.ts';
import { joinBaseAndPath } from '@floway-dev/provider';

// Coding subscription keys use the regional coding service, independently of
// Moonshot Open Platform keys and billing.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const BASE_URLS = {
  china: 'https://api.kimi.com/coding/v1',
  overseas: 'https://api.kimi.ai/coding/v1',
} as const;

export const kimiCodeEndpoint = (region: KimiCodeUpstreamConfig['region'], path: string): string =>
  joinBaseAndPath(BASE_URLS[region], path);
