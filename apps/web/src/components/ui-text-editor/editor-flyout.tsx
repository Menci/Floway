import {
  ArrowUndo16Regular,
  Checkmark16Regular,
  ChevronDown16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';

import { EditorIconButton, useUiTextEditorPortal } from './editor-icon-button';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { LANGUAGE_LABELS, useUiTextEditorStore } from '../../i18n/ui-text-editor/store';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Label, Tooltip } = fluentComponents;

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
  candidates: string[];
  anchorRect: DOMRect | null;
  escapeHandlerRef?: MutableRefObject<(() => boolean) | null>;
  onClose: () => void;
  onSaved?: () => void;
}

export function EditorFlyout({ anchorRect, candidates, escapeHandlerRef, initialKey, onClose, onSaved }: EditorFlyoutProps) {
  const { i18n, t } = useEditorTranslation();
  const mountNode = useUiTextEditorPortal();
  const idPrefix = useId();
  const entries = useUiTextEditorStore(state => state.entries);
  const getOriginal = useUiTextEditorStore(state => state.getOriginal);
  const getCurrent = useUiTextEditorStore(state => state.getCurrent);
  const saveEntry = useUiTextEditorStore(state => state.saveEntry);
  const revertEntry = useUiTextEditorStore(state => state.revertEntry);
  const revertLanguage = useUiTextEditorStore(state => state.revertLanguage);

  const hasMultipleCandidates = candidates.length > 1;
  const [activeKey, setActiveKey] = useState(initialKey);
  const [copiedKey, setCopiedKey] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(hasMultipleCandidates);
  const [highlightedIndex, setHighlightedIndex] = useState(() => {
    const idx = candidates.indexOf(initialKey);
    return idx >= 0 ? idx : 0;
  });

  const buildInitialValues = (key: string): Record<SupportedLanguage, string> => {
    const active = useUiTextEditorStore.getState().entries[key];
    return {
      'en': active?.changes.en?.after ?? getCurrent('en', key) ?? '',
      'zh-Hans': active?.changes['zh-Hans']?.after ?? getCurrent('zh-Hans', key) ?? '',
    };
  };

  const [values, setValues] = useState<Record<SupportedLanguage, string>>(() => buildInitialValues(initialKey));
  const [dirtyLanguages, setDirtyLanguages] = useState<Partial<Record<SupportedLanguage, boolean>>>({});
  const [note, setNote] = useState(() => entries[initialKey]?.note ?? '');

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const [position, setPosition] = useState(() =>
    computeInitialPosition(anchorRect, Math.min(460, window.innerWidth - 24), 440));

  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(computeInitialPosition(anchorRect, rect.width || 460, rect.height || 440));
  }, [anchorRect]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

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

  // Keep the keyboard-highlighted option scrolled into view inside long lists.
  useEffect(() => {
    if (!dropdownOpen) return;
    const optionEl = listboxRef.current?.querySelector<HTMLElement>(`[data-option-index="${highlightedIndex}"]`);
    optionEl?.scrollIntoView?.({ block: 'nearest' });
  }, [dropdownOpen, highlightedIndex]);

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
    setDirtyLanguages({});
    setNote(useUiTextEditorStore.getState().entries[nextKey]?.note ?? '');
    setCopiedKey(false);
    setDropdownOpen(false);
    const idx = candidates.indexOf(nextKey);
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
        const idx = candidates.indexOf(activeKey);
        setHighlightedIndex(idx >= 0 ? idx : 0);
        setDropdownOpen(true);
      } else {
        setHighlightedIndex(prev => (prev + 1) % candidates.length);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!dropdownOpen) {
        const idx = candidates.indexOf(activeKey);
        setHighlightedIndex(idx >= 0 ? idx : 0);
        setDropdownOpen(true);
      } else {
        setHighlightedIndex(prev => (prev - 1 + candidates.length) % candidates.length);
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (dropdownOpen) {
        event.preventDefault();
        const chosen = candidates[highlightedIndex];
        if (chosen) switchKey(chosen, true);
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

  // Only languages the user actually edited (or that already belong to the
  // active entry) are submitted, so adding a note on a key with a historical
  // override does not copy untouched history text into the active batch.
  const submittedValues: Partial<Record<SupportedLanguage, string>> = {};
  for (const lang of supportedLanguages) {
    if (dirtyLanguages[lang] || existingEntry?.changes[lang] !== undefined) {
      submittedValues[lang] = values[lang];
    }
  }

  const hasAnyDiffOrNote = supportedLanguages.some(lang => {
    if (!(lang in submittedValues)) return false;
    const original = getOriginal(lang, activeKey) ?? '';
    return submittedValues[lang] !== original;
  }) || note.trim().length > 0;

  const handleSave = () => {
    saveEntry({
      key: activeKey,
      values: submittedValues,
      note,
    });
    onSaved?.();
    onClose();
  };

  const handleCopyKey = async () => {
    const ok = await copyToClipboard(activeKey);
    if (ok) {
      setCopiedKey(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopiedKey(false), 1500);
    }
  };

  const handleResetLanguage = (language: SupportedLanguage) => {
    const original = getOriginal(language, activeKey) ?? '';
    setValues(prev => ({ ...prev, [language]: original }));
    setDirtyLanguages(prev => ({ ...prev, [language]: false }));
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
    setDirtyLanguages({});
    setNote('');
  };

  const noteInputId = `${idPrefix}-note`;
  const listboxId = `${idPrefix}-candidates`;
  const optionIdFor = (index: number) => `${idPrefix}-option-${index}`;

  return (
    <div
      ref={surfaceRef}
      aria-label={t('common.uiTextEditor.flyoutTitle')}
      className="floway-ui-text-editor-surface floway-ui-text-editor-flyout"
      role="dialog"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          handleSave();
        }
      }}
    >
      <div
        className="floway-ui-text-editor-header floway-ui-text-editor-flyout-header"
        data-draggable="true"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest('button, [role="listbox"]')) return;
          dragOffsetRef.current = {
            dx: event.clientX - position.left,
            dy: event.clientY - position.top,
          };
        }}
      >
        <div className="floway-ui-text-editor-header-main">
          <span className="floway-ui-text-editor-header-key-group">
            {hasMultipleCandidates ? (
              <button
                ref={triggerRef}
                aria-activedescendant={dropdownOpen ? optionIdFor(highlightedIndex) : undefined}
                aria-controls={dropdownOpen ? listboxId : undefined}
                aria-expanded={dropdownOpen}
                aria-haspopup="listbox"
                className="floway-ui-text-editor-header-key-trigger winui-focus-rect"
                data-open={dropdownOpen ? 'true' : 'false'}
                type="button"
                onClick={() => {
                  setDropdownOpen(prev => {
                    const next = !prev;
                    if (next) {
                      const idx = candidates.indexOf(activeKey);
                      setHighlightedIndex(idx >= 0 ? idx : 0);
                    }
                    return next;
                  });
                }}
                onKeyDown={handleTriggerKeyDown}
              >
                <span className="floway-ui-text-editor-header-key">
                  <bdi>{activeKey}</bdi>
                </span>
                <ChevronDown16Regular
                  aria-hidden
                  className="floway-ui-text-editor-header-key-chevron"
                  data-open={dropdownOpen ? 'true' : 'false'}
                />
              </button>
            ) : (
              <Tooltip content={activeKey} mountNode={mountNode} relationship="description">
                <span className="floway-ui-text-editor-header-key">
                  <bdi>{activeKey}</bdi>
                </span>
              </Tooltip>
            )}
            <EditorIconButton
              icon={copiedKey ? <Checkmark16Regular /> : <Copy16Regular />}
              label={copiedKey ? t('common.uiTextEditor.keyCopied') : t('common.uiTextEditor.copyKey')}
              onClick={() => void handleCopyKey()}
            />
          </span>
        </div>
        <EditorIconButton
          icon={<Dismiss16Regular />}
          label={t('common.uiTextEditor.close')}
          onClick={onClose}
        />

        {hasMultipleCandidates && dropdownOpen && (
          <div
            ref={listboxRef}
            className="floway-ui-text-editor-key-listbox"
            id={listboxId}
            role="listbox"
          >
            <div className="floway-combobox-listbox-content">
              {candidates.map((candidateKey, index) => {
                const selected = candidateKey === activeKey;
                const highlighted = index === highlightedIndex;
                const preview = getCandidatePreview(candidateKey);
                return (
                  <button
                    key={candidateKey}
                    aria-selected={selected}
                    className="fui-Option floway-ui-text-editor-key-option"
                    data-highlighted={highlighted ? 'true' : 'false'}
                    data-option-index={index}
                    id={optionIdFor(index)}
                    role="option"
                    type="button"
                    onClick={() => switchKey(candidateKey, true)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <span className="floway-ui-text-editor-key-option-value">
                      {preview.length > 0 ? preview : t('common.uiTextEditor.emptyTextPlaceholder')}
                    </span>
                    <span className="floway-ui-text-editor-key-option-key">{candidateKey}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="floway-ui-text-editor-body">
        {supportedLanguages.map((language, index) => {
          const original = getOriginal(language, activeKey) ?? '';
          const modified = values[language] !== original;
          const inputId = `${idPrefix}-${language}`;
          return (
            <div key={language} className="floway-ui-text-editor-field">
              <div className="floway-ui-text-editor-field-header">
                <Label htmlFor={inputId}>{LANGUAGE_LABELS[language]}</Label>
                {modified && (
                  <EditorIconButton
                    icon={<ArrowUndo16Regular />}
                    label={t('common.uiTextEditor.resetLanguage')}
                    onClick={() => handleResetLanguage(language)}
                  />
                )}
              </div>

              <Textarea
                ref={index === 0 ? firstInputRef : undefined}
                className="w-full"
                id={inputId}
                placeholder={t('common.uiTextEditor.emptyTextPlaceholder')}
                rows={Math.min(5, Math.max(2, values[language].split('\n').length))}
                value={values[language]}
                onChange={(_, data) => {
                  setValues(prev => ({ ...prev, [language]: data.value }));
                  setDirtyLanguages(prev => ({ ...prev, [language]: true }));
                }}
                onFocus={() => setDropdownOpen(false)}
              />

              {modified && (
                <span className="floway-ui-text-editor-meta floway-ui-text-editor-diff-before">
                  {original}
                </span>
              )}
            </div>
          );
        })}

        <div className="floway-ui-text-editor-field">
          <div className="floway-ui-text-editor-field-header">
            <Label htmlFor={noteInputId}>{t('common.uiTextEditor.noteLabel')}</Label>
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

      <div className="floway-ui-text-editor-footer">
        <div className="floway-ui-text-editor-footer-start">
          {existingEntry && (
            <EditorIconButton
              icon={<Delete16Regular />}
              label={t('common.uiTextEditor.delete')}
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
            onClick={handleSave}
          >
            {t('common.uiTextEditor.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
