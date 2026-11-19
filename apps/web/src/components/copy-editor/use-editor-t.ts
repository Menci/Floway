import { useMemo } from 'react';

import { withoutCopyEditorMarkers } from '../../i18n/copy-editor/markers';
import { useTranslation, type TFunction } from '../../i18n/translation';

// Wraps `useTranslation` so copy-editor UI chrome never embeds zero-width
// tracking markers into its own DOM nodes.
export const useEditorTranslation = () => {
  const { t, i18n } = useTranslation();
  const editorT = useMemo<TFunction>(
    () => ((...args: Parameters<TFunction>) =>
      withoutCopyEditorMarkers(() => (t as (...a: unknown[]) => string)(...args))) as TFunction,
    [t],
  );
  return { t: editorT, i18n };
};
