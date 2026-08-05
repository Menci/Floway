import jsesc from 'jsesc';

export const typescriptString = (value: string): string => jsesc(value, {
  minimal: true,
  quotes: 'single',
  wrap: true,
});
