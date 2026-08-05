import jsesc from 'jsesc';

const escapeC0Controls = (literal: string): string => literal.replace(/[\u0000-\u001f]/g, character =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

export const typescriptString = (value: string): string => escapeC0Controls(jsesc(value, {
  minimal: true,
  quotes: 'single',
  wrap: true,
}));
