import { createFluentFreezeController } from './adapters/fluent-freeze';
import { defaultKeyMarkerChannel } from './core/markers';
import { isUiTextEditorEnabled } from './mirror';
import type { FluentComponents } from '../../winui/wrap';

const freezeController = createFluentFreezeController(defaultKeyMarkerChannel);

export const setUiTextEditorFreezeActive = freezeController.setFreezeActive;
export const UiTextEditorInternalContext = freezeController.InternalContext;

export const withUiTextEditorFreeze = (components: FluentComponents): FluentComponents =>
  freezeController.wrapComponents(components, isUiTextEditorEnabled());
