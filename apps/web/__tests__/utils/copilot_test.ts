import { expect, test } from 'vitest';

import { copilotAccountTypeDisplay, copilotAccountTypeLabel } from '../../src/utils/copilot.ts';

test('copilotAccountTypeLabel maps the three known per-tier hosts', () => {
  expect(copilotAccountTypeLabel({ copilotToken: { baseUrl: 'https://api.individual.githubcopilot.com' } })).toBe('individual');
  expect(copilotAccountTypeLabel({ copilotToken: { baseUrl: 'https://api.business.githubcopilot.com' } })).toBe('business');
  expect(copilotAccountTypeLabel({ copilotToken: { baseUrl: 'https://api.enterprise.githubcopilot.com' } })).toBe('enterprise');
});

test('copilotAccountTypeLabel returns null when state is missing or unhydrated', () => {
  expect(copilotAccountTypeLabel(null)).toBe(null);
  expect(copilotAccountTypeLabel(undefined)).toBe(null);
  expect(copilotAccountTypeLabel({ copilotToken: null })).toBe(null);
});

test('copilotAccountTypeLabel returns null for a host GitHub may add that we have not labeled yet', () => {
  expect(copilotAccountTypeLabel({ copilotToken: { baseUrl: 'https://api.education.githubcopilot.com' } })).toBe(null);
});

test('copilotAccountTypeDisplay falls back to the generic label for null/unknown cases', () => {
  expect(copilotAccountTypeDisplay(null)).toBe('copilot');
  expect(copilotAccountTypeDisplay({ copilotToken: null })).toBe('copilot');
  expect(copilotAccountTypeDisplay({ copilotToken: { baseUrl: 'https://api.education.githubcopilot.com' } })).toBe('copilot');
  expect(copilotAccountTypeDisplay({ copilotToken: { baseUrl: 'https://api.enterprise.githubcopilot.com' } })).toBe('enterprise');
});
