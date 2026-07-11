export type KeySource = 'generate' | 'custom';

export const KEY_SOURCE_OPTIONS: { value: KeySource; label: string; description: string }[] = [
  { value: 'generate', label: 'Generate', description: 'Mint a fresh sk-...T3BlbkFJ... key on the server.' },
  { value: 'custom', label: 'Custom', description: 'Use a key you provide.' },
];
