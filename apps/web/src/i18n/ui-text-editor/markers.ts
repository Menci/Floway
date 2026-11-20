import { createI18nextKeyMarkerPostProcessor } from './adapters/i18next';
import { defaultKeyMarkerChannel, mayContainKeyMarkers, type TextKeySegment } from './core/markers';

export { mayContainKeyMarkers, type TextKeySegment };
export const wrapWithKeyMarkers = defaultKeyMarkerChannel.wrap;
export const extractKeySegments = defaultKeyMarkerChannel.extract;
export const stripKeyMarkers = defaultKeyMarkerChannel.strip;
export const setUiTextEditorTrackingActive = defaultKeyMarkerChannel.setTrackingActive;
export const withoutUiTextEditorMarkers = defaultKeyMarkerChannel.withoutMarkers;

export const UI_TEXT_EDITOR_POST_PROCESSOR_NAME = 'flowayUiTextEditor';

export const uiTextEditorPostProcessor = createI18nextKeyMarkerPostProcessor({
  name: UI_TEXT_EDITOR_POST_PROCESSOR_NAME,
  channel: defaultKeyMarkerChannel,
});
