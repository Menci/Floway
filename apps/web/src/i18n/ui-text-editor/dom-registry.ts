import {
  UiTextEditorDomRegistry as GenericUiTextEditorDomRegistry,
  isInsideEditorRoot,
  type HitTarget,
} from './core/dom-registry';
import { defaultKeyMarkerChannel } from './core/markers';

export const UI_TEXT_EDITOR_ROOT_ATTR = 'data-floway-ui-text-editor-root';

export type { HitTarget };

export const isInsideUiTextEditor = (target: EventTarget | Node | null, host?: HTMLElement | null): boolean =>
  isInsideEditorRoot(target, host, UI_TEXT_EDITOR_ROOT_ATTR);

export class UiTextEditorDomRegistry extends GenericUiTextEditorDomRegistry {
  constructor() {
    super({ rootAttr: UI_TEXT_EDITOR_ROOT_ATTR, channel: defaultKeyMarkerChannel });
  }
}

export const sharedUiTextEditorRegistry = new UiTextEditorDomRegistry();
