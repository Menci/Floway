import {
  ArrowUndo16Regular,
  Checkmark16Regular,
  ChevronDown16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';

import { EditorIconButton, useCopyEditorPortal } from './editor-icon-button';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import type { KeyCandidate } from '../../i18n/copy-editor/dom-registry';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Label, Tooltip } = fluentComponents;

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
  escapeHandlerRef?: MutableRefObject<(() => boolean) | null>;
  onClose: () => void;
  onSaved?: () => void;
}

export function EditorFlyout({ anchorRect, candidates, escapeHandlerRef, initialKey, onClose, onSaved }: EditorFlyoutProps) {
  const { i18n, t } = useEditorTranslation();
  const mountNode = useCopyEditorPortal();
  const idPrefix = useId();
  const entries = useCopyEditorStore(state => state.entries);
  const getOriginal = useCopyEditorStore(state => state.getOriginal);
  const getCurrent = useCopyEditorStore(state => state.getCurrent);
  const stageEntry = useCopyEditorStore(state => state.stageEntry);
  const revertEntry = useCopyEditorStore(state => state.revertEntry);
  const revertLanguage = useCopyEditorStore(state => state.revertLanguage);

  const hasMultipleCandidates = candidates.length > 1;
  const [activeKey, setActiveKey] = useState(initialKey);
  const [copiedKey, setCopiedKey] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(hasMultipleCandidates);
  const [highlightedIndex, setHighlightedIndex] = useState(() => {
    const idx = candidates.findIndex(c => c.key === initialKey);
    return idx >= 0 ? idx : 0;
  });

  const buildInitialValues = (key: string): Record<SupportedLanguage, string> => {
    const active = useCopyEditorStore.getState().entries[key];
    return {
      'en': active?.changes.en?.after ?? getCurrent('en', key) ?? '',
      'zh-Hans': active?.changes['zh-Hans']?.after ?? getCurrent('zh-Hans', key) ?? '',
    };
  };

  const [values, setValues] = useState<Record<SupportedLanguage, string>>(() => buildInitialValues(initialKey));
  const [note, setNote] = useState(() => entries[initialKey]?.note ?? '');

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);

  const [position, setPosition] = useState(() =>
    computeInitialPosition(anchorRect, Math.min(460, window.innerWidth - 24), 440));

  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(computeInitialPosition(anchorRect, rect.width || 460, rect.height || 440));
  }, [anchorRect]);

  // Focus the first editor input immediately when there is only one key; when
  // multiple candidates auto-open the selector, focus the combobox trigger so
  // arrow keys and Enter work immediately without dismissing the dropdown.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (hasMultipleCandidates) {
        triggerRef.current?.focus();
      } else {
        firstInputRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hasMultipleCandidates]);

  useEffect(() => {
    if (!escapeHandlerRef) return;
    escapeHandlerRef.current = () => {
      if (!dropdownOpen) return false;
      setDropdownOpen(false);
      triggerRef.current?.focus();
      return true;
    };
    return () => {
      escapeHandlerRef.current = null;
    };
  }, [dropdownOpen, escapeHandlerRef]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || listboxRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [dropdownOpen]);

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

  const switchKey = (nextKey: string, focusInput = false) => {
    setActiveKey(nextKey);
    setValues(buildInitialValues(nextKey));
    setNote(useCopyEditorStore.getState().entries[nextKey]?.note ?? '');
    setCopiedKey(false);
    setDropdownOpen(false);
    const idx = candidates.findIndex(c => c.key === nextKey);
    if (idx >= 0) setHighlightedIndex(idx);
    if (focusInput) {
      window.setTimeout(() => firstInputRef.current?.focus(), 0);
    }
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasMultipleCandidates) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!dropdownOpen) {
        const idx = candidates.findIndex(c => c.key === activeKey);
        setHighlightedIndex(idx >= 0 ? idx : 0);
        setDropdownOpen(true);
      } else {
        setHighlightedIndex(prev => (prev + 1) % candidates.length);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!dropdownOpen) {
        const idx = candidates.findIndex(c => c.key === activeKey);
        setHighlightedIndex(idx >= 0 ? idx : 0);
        setDropdownOpen(true);
      } else {
        setHighlightedIndex(prev => (prev - 1 + candidates.length) % candidates.length);
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (dropdownOpen) {
        event.preventDefault();
        const chosen = candidates[highlightedIndex];
        if (chosen) switchKey(chosen.key, true);
      }
    }
  };

  const existingEntry = entries[activeKey];
  const previewLanguage: SupportedLanguage = (supportedLanguages as readonly string[]).includes(i18n.language)
    ? i18n.language as SupportedLanguage
    : 'en';

  const getCandidatePreview = (key: string): string => {
    const active = entries[key];
    return active?.changes[previewLanguage]?.after
      ?? getCurrent(previewLanguage, key)
      ?? active?.changes.en?.after
      ?? getCurrent('en', key)
      ?? '';
  };

  const hasAnyDiffOrNote = supportedLanguages.some(lang => {
    const original = getOriginal(lang, activeKey) ?? '';
    return values[lang] !== original;
  }) || note.trim().length > 0;

  const handleStage = () => {
    stageEntry({
      key: activeKey,
      values,
      note,
    });
    onSaved?.();
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
  const listboxId = `${idPrefix}-candidates`;

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
        className="floway-copy-editor-header floway-copy-editor-flyout-header"
        data-draggable="true"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest('button, [role="listbox"]')) return;
          dragOffsetRef.current = {
            dx: event.clientX - position.left,
            dy: event.clientY - position.top,
          };
        }}
      >
        <div className="floway-copy-editor-header-main">
          <span className="floway-copy-editor-header-key-group">
            {hasMultipleCandidates ? (
              <button
                ref={triggerRef}
                aria-controls={dropdownOpen ? listboxId : undefined}
                aria-expanded={dropdownOpen}
                aria-haspopup="listbox"
                className="floway-copy-editor-header-key-trigger winui-focus-rect"
                data-open={dropdownOpen ? 'true' : 'false'}
                type="button"
                onClick={() => {
                  setDropdownOpen(prev => {
                    const next = !prev;
                    if (next) {
                      const idx = candidates.findIndex(c => c.key === activeKey);
                      setHighlightedIndex(idx >= 0 ? idx : 0);
                    }
                    return next;
                  });
                }}
                onKeyDown={handleTriggerKeyDown}
              >
                <span className="floway-copy-editor-header-key">
                  <bdi>{activeKey}</bdi>
                </span>
                <ChevronDown16Regular
                  aria-hidden
                  className="floway-copy-editor-header-key-chevron"
                  data-open={dropdownOpen ? 'true' : 'false'}
                />
              </button>
            ) : (
              <Tooltip content={activeKey} mountNode={mountNode} relationship="description">
                <span className="floway-copy-editor-header-key">
                  <bdi>{activeKey}</bdi>
                </span>
              </Tooltip>
            )}
            <EditorIconButton
              icon={copiedKey ? <Checkmark16Regular /> : <Copy16Regular />}
              label={copiedKey ? t('common.copyEditor.keyCopied') : t('common.copyEditor.copyKey')}
              onClick={() => void handleCopyKey()}
            />
          </span>
        </div>
        <EditorIconButton
          icon={<Dismiss16Regular />}
          label={t('common.copyEditor.close')}
          onClick={onClose}
        />

        {hasMultipleCandidates && dropdownOpen && (
          <div
            ref={listboxRef}
            className="fui-Listbox floway-copy-editor-key-listbox"
            id={listboxId}
            role="listbox"
          >
            <div className="floway-combobox-listbox-content">
              {candidates.map((candidate, index) => {
                const selected = candidate.key === activeKey;
                const highlighted = index === highlightedIndex;
                const preview = getCandidatePreview(candidate.key);
                return (
                  <button
                    key={candidate.key}
                    aria-selected={selected}
                    className="fui-Option floway-copy-editor-key-option"
                    data-highlighted={highlighted ? 'true' : 'false'}
                    role="option"
                    type="button"
                    onClick={() => switchKey(candidate.key, true)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <span className="floway-copy-editor-key-option-value">
                      {preview.length > 0 ? preview : t('common.copyEditor.emptyTextPlaceholder')}
                    </span>
                    <span className="floway-copy-editor-key-option-meta">
                      <span className="floway-copy-editor-key-option-key">{candidate.key}</span>
                      {candidate.attribute && (
                        <span className="floway-copy-editor-key-option-attr">{candidate.attribute}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="floway-copy-editor-body">
        {supportedLanguages.map((language, index) => {
          const original = getOriginal(language, activeKey) ?? '';
          const modified = values[language] !== original;
          const inputId = `${idPrefix}-${language}`;
          return (
            <div key={language} className="floway-copy-editor-field">
              <div className="floway-copy-editor-field-header">
                <Label htmlFor={inputId}>{LANGUAGE_LABELS[language]}</Label>
                {modified && (
                  <EditorIconButton
                    icon={<ArrowUndo16Regular />}
                    label={t('common.copyEditor.resetLanguage')}
                    onClick={() => handleResetLanguage(language)}
                  />
                )}
              </div>

              <Textarea
                ref={index === 0 ? firstInputRef : undefined}
                className="w-full"
                id={inputId}
                placeholder={t('common.copyEditor.emptyTextPlaceholder')}
                rows={Math.min(5, Math.max(2, values[language].split('\n').length))}
                value={values[language]}
                onChange={(_, data) => setValues(prev => ({ ...prev, [language]: data.value }))}
                onFocus={() => setDropdownOpen(false)}
              />

              {modified && (
                <span className="floway-copy-editor-meta floway-copy-editor-diff-before">
                  {original}
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
            onFocus={() => setDropdownOpen(false)}
          />
        </div>
      </div>

      <div className="floway-copy-editor-footer">
        <div className="floway-copy-editor-footer-start">
          {existingEntry && (
            <EditorIconButton
              icon={<Delete16Regular />}
              label={t('common.copyEditor.revert')}
              onClick={handleRevertEntry}
            />
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
            {t('common.copyEditor.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
