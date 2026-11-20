import type { Theme } from '@fluentui/react-components';
import {
  Checkmark16Regular,
  Copy16Regular,
  Edit16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { EditorFlyout } from './editor-flyout';
import { UiTextEditorPortalContext } from './editor-icon-button';
import { EditsPanel } from './edits-panel';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { activateUiTextEditorTracking, setLanguage } from '../../i18n';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import {
  UI_TEXT_EDITOR_ROOT_ATTR,
  isInsideUiTextEditor,
  sharedUiTextEditorRegistry,
  type HitTarget,
} from '../../i18n/ui-text-editor/dom-registry';
import { UiTextEditorInternalContext, setUiTextEditorFreezeActive } from '../../i18n/ui-text-editor/freeze';
import { SHORT_LANGUAGE_LABELS, useUiTextEditorStore } from '../../i18n/ui-text-editor/store';
import { winuiLightTheme } from '../../winui/theme';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { LocalLanguageZiIcon } from '../ui/local-language-zi-icon';

const { Button, FluentProvider, Tooltip } = fluentComponents;

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
  candidates: string[];
  anchorRect: DOMRect | null;
  anchorElement: Element | null;
}

const FREEZE_EVENTS = ['pointerout', 'pointerleave', 'mouseout', 'mouseleave', 'blur', 'focusout'] as const;

const HIGHLIGHT_PAD = 2;
const HIGHLIGHT_BORDER = 1.5;
const HIGHLIGHT_RADIUS = 4;
const HIGHLIGHT_INNER_RADIUS = Math.max(0, HIGHLIGHT_RADIUS - HIGHLIGHT_BORDER);
const HIGHLIGHT_MAX_LINE_GAP = 8;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function HighlightShape({ boundingRect, rects }: { boundingRect: DOMRect; rects: DOMRect[] }) {
  const maskPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  if (rects.length <= 1) {
    const r = rects[0] ?? boundingRect;
    return (
      <div
        className="floway-ui-text-editor-highlight"
        style={{
          left: `${r.left - HIGHLIGHT_PAD}px`,
          top: `${r.top - HIGHLIGHT_PAD}px`,
          width: `${r.width + HIGHLIGHT_PAD * 2}px`,
          height: `${r.height + HIGHLIGHT_PAD * 2}px`,
        }}
      />
    );
  }

  const boxes: Box[] = rects.map(r => ({
    left: r.left - HIGHLIGHT_PAD,
    top: r.top - HIGHLIGHT_PAD,
    right: r.right + HIGHLIGHT_PAD,
    bottom: r.bottom + HIGHLIGHT_PAD,
  }));

  // Bridge small line-height gaps between horizontally overlapping lines so
  // wrapped multi-line keys read as one continuous shape.
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    const overlapLeft = Math.max(a.left, b.left);
    const overlapRight = Math.min(a.right, b.right);
    if (overlapRight <= overlapLeft) continue;
    const gap = b.top - a.bottom;
    if (gap <= HIGHLIGHT_MAX_LINE_GAP) {
      const mid = (a.bottom + b.top) / 2;
      a.bottom = Math.max(a.bottom, mid + HIGHLIGHT_BORDER);
      b.top = Math.min(b.top, mid - HIGHLIGHT_BORDER);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (box.left < minX) minX = box.left;
    if (box.top < minY) minY = box.top;
    if (box.right > maxX) maxX = box.right;
    if (box.bottom > maxY) maxY = box.bottom;
  }
  const width = maxX - minX;
  const height = maxY - minY;

  const outerBridges: Box[] = [];
  const innerBridges: Box[] = [];
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    if (a.bottom <= b.top) continue;
    const outerLeft = Math.max(a.left, b.left);
    const outerRight = Math.min(a.right, b.right);
    if (outerRight > outerLeft) {
      const outerTop = Math.max(a.top + HIGHLIGHT_RADIUS, b.top - HIGHLIGHT_RADIUS);
      const outerBottom = Math.min(b.bottom - HIGHLIGHT_RADIUS, a.bottom + HIGHLIGHT_RADIUS);
      if (outerBottom > outerTop) {
        outerBridges.push({ left: outerLeft, top: outerTop, right: outerRight, bottom: outerBottom });
      }
    }
    const innerLeft = Math.max(a.left, b.left) + HIGHLIGHT_BORDER;
    const innerRight = Math.min(a.right, b.right) - HIGHLIGHT_BORDER;
    if (innerRight > innerLeft) {
      const innerTop = Math.max(a.top + HIGHLIGHT_BORDER, b.top - HIGHLIGHT_RADIUS);
      const innerBottom = Math.min(b.bottom - HIGHLIGHT_BORDER, a.bottom + HIGHLIGHT_RADIUS);
      if (innerBottom > innerTop) {
        innerBridges.push({ left: innerLeft, top: innerTop, right: innerRight, bottom: innerBottom });
      }
    }
  }

  const outerMaskId = `${maskPrefix}-outer`;
  const borderMaskId = `${maskPrefix}-border`;

  return (
    <svg
      aria-hidden="true"
      className="floway-ui-text-editor-highlight-svg"
      height={height}
      style={{ left: `${minX}px`, top: `${minY}px` }}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        <mask id={outerMaskId} maskUnits="userSpaceOnUse">
          {boxes.map((box, index) => (
            <rect
              key={`of-${index}`}
              fill="white"
              height={box.bottom - box.top}
              rx={HIGHLIGHT_RADIUS}
              width={box.right - box.left}
              x={box.left - minX}
              y={box.top - minY}
            />
          ))}
          {outerBridges.map((bridge, index) => (
            <rect
              key={`ob-${index}`}
              fill="white"
              height={bridge.bottom - bridge.top}
              width={bridge.right - bridge.left}
              x={bridge.left - minX}
              y={bridge.top - minY}
            />
          ))}
        </mask>
        <mask id={borderMaskId} maskUnits="userSpaceOnUse">
          {boxes.map((box, index) => (
            <rect
              key={`bo-${index}`}
              fill="white"
              height={box.bottom - box.top}
              rx={HIGHLIGHT_RADIUS}
              width={box.right - box.left}
              x={box.left - minX}
              y={box.top - minY}
            />
          ))}
          {outerBridges.map((bridge, index) => (
            <rect
              key={`bob-${index}`}
              fill="white"
              height={bridge.bottom - bridge.top}
              width={bridge.right - bridge.left}
              x={bridge.left - minX}
              y={bridge.top - minY}
            />
          ))}
          {boxes.map((box, index) => (
            <rect
              key={`bi-${index}`}
              fill="black"
              height={Math.max(0, box.bottom - box.top - HIGHLIGHT_BORDER * 2)}
              rx={HIGHLIGHT_INNER_RADIUS}
              width={Math.max(0, box.right - box.left - HIGHLIGHT_BORDER * 2)}
              x={box.left - minX + HIGHLIGHT_BORDER}
              y={box.top - minY + HIGHLIGHT_BORDER}
            />
          ))}
          {innerBridges.map((bridge, index) => (
            <rect
              key={`bib-${index}`}
              fill="black"
              height={bridge.bottom - bridge.top}
              width={bridge.right - bridge.left}
              x={bridge.left - minX}
              y={bridge.top - minY}
            />
          ))}
        </mask>
      </defs>
      <rect
        fill="var(--winui-accent-tint-fill-default)"
        height={height}
        mask={`url(#${outerMaskId})`}
        width={width}
        x={0}
        y={0}
      />
      <rect
        fill="var(--winui-accent-fill-default)"
        height={height}
        mask={`url(#${borderMaskId})`}
        width={width}
        x={0}
        y={0}
      />
    </svg>
  );
}

export default function UiTextEditorOverlay({ theme = winuiLightTheme }: { theme?: Theme }) {
  const { t, i18n } = useEditorTranslation();
  const ensureInitialized = useUiTextEditorStore(state => state.ensureInitialized);
  const entries = useUiTextEditorStore(state => state.entries);
  const createExportSnapshot = useUiTextEditorStore(state => state.createExportSnapshot);
  const commitExportSnapshot = useUiTextEditorStore(state => state.commitExportSnapshot);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const flyoutEscapeRef = useRef<(() => boolean) | null>(null);
  const highlightTagRef = useRef<HTMLDivElement | null>(null);
  const exportingRef = useRef(false);
  const quickCopyTimerRef = useRef<number | null>(null);

  const [altPressed, setAltPressed] = useState(false);
  const [hoverState, setHoverState] = useState<{ target: HitTarget; pointerX: number; pointerY: number } | null>(null);
  const [activeFlyout, setActiveFlyout] = useState<ActiveFlyoutState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [quickCopied, setQuickCopied] = useState(false);
  const [exportedNotice, setExportedNotice] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const [highlightTagSize, setHighlightTagSize] = useState<{ width: number; height: number } | null>(null);

  const uiOpen = activeFlyout !== null || panelOpen;
  const freezePopovers = altPressed || uiOpen;

  const altPressedRef = useRef(altPressed);
  const freezeRef = useRef(freezePopovers);
  const uiOpenRef = useRef(uiOpen);

  useEffect(() => {
    altPressedRef.current = altPressed;
    freezeRef.current = freezePopovers;
    uiOpenRef.current = uiOpen;
    setUiTextEditorFreezeActive(freezePopovers);
  }, [altPressed, freezePopovers, uiOpen]);

  useEffect(() => () => {
    setUiTextEditorFreezeActive(false);
    if (quickCopyTimerRef.current !== null) {
      window.clearTimeout(quickCopyTimerRef.current);
    }
  }, []);

  // Start observing the DOM first, then activate markers and load all locale
  // bundles so every already-mounted view re-renders with markers captured
  // immediately on page load.
  useEffect(() => {
    sharedUiTextEditorRegistry.start(document.body);
    activateUiTextEditorTracking();
    void ensureInitialized().then(() => {
      sharedUiTextEditorRegistry.scanNow();
    });
    return () => {
      sharedUiTextEditorRegistry.stop();
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

  useEffect(() => {
    const layer = layerRef.current;
    const virtualParent = activeFlyout?.anchorElement ?? (uiOpen ? findActiveFloatingSurface() : undefined);
    setFluentVirtualParent(layer, virtualParent);
    return () => setFluentVirtualParent(layer, undefined);
  }, [activeFlyout, uiOpen]);

  useEffect(() => {
    const updateHover = (x: number, y: number) => {
      if (!altPressedRef.current || !useUiTextEditorStore.getState().initialized) {
        setHoverState(null);
        return;
      }
      const target = sharedUiTextEditorRegistry.resolveAtPoint(document, x, y);
      setHoverState(target ? { target, pointerX: x, pointerY: y } : null);
    };

    const setAltSync = (next: boolean) => {
      altPressedRef.current = next;
      const nextFreeze = next || uiOpenRef.current;
      freezeRef.current = nextFreeze;
      setUiTextEditorFreezeActive(nextFreeze);
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
        // Let an open nested editor popover (such as a delete confirmation
        // flyout) handle Escape before closing the flyout or panel beneath it.
        if (layerRef.current?.querySelector('.fui-PopoverSurface')) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (flyoutEscapeRef.current?.()) return;
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
        setHoverState(null);
      }
    };

    const onWindowBlur = () => {
      setAltSync(false);
      setHoverState(null);
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
      }
    };

    const swallowAltPress = (event: MouseEvent | PointerEvent) => {
      if (!event.altKey || event.button !== 0) return;
      if (isInsideUiTextEditor(event.target, layerRef.current)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.type !== 'click' || !useUiTextEditorStore.getState().initialized) return;

      const hit = sharedUiTextEditorRegistry.resolveAtPoint(document, event.clientX, event.clientY);
      if (hit) {
        setHoverState(null);
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
      if (isInsideUiTextEditor(event.target, layerRef.current)) return;
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

  const exportActiveEdits = useCallback(async (): Promise<'empty' | 'copied' | 'failed'> => {
    if (exportingRef.current) return 'empty';
    const snapshot = createExportSnapshot();
    if (!snapshot) return 'empty';
    exportingRef.current = true;
    try {
      const ok = await copyToClipboard(JSON.stringify(snapshot.payload, null, 2));
      if (!ok) return 'failed';
      commitExportSnapshot(snapshot);
      setExportedNotice(true);
      setPanelOpen(true);
      setQuickCopied(true);
      if (quickCopyTimerRef.current !== null) {
        window.clearTimeout(quickCopyTimerRef.current);
      }
      quickCopyTimerRef.current = window.setTimeout(() => setQuickCopied(false), 1600);
      return 'copied';
    } finally {
      exportingRef.current = false;
    }
  }, [commitExportSnapshot, createExportSnapshot]);

  const activeCount = Object.keys(entries).length;
  const showDock = activeCount > 0 || altPressed || uiOpen || quickCopied;

  const currentLang = i18n.language as SupportedLanguage;
  const nextPreviewLang = supportedLanguages[(supportedLanguages.indexOf(currentLang) + 1) % supportedLanguages.length]!;

  const handlePreviewLanguageToggle = async () => {
    await setLanguage(nextPreviewLang);
  };

  const hoverTarget = hoverState?.target ?? null;

  const computeHighlightTagPosition = (
    rect: DOMRect,
    pointerX: number,
    pointerY: number,
    measuredSize: { width: number; height: number } | null,
  ): { left: number; top: number } => {
    const margin = 8;
    const gap = 6;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const tagWidth = measuredSize?.width ?? Math.min(440, Math.max(0, viewportWidth - margin * 2));
    const tagHeight = measuredSize?.height ?? 24;
    const maxTop = Math.max(margin, viewportHeight - tagHeight - margin);
    const maxLeft = Math.max(margin, viewportWidth - tagWidth - margin);
    let top: number;
    let preferredLeft = rect.left;
    if (rect.top >= tagHeight + margin) {
      top = rect.top - tagHeight - gap;
    } else if (rect.bottom + gap + tagHeight <= viewportHeight - margin) {
      top = rect.bottom + gap;
    } else {
      // Full-height targets (such as the sidebar nav) leave no room above or
      // below the box, so anchor the tag beside the pointer within the viewport.
      const abovePointer = pointerY - tagHeight - 14;
      top = abovePointer >= margin ? abovePointer : pointerY + 18;
      preferredLeft = pointerX;
    }
    const clampedTop = Math.round(Math.max(margin, Math.min(top, maxTop)));
    const clampedLeft = Math.round(Math.max(margin, Math.min(preferredLeft, maxLeft)));
    return { left: clampedLeft, top: clampedTop };
  };

  const highlightTagKey = hoverTarget
    ? `${hoverTarget.primaryKey}|${hoverTarget.primaryInvisible ? 'invisible' : ''}|${hoverTarget.candidates.length}`
    : '';

  useLayoutEffect(() => {
    const el = highlightTagRef.current;
    if (!altPressed || !hoverTarget || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return;
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    setHighlightTagSize(prev => (prev?.width === width && prev.height === height ? prev : { width, height }));
  }, [altPressed, hoverTarget, highlightTagKey]);

  const highlightTagPos = hoverState
    ? computeHighlightTagPosition(hoverState.target.rect, hoverState.pointerX, hoverState.pointerY, highlightTagSize)
    : { left: 0, top: 0 };

  const highlightMetaParts: string[] = [];
  if (hoverTarget?.primaryInvisible) {
    highlightMetaParts.push('invisible');
  }
  if (hoverTarget && hoverTarget.candidates.length > 1) {
    highlightMetaParts.push(`+${hoverTarget.candidates.length - 1}`);
  }

  return createPortal(
    <div
      ref={layerRef}
      className="floway-ui-text-editor-layer"
      {...{ [UI_TEXT_EDITOR_ROOT_ATTR]: '' }}
      data-tabster={JSON.stringify({ modalizer: { id: 'floway-ui-text-editor', isAlwaysAccessible: true, isOthersAccessible: true } })}
      popover="manual"
    >
      <UiTextEditorInternalContext value={true}>
        <UiTextEditorPortalContext value={portalRoot}>
          <FluentProvider className="floway-ui-text-editor-provider" theme={theme}>
            {altPressed && hoverTarget && (
              <>
                <HighlightShape boundingRect={hoverTarget.rect} rects={hoverTarget.rects} />
                <div
                  ref={highlightTagRef}
                  className="floway-ui-text-editor-highlight-tag"
                  style={{ left: `${highlightTagPos.left}px`, top: `${highlightTagPos.top}px` }}
                >
                  {hoverTarget.primaryKey}
                  {highlightMetaParts.length > 0 && (
                    <span className="floway-ui-text-editor-highlight-tag-more">
                      {` (${highlightMetaParts.join(', ')})`}
                    </span>
                  )}
                </div>
              </>
            )}

            {panelOpen && (
              <EditsPanel
                exportedNotice={exportedNotice}
                onClearExportedNotice={() => setExportedNotice(false)}
                onClose={() => {
                  setPanelOpen(false);
                  setExportedNotice(false);
                }}
                onEditKey={key => {
                  setActiveFlyout({
                    key,
                    candidates: [key],
                    anchorRect: null,
                    anchorElement: findActiveFloatingSurface() ?? null,
                  });
                }}
                onExportActive={exportActiveEdits}
              />
            )}

            {activeFlyout && (
              <EditorFlyout
                key={activeFlyout.key}
                anchorRect={activeFlyout.anchorRect}
                candidates={activeFlyout.candidates}
                escapeHandlerRef={flyoutEscapeRef}
                initialKey={activeFlyout.key}
                onClose={() => setActiveFlyout(null)}
                onSaved={() => { setExportedNotice(false); setPanelOpen(true); }}
              />
            )}

            {showDock && (
              <div
                aria-label={t('common.uiTextEditor.dockLabel')}
                className="floway-ui-text-editor-dock"
                role="region"
              >
                <Button
                  appearance="subtle"
                  icon={<Edit16Regular />}
                  size="small"
                  onClick={() => setPanelOpen(prev => !prev)}
                >
                  {t('common.uiTextEditor.editsCount', { count: activeCount })}
                </Button>

                <span className="floway-ui-text-editor-dock-divider" />

                <Tooltip content={t('common.uiTextEditor.previewLanguage')} mountNode={portalRoot} relationship="description">
                  <Button
                    appearance="subtle"
                    aria-label={t('common.uiTextEditor.previewLanguage')}
                    icon={<LocalLanguageZiIcon size={16} />}
                    size="small"
                    onClick={() => void handlePreviewLanguageToggle()}
                  >
                    {SHORT_LANGUAGE_LABELS[currentLang]}
                  </Button>
                </Tooltip>

                {activeCount > 0 && (
                  <>
                    <span className="floway-ui-text-editor-dock-divider" />
                    <Button
                      appearance="primary"
                      icon={quickCopied ? <Checkmark16Regular /> : <Copy16Regular />}
                      size="small"
                      onClick={() => void exportActiveEdits()}
                    >
                      {quickCopied ? t('common.copy.copied') : t('common.uiTextEditor.export')}
                    </Button>
                  </>
                )}
              </div>
            )}

            <div
              ref={setPortalRoot}
              className="floway-ui-text-editor-portal-host"
            />
          </FluentProvider>
        </UiTextEditorPortalContext>
      </UiTextEditorInternalContext>
    </div>,
    document.body,
  );
}
