import {
  ArrowUndo16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Dismiss16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import type { KeyCandidate } from '../../i18n/copy-editor/dom-registry';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Label, Text } = fluentComponents;

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

const clampPosition = (left: number, top: number, width: number, height: number): { left: number; top: number } => {
  const margin = 12;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.round(Math.max(margin, Math.min(left, maxLeft))),
    top: Math.round(Math.max(margin, Math.min(top, maxTop))),
  };
};

const computeInitialPosition = (anchorRect: DOMRect | null, width: number, height: number): { left: number; top: number } => {
  if (!anchorRect) {
    return clampPosition((window.innerWidth - width) / 2, (window.innerHeight - height) / 2, width, height);
  }
  const margin = 12;
  const gap = 8;
  const preferredBelow = anchorRect.bottom + gap;
  const top = preferredBelow + height <= window.innerHeight - margin
    ? preferredBelow
    : anchorRect.top - height - gap >= margin
      ? anchorRect.top - height - gap
      : window.innerHeight - height - margin;
  return clampPosition(anchorRect.left, top, width, height);
};

export interface EditorFlyoutProps {
  initialKey: string;
  candidates: KeyCandidate[];
  anchorRect: DOMRect | null;
  route: string;
  onClose: () => void;
}

export function EditorFlyout({ anchorRect, candidates, initialKey, onClose, route }: EditorFlyoutProps) {
  const { t } = useEditorTranslation();
  const idPrefix = useId();
  const entries = useCopyEditorStore(state => state.entries);
  const getOriginal = useCopyEditorStore(state => state.getOriginal);
  const getCurrent = useCopyEditorStore(state => state.getCurrent);
  const getRelatedKeys = useCopyEditorStore(state => state.getRelatedKeys);
  const getStaleLanguages = useCopyEditorStore(state => state.getStaleLanguages);
  const stageEntry = useCopyEditorStore(state => state.stageEntry);
  const revertEntry = useCopyEditorStore(state => state.revertEntry);
  const revertLanguage = useCopyEditorStore(state => state.revertLanguage);

  const [activeKey, setActiveKey] = useState(initialKey);
  const [copiedKey, setCopiedKey] = useState(false);

  const buildInitialValues = (key: string): Record<SupportedLanguage, string> => ({
    'en': getCurrent('en', key) ?? '',
    'zh-Hans': getCurrent('zh-Hans', key) ?? '',
  });

  const [values, setValues] = useState<Record<SupportedLanguage, string>>(() => buildInitialValues(initialKey));
  const [note, setNote] = useState(() => entries[initialKey]?.note ?? '');

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);

  const [position, setPosition] = useState(() =>
    computeInitialPosition(anchorRect, Math.min(460, window.innerWidth - 24), 440));

  // Re-clamp once the real rendered height is known so tall multi-candidate
  // flyouts never clip below the viewport edge.
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(computeInitialPosition(anchorRect, rect.width || 460, rect.height || 440));
  }, [anchorRect]);

  useEffect(() => {
    const timer = window.setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragOffsetRef.current;
      const el = surfaceRef.current;
      if (!drag || !el) return;
      const rect = el.getBoundingClientRect();
      setPosition(clampPosition(event.clientX - drag.dx, event.clientY - drag.dy, rect.width, rect.height));
    };
    const onPointerUp = () => {
      dragOffsetRef.current = null;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const switchKey = (nextKey: string) => {
    setActiveKey(nextKey);
    setValues(buildInitialValues(nextKey));
    setNote(useCopyEditorStore.getState().entries[nextKey]?.note ?? '');
    setCopiedKey(false);
  };

  const relatedKeys = useMemo(() => getRelatedKeys(activeKey), [activeKey, getRelatedKeys]);
  const staleLanguages = new Set(getStaleLanguages(activeKey));
  const existingEntry = entries[activeKey];

  const hasAnyDiffOrNote = supportedLanguages.some(lang => {
    const original = getOriginal(lang, activeKey) ?? '';
    return values[lang] !== original;
  }) || note.trim().length > 0;

  const handleStage = () => {
    stageEntry({
      key: activeKey,
      route,
      values,
      note,
    });
    onClose();
  };

  const handleCopyKey = async () => {
    const ok = await copyToClipboard(activeKey);
    if (ok) {
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 1500);
    }
  };

  const handleResetLanguage = (language: SupportedLanguage) => {
    const original = getOriginal(language, activeKey) ?? '';
    setValues(prev => ({ ...prev, [language]: original }));
    if (existingEntry?.changes[language]) {
      revertLanguage(activeKey, language);
    }
  };

  const handleRevertEntry = () => {
    revertEntry(activeKey);
    setValues({
      'en': getOriginal('en', activeKey) ?? '',
      'zh-Hans': getOriginal('zh-Hans', activeKey) ?? '',
    });
    setNote('');
  };

  const noteInputId = `${idPrefix}-note`;

  return (
    <div
      ref={surfaceRef}
      aria-label={t('common.copyEditor.flyoutTitle')}
      className="floway-copy-editor-surface floway-copy-editor-flyout"
      role="dialog"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          handleStage();
        }
      }}
    >
      <div
        className="floway-copy-editor-header"
        data-draggable="true"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest('button')) return;
          dragOffsetRef.current = {
            dx: event.clientX - position.left,
            dy: event.clientY - position.top,
          };
        }}
      >
        <div className="floway-copy-editor-header-main">
          <Text className="floway-copy-editor-header-title" size={400} weight="semibold">
            {t('common.copyEditor.flyoutTitle')}
          </Text>
          <span className="floway-copy-editor-header-key-group">
            <span className="floway-copy-editor-header-key" title={activeKey}>
              {activeKey}
            </span>
            <Button
              appearance="subtle"
              aria-label={copiedKey ? t('common.copyEditor.keyCopied') : t('common.copyEditor.copyKey')}
              icon={copiedKey ? <Checkmark16Regular /> : <Copy16Regular />}
              size="small"
              title={copiedKey ? t('common.copyEditor.keyCopied') : t('common.copyEditor.copyKey')}
              onClick={() => void handleCopyKey()}
            />
          </span>
        </div>
        <Button
          appearance="subtle"
          aria-label={t('common.copyEditor.close')}
          icon={<Dismiss16Regular />}
          size="small"
          onClick={onClose}
        />
      </div>

      <div className="floway-copy-editor-body">
        {candidates.length > 1 && (
          <div className="floway-copy-editor-candidates">
            {candidates.map(candidate => (
              <button
                key={candidate.key}
                className="floway-copy-editor-candidate winui-focus-rect"
                data-active={candidate.key === activeKey ? 'true' : 'false'}
                type="button"
                onClick={() => switchKey(candidate.key)}
              >
                <span className="truncate max-w-[340px]">{candidate.key}</span>
                {candidate.attribute && (
                  <span className="floway-copy-editor-candidate-attr">{candidate.attribute}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {relatedKeys.length > 1 && (
          <div className="floway-copy-editor-candidates">
            {relatedKeys.map(key => (
              <button
                key={key}
                className="floway-copy-editor-candidate winui-focus-rect"
                data-active={key === activeKey ? 'true' : 'false'}
                type="button"
                onClick={() => switchKey(key)}
              >
                {key}
              </button>
            ))}
          </div>
        )}

        {supportedLanguages.map((language, index) => {
          const original = getOriginal(language, activeKey) ?? '';
          const modified = values[language] !== original;
          const stale = staleLanguages.has(language);
          const inputId = `${idPrefix}-${language}`;
          return (
            <div key={language} className="floway-copy-editor-field">
              <div className="floway-copy-editor-field-header">
                <Label htmlFor={inputId}>{LANGUAGE_LABELS[language]}</Label>
                {modified && (
                  <Button
                    appearance="subtle"
                    aria-label={t('common.copyEditor.resetLanguage')}
                    icon={<ArrowUndo16Regular />}
                    size="small"
                    title={t('common.copyEditor.resetLanguage')}
                    onClick={() => handleResetLanguage(language)}
                  />
                )}
              </div>

              <Textarea
                ref={index === 0 ? firstInputRef : undefined}
                className="w-full"
                id={inputId}
                rows={Math.min(5, Math.max(2, values[language].split('\n').length))}
                value={values[language]}
                onChange={(_, data) => setValues(prev => ({ ...prev, [language]: data.value }))}
              />

              {modified && (
                <span className="floway-copy-editor-meta">
                  {t('common.copyEditor.originalLabel')}: {original}
                </span>
              )}

              {stale && (
                <span className="floway-copy-editor-caution">
                  <Warning16Regular />
                  <span>{t('common.copyEditor.staleNotice')}</span>
                </span>
              )}
            </div>
          );
        })}

        <div className="floway-copy-editor-field">
          <div className="floway-copy-editor-field-header">
            <Label htmlFor={noteInputId}>{t('common.copyEditor.noteLabel')}</Label>
          </div>
          <Textarea
            className="w-full"
            id={noteInputId}
            rows={2}
            value={note}
            onChange={(_, data) => setNote(data.value)}
          />
        </div>
      </div>

      <div className="floway-copy-editor-footer">
        <div className="floway-copy-editor-footer-start">
          {existingEntry && (
            <Button
              appearance="subtle"
              icon={<ArrowUndo16Regular />}
              onClick={handleRevertEntry}
            >
              {t('common.copyEditor.revert')}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button appearance="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            appearance="primary"
            disabled={!hasAnyDiffOrNote && !existingEntry}
            onClick={handleStage}
          >
            {t('common.copyEditor.stage')}
          </Button>
        </div>
      </div>
    </div>
  );
}
