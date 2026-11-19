import type { Theme } from '@fluentui/react-components';
import {
  Checkmark16Regular,
  Copy16Regular,
  Edit16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DraftsPanel } from './drafts-panel';
import { EditorFlyout } from './editor-flyout';
import { CopyEditorPortalContext } from './editor-icon-button';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { activateCopyEditorTracking, setLanguage } from '../../i18n';
import {
  COPY_EDITOR_ROOT_ATTR,
  sharedCopyEditorRegistry,
  type HitTarget,
  type KeyCandidate,
} from '../../i18n/copy-editor/dom-registry';
import { CopyEditorInternalContext, setCopyEditorFreezeActive } from '../../i18n/copy-editor/freeze';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { winuiLightTheme } from '../../winui/theme';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { LocalLanguageZiIcon } from '../ui/local-language-zi-icon';

const { Button, FluentProvider, Tooltip } = fluentComponents;

const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

// Fluent v9's `elementContains` and Tabster's `getParent` walk `_virtual.parent`
// across portals, so attaching the top-layer overlay to the clicked element or
// active floating surface keeps open dialogs, flyouts, and menus from treating
// editor interactions as outside clicks or focus escapes.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/virtualParent/setVirtualParent.ts#L1-L15
const setFluentVirtualParent = (child: HTMLElement | null, parent: Element | undefined): void => {
  if (!child) return;
  Object.assign(child, { _virtual: { parent } });
};

const findActiveFloatingSurface = (): Element | undefined => {
  const surfaces = document.querySelectorAll('.fui-DialogSurface, .fui-PopoverSurface, .fui-MenuPopover');
  return surfaces.length > 0 ? surfaces[surfaces.length - 1] : undefined;
};

const isInsideEditor = (node: EventTarget | null, host: HTMLElement | null): boolean => {
  if (!(node instanceof Node)) return false;
  if (host?.contains(node)) return true;
  let current: Node | null = node;
  while (current) {
    if (current instanceof Element && current.hasAttribute(COPY_EDITOR_ROOT_ATTR)) return true;
    current = current.parentNode;
  }
  return false;
};

const promoteTopLayer = (element: HTMLElement | null): void => {
  if (!element) return;
  const withPopover = element as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
    matches?: (selector: string) => boolean;
  };
  if (typeof withPopover.showPopover !== 'function') return;
  try {
    if (withPopover.matches?.(':popover-open')) {
      withPopover.hidePopover?.();
    }
    withPopover.showPopover();
  } catch {
    // Fallback to fixed positioning when the environment lacks top-layer popovers.
  }
};

interface ActiveFlyoutState {
  key: string;
  candidates: KeyCandidate[];
  anchorRect: DOMRect | null;
  anchorElement: Element | null;
}

const FREEZE_EVENTS = ['pointerout', 'pointerleave', 'mouseout', 'mouseleave', 'blur', 'focusout'] as const;

export default function CopyEditorOverlay({ theme = winuiLightTheme }: { theme?: Theme }) {
  const { t, i18n } = useEditorTranslation();
  const ensureInitialized = useCopyEditorStore(state => state.ensureInitialized);
  const entries = useCopyEditorStore(state => state.entries);
  const buildExportPayload = useCopyEditorStore(state => state.buildExportPayload);
  const archiveActiveAsExport = useCopyEditorStore(state => state.archiveActiveAsExport);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const quickCopyTimerRef = useRef<number | null>(null);

  const [altPressed, setAltPressed] = useState(false);
  const [hoverTarget, setHoverTarget] = useState<HitTarget | null>(null);
  const [activeFlyout, setActiveFlyout] = useState<ActiveFlyoutState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [quickCopied, setQuickCopied] = useState(false);
  const [exportedNotice, setExportedNotice] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);

  const uiOpen = activeFlyout !== null || panelOpen;
  const freezePopovers = altPressed || uiOpen;

  const altPressedRef = useRef(altPressed);
  const freezeRef = useRef(freezePopovers);
  const uiOpenRef = useRef(uiOpen);

  useEffect(() => {
    altPressedRef.current = altPressed;
    freezeRef.current = freezePopovers;
    uiOpenRef.current = uiOpen;
    setCopyEditorFreezeActive(freezePopovers);
  }, [altPressed, freezePopovers, uiOpen]);

  useEffect(() => () => {
    setCopyEditorFreezeActive(false);
    if (quickCopyTimerRef.current !== null) {
      window.clearTimeout(quickCopyTimerRef.current);
    }
  }, []);

  // Start observing the DOM first, then activate markers and load all locale
  // bundles so every already-mounted view re-renders with markers captured
  // immediately on page load (without requiring a navigation first).
  useEffect(() => {
    sharedCopyEditorRegistry.start(document.body);
    activateCopyEditorTracking();
    void ensureInitialized().then(() => {
      sharedCopyEditorRegistry.scanNow();
    });
    return () => {
      sharedCopyEditorRegistry.stop();
    };
  }, [ensureInitialized]);

  // Promote the overlay host into the browser top layer on mount and when
  // opening a surface (never on close, so an outside drag-select that closes
  // the panel is not interrupted by toggling top-layer state).
  useEffect(() => {
    promoteTopLayer(layerRef.current);
  }, []);

  useEffect(() => {
    if (activeFlyout !== null || panelOpen) {
      promoteTopLayer(layerRef.current);
    }
  }, [activeFlyout, panelOpen]);

  // Keep the virtual parent aligned with the clicked element (or topmost open
  // Fluent floating surface) so interacting with the editor never dismisses
  // underlying popovers, menus, or dialogs.
  useEffect(() => {
    const layer = layerRef.current;
    const virtualParent = activeFlyout?.anchorElement ?? (uiOpen ? findActiveFloatingSurface() : undefined);
    setFluentVirtualParent(layer, virtualParent);
    return () => setFluentVirtualParent(layer, undefined);
  }, [activeFlyout, uiOpen]);

  useEffect(() => {
    const updateHover = (x: number, y: number) => {
      if (!altPressedRef.current) {
        setHoverTarget(null);
        return;
      }
      sharedCopyEditorRegistry.scanNow();
      const target = sharedCopyEditorRegistry.resolveAtPoint(document, x, y);
      setHoverTarget(target);
    };

    const setAltSync = (next: boolean) => {
      altPressedRef.current = next;
      const nextFreeze = next || uiOpenRef.current;
      freezeRef.current = nextFreeze;
      setCopyEditorFreezeActive(nextFreeze);
      setAltPressed(next);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        setAltSync(true);
        if (pointerRef.current) {
          updateHover(pointerRef.current.x, pointerRef.current.y);
        }
        return;
      }

      if (event.key === 'Escape' && uiOpenRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setActiveFlyout(prev => {
          if (prev !== null) return null;
          setPanelOpen(false);
          return null;
        });
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        setAltSync(false);
        setHoverTarget(null);
      }
    };

    const onWindowBlur = () => {
      setAltSync(false);
      setHoverTarget(null);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (event.altKey !== altPressedRef.current) {
        setAltSync(event.altKey);
      }
      if (event.altKey) {
        updateHover(event.clientX, event.clientY);
      }
    };

    const onScroll = () => {
      if (altPressedRef.current && pointerRef.current) {
        updateHover(pointerRef.current.x, pointerRef.current.y);
      } else {
        setHoverTarget(null);
      }
    };

    const swallowAltPress = (event: MouseEvent | PointerEvent) => {
      if (!event.altKey || event.button !== 0) return;
      if (isInsideEditor(event.target, layerRef.current)) return;
      sharedCopyEditorRegistry.scanNow();
      const hit = sharedCopyEditorRegistry.resolveAtPoint(document, event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') {
        setHoverTarget(null);
        setActiveFlyout({
          key: hit.primaryKey,
          candidates: hit.candidates,
          anchorRect: hit.rect,
          anchorElement: hit.element,
        });
      }
    };

    // Freeze on-hover WinUI tooltips, info labels, and popovers while Alt is
    // held or while the editor UI is visible so the user can move the pointer
    // onto a tooltip and Alt+click its text without dismissing it.
    const onFreezeEvent = (event: Event) => {
      if (!freezeRef.current) return;
      if (isInsideEditor(event.target, layerRef.current)) return;
      event.stopImmediatePropagation();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('pointerdown', swallowAltPress, true);
    window.addEventListener('mousedown', swallowAltPress, true);
    window.addEventListener('click', swallowAltPress, true);
    for (const type of FREEZE_EVENTS) {
      window.addEventListener(type, onFreezeEvent, true);
    }

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointerdown', swallowAltPress, true);
      window.removeEventListener('mousedown', swallowAltPress, true);
      window.removeEventListener('click', swallowAltPress, true);
      for (const type of FREEZE_EVENTS) {
        window.removeEventListener(type, onFreezeEvent, true);
      }
    };
  }, []);

  const activeCount = Object.keys(entries).length;
  const showDock = activeCount > 0 || altPressed || uiOpen || quickCopied;

  const currentLang = (supportedLanguages.includes(i18n.language as SupportedLanguage)
    ? i18n.language
    : 'en') as SupportedLanguage;
  const nextPreviewLang = supportedLanguages[(supportedLanguages.indexOf(currentLang) + 1) % supportedLanguages.length]!;

  const handlePreviewLanguageToggle = async () => {
    await setLanguage(nextPreviewLang);
  };

  const handleQuickCopy = async () => {
    const payload = buildExportPayload();
    if (payload.entries.length === 0) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (!ok) return;
    archiveActiveAsExport(payload.exportedAt);
    setExportedNotice(true);
    setPanelOpen(true);
    setQuickCopied(true);
    if (quickCopyTimerRef.current !== null) {
      window.clearTimeout(quickCopyTimerRef.current);
    }
    quickCopyTimerRef.current = window.setTimeout(() => setQuickCopied(false), 1600);
  };

  if (typeof document === 'undefined') return null;

  const highlightTagTop = hoverTarget
    ? (hoverTarget.rect.top >= 28 ? hoverTarget.rect.top - 24 : hoverTarget.rect.bottom + 6)
    : 0;
  const highlightTagLeft = hoverTarget
    ? Math.max(12, Math.min(hoverTarget.rect.left, window.innerWidth - 260))
    : 0;

  return createPortal(
    <div
      ref={layerRef}
      className="floway-copy-editor-layer"
      data-floway-copy-editor-root=""
      data-tabster={JSON.stringify({ modalizer: { id: 'floway-copy-editor', isAlwaysAccessible: true, isOthersAccessible: true } })}
      popover="manual"
    >
      <CopyEditorInternalContext value={true}>
        <CopyEditorPortalContext value={portalRoot}>
          <FluentProvider className="floway-copy-editor-provider" theme={theme}>
            {altPressed && hoverTarget && (
              <>
                <div
                  className="floway-copy-editor-highlight"
                  style={{
                    left: `${hoverTarget.rect.left - 2}px`,
                    top: `${hoverTarget.rect.top - 2}px`,
                    width: `${hoverTarget.rect.width + 4}px`,
                    height: `${hoverTarget.rect.height + 4}px`,
                  }}
                />
                <div
                  className="floway-copy-editor-highlight-tag"
                  style={{ left: `${highlightTagLeft}px`, top: `${highlightTagTop}px` }}
                >
                  {hoverTarget.primaryKey}
                  {hoverTarget.candidates.length > 1 ? ` (+${hoverTarget.candidates.length - 1})` : ''}
                </div>
              </>
            )}

            {panelOpen && (
              <DraftsPanel
                exportedNotice={exportedNotice}
                onClearExportedNotice={() => setExportedNotice(false)}
                onClose={() => {
                  setPanelOpen(false);
                  setExportedNotice(false);
                }}
                onExported={() => setExportedNotice(true)}
                onEditKey={key => {
                  setActiveFlyout({
                    key,
                    candidates: [{ key, baseKey: key, source: 'text' }],
                    anchorRect: null,
                    anchorElement: findActiveFloatingSurface() ?? null,
                  });
                }}
              />
            )}

            {activeFlyout && (
              <EditorFlyout
                key={activeFlyout.key}
                anchorRect={activeFlyout.anchorRect}
                candidates={activeFlyout.candidates}
                initialKey={activeFlyout.key}
                onClose={() => setActiveFlyout(null)}
                onSaved={() => { setExportedNotice(false); setPanelOpen(true); }}
              />
            )}

            {showDock && (
              <div
                aria-label={t('common.copyEditor.dockLabel')}
                className="floway-copy-editor-dock"
                role="region"
              >
                <Button
                  appearance="subtle"
                  icon={<Edit16Regular />}
                  size="small"
                  onClick={() => setPanelOpen(open => !open)}
                >
                  {t('common.copyEditor.editsCount', { count: activeCount })}
                </Button>

                <span className="floway-copy-editor-dock-divider" />

                <Tooltip content={t('common.copyEditor.previewLanguage')} mountNode={portalRoot} relationship="description">
                  <Button
                    appearance="subtle"
                    aria-label={t('common.copyEditor.previewLanguage')}
                    icon={<LocalLanguageZiIcon size={16} />}
                    size="small"
                    onClick={() => void handlePreviewLanguageToggle()}
                  >
                    {SHORT_LANGUAGE_LABELS[currentLang]}
                  </Button>
                </Tooltip>

                {(activeCount > 0 || quickCopied) && (
                  <>
                    <span className="floway-copy-editor-dock-divider" />
                    <Button
                      appearance="primary"
                      icon={quickCopied ? <Checkmark16Regular /> : <Copy16Regular />}
                      size="small"
                      onClick={() => void handleQuickCopy()}
                    >
                      {quickCopied ? t('common.copy.copied') : t('common.copyEditor.export')}
                    </Button>
                  </>
                )}
              </div>
            )}
            <div ref={setPortalRoot} className="floway-copy-editor-portal-host" />
          </FluentProvider>
        </CopyEditorPortalContext>
      </CopyEditorInternalContext>
    </div>,
    document.body,
  );
}
