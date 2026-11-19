import {
  ArrowUndo16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Dismiss16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import type { KeyCandidate } from '../../i18n/copy-editor/dom-registry';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Badge, Button, Field, Text } = fluentComponents;

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

const computeFlyoutPosition = (anchorRect: DOMRect | null): { left: number; top: number } => {
  const width = Math.min(460, window.innerWidth - 24);
  const estimatedHeight = 460;
  if (!anchorRect) {
    return {
      left: Math.max(12, Math.round((window.innerWidth - width) / 2)),
      top: Math.max(12, Math.round((window.innerHeight - estimatedHeight) / 2)),
    };
  }
  const margin = 12;
  const gap = 8;

  let left = anchorRect.left;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  left = Math.max(margin, left);

  let top = anchorRect.bottom + gap;
  if (top + estimatedHeight > window.innerHeight - margin) {
    const above = anchorRect.top - estimatedHeight - gap;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - estimatedHeight - margin);
  }

  return { left: Math.round(left), top: Math.round(top) };
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
  const firstInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Focus the first textarea asynchronously so opening from Alt+Click does
    // not fight the browser's native click focus sequence.
    const timer = window.setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
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
  const position = useMemo(() => computeFlyoutPosition(anchorRect), [anchorRect]);

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

  return (
    <div
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
      <div className="floway-copy-editor-header">
        <div className="flex items-center gap-2 min-w-0">
          <Text weight="semibold">{t('common.copyEditor.flyoutTitle')}</Text>
          <Badge appearance="tint" color="informative" size="small">{route}</Badge>
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
          <div className="grid gap-1.5">
            <Text size={200} style={{ color: 'var(--winui-text-fill-secondary)' }}>
              {t('common.copyEditor.matchedKeys')}
            </Text>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map(candidate => (
                <button
                  key={candidate.key}
                  className="floway-copy-editor-candidate winui-focus-rect"
                  data-active={candidate.key === activeKey ? 'true' : 'false'}
                  type="button"
                  onClick={() => switchKey(candidate.key)}
                >
                  <span className="truncate max-w-[360px]">{candidate.key}</span>
                  {candidate.attribute && <Badge appearance="outline" size="extra-small">{candidate.attribute}</Badge>}
                </button>
              ))}
            </div>
          </div>
        )}

        {relatedKeys.length > 1 && (
          <div className="grid gap-1.5">
            <Text size={200} style={{ color: 'var(--winui-text-fill-secondary)' }}>
              {t('common.copyEditor.pluralVariants')}
            </Text>
            <div className="flex flex-wrap gap-1.5">
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
          </div>
        )}

        <div className="flex items-center gap-1.5 min-w-0">
          <div className="floway-copy-editor-key-chip min-w-0 flex-1">
            <span className="truncate">{activeKey}</span>
          </div>
          <Button
            appearance="subtle"
            aria-label={copiedKey ? t('common.copyEditor.keyCopied') : t('common.copyEditor.copyKey')}
            icon={copiedKey ? <Checkmark16Regular /> : <Copy16Regular />}
            size="small"
            onClick={() => void handleCopyKey()}
          />
        </div>

        {supportedLanguages.map((language, index) => {
          const original = getOriginal(language, activeKey) ?? '';
          const modified = values[language] !== original;
          const stale = staleLanguages.has(language);
          return (
            <div key={language} className="grid gap-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Text size={200} weight="semibold">{LANGUAGE_LABELS[language]}</Text>
                  <Badge appearance="outline" size="extra-small">{language}</Badge>
                </div>
                {modified && (
                  <Button
                    appearance="subtle"
                    icon={<ArrowUndo16Regular />}
                    size="small"
                    onClick={() => handleResetLanguage(language)}
                  >
                    {t('common.copyEditor.resetLanguage')}
                  </Button>
                )}
              </div>

              <Textarea
                ref={index === 0 ? firstInputRef : undefined}
                rows={Math.min(5, Math.max(2, values[language].split('\n').length))}
                value={values[language]}
                onChange={(_, data) => setValues(prev => ({ ...prev, [language]: data.value }))}
              />

              {modified && (
                <Text size={200} style={{ color: 'var(--winui-text-fill-secondary)' }}>
                  {t('common.copyEditor.originalLabel')}: {original}
                </Text>
              )}

              {stale && (
                <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--winui-system-fill-caution)' }}>
                  <Warning16Regular />
                  <span>{t('common.copyEditor.staleNotice')}</span>
                </div>
              )}
            </div>
          );
        })}

        <Field label={t('common.copyEditor.noteLabel')}>
          <Textarea
            placeholder={t('common.copyEditor.notePlaceholder')}
            rows={2}
            value={note}
            onChange={(_, data) => setNote(data.value)}
          />
        </Field>
      </div>

      <div className="floway-copy-editor-footer">
        <div>
          {existingEntry && (
            <Button
              appearance="subtle"
              icon={<ArrowUndo16Regular />}
              size="small"
              onClick={handleRevertEntry}
            >
              {t('common.copyEditor.revert')}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button appearance="secondary" size="small" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            appearance="primary"
            disabled={!hasAnyDiffOrNote && !existingEntry}
            size="small"
            onClick={handleStage}
          >
            {t('common.copyEditor.stage')}
          </Button>
        </div>
      </div>
    </div>
  );
}
