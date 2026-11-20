import { useMemo } from 'react';

import { useTranslation, type TFunction } from '../../i18n/translation';
import { withoutUiTextEditorMarkers } from '../../i18n/ui-text-editor/markers';

// Wraps `useTranslation` so UI text editor chrome never embeds zero-width
// tracking markers into its own DOM nodes.
export const useEditorTranslation = () => {
  const { t, i18n } = useTranslation();
  const editorT = useMemo<TFunction>(
    () => ((...args: Parameters<TFunction>) =>
      withoutUiTextEditorMarkers(() => (t as (...a: unknown[]) => string)(...args))) as TFunction,
    [t],
  );
  return { t: editorT, i18n };
};
