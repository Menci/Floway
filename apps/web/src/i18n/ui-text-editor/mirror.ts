import { createBootToggleMirror, getAltKeyLabel } from './core/preference';

const mirror = createBootToggleMirror('floway.uiTextEditorEnabled');

export const isUiTextEditorEnabled = mirror.isEnabled;
export const syncUiTextEditorPreference = mirror.sync;
export const __testing = mirror.__testing;
export { getAltKeyLabel };
