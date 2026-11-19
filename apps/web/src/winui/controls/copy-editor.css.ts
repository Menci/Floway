// WinUI 3 surfaces for the in-context copy editor overlay, hosted inside a
// native top-layer popover so it sits above dialogs, flyouts, menus, and
// tooltips without contending for z-index.
export const copyEditorCss = `
.floway-copy-editor-layer {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: visible;
  pointer-events: none;
}

.floway-copy-editor-layer::backdrop {
  background: transparent;
  pointer-events: none;
}

/* FluentProvider supplies theme CSS variables for all controls inside the top
   layer while staying visually transparent and click-through outside the
   editor surfaces themselves. */
.fui-FluentProvider.floway-copy-editor-provider {
  position: fixed;
  inset: 0;
  background-color: transparent;
  pointer-events: none;
}

.floway-copy-editor-highlight {
  position: fixed;
  pointer-events: none;
  border-radius: var(--winui-control-corner-radius);
  border: 1.5px solid var(--winui-accent-fill-default);
  background-color: var(--winui-accent-tint-fill-default);
  opacity: 0.42;
  box-sizing: border-box;
}

.floway-copy-editor-highlight-tag {
  position: fixed;
  pointer-events: none;
  max-width: min(440px, calc(100vw - 24px));
  padding: 3px 8px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 4px 12px var(--winui-tooltip-shadow-color);
  font-family: var(--fontFamilyMonospace);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.floway-copy-editor-dock {
  position: fixed;
  right: 16px;
  bottom: 16px;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 8px 24px var(--winui-tooltip-shadow-color);
  backdrop-filter: blur(24px) saturate(125%);
}

.floway-copy-editor-dock-divider {
  width: 1px;
  height: 18px;
  background-color: var(--winui-divider-stroke-default);
  flex: none;
}

.floway-copy-editor-surface {
  position: fixed;
  pointer-events: auto;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 16px 40px var(--winui-tooltip-shadow-color);
  backdrop-filter: blur(28px) saturate(125%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.floway-copy-editor-flyout {
  width: min(468px, calc(100vw - 24px));
  max-height: min(640px, calc(100vh - 24px));
}

.floway-copy-editor-panel {
  right: 16px;
  bottom: 64px;
  width: min(468px, calc(100vw - 32px));
  max-height: min(640px, calc(100vh - 96px));
}

.floway-copy-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  flex: none;
}

.floway-copy-editor-header[data-draggable="true"] {
  cursor: grab;
  user-select: none;
}

.floway-copy-editor-header[data-draggable="true"]:active {
  cursor: grabbing;
}

.floway-copy-editor-tabs {
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  flex: none;
}

.floway-copy-editor-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  flex: 1 1 auto;
}

.floway-copy-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--winui-divider-stroke-default);
  background-color: var(--winui-layer-fill-default);
  flex: none;
}

.floway-copy-editor-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-control-stroke-default);
  background-color: var(--winui-control-fill-secondary);
  color: var(--winui-text-fill-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.floway-copy-editor-pill[data-tone="accent"] {
  border-color: var(--winui-accent-tint-stroke);
  background-color: var(--winui-accent-tint-fill-default);
  color: var(--winui-accent-text-fill-primary);
}

.floway-copy-editor-pill[data-tone="caution"] {
  border-color: var(--winui-control-stroke-default);
  background-color: var(--winui-system-fill-caution-background);
  color: var(--winui-system-fill-caution);
}

.floway-copy-editor-pill[data-mono="true"] {
  font-family: var(--fontFamilyMonospace);
}

.floway-copy-editor-key-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 10px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-card-stroke-default);
  background-color: var(--winui-card-background-fill-default);
  min-width: 0;
}

.floway-copy-editor-key-text {
  font-family: var(--fontFamilyMonospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--winui-text-fill-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.floway-copy-editor-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.floway-copy-editor-section-label {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-secondary);
}

.floway-copy-editor-candidate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-control-stroke-default);
  background-color: var(--winui-control-fill-default);
  color: var(--winui-text-fill-primary);
  font-family: var(--fontFamilyMonospace);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}

.floway-copy-editor-candidate:hover {
  background-color: var(--winui-control-fill-secondary);
}

.floway-copy-editor-candidate[data-active="true"] {
  border-color: var(--winui-accent-tint-stroke);
  background-color: var(--winui-accent-tint-fill-default);
  color: var(--winui-accent-text-fill-primary);
}

.floway-copy-editor-original {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-secondary);
  word-break: break-word;
}

.floway-copy-editor-draft-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-card-stroke-default);
  background-color: var(--winui-card-background-fill-default);
}

.floway-copy-editor-draft-item[data-exported="true"] {
  opacity: 0.72;
}

.floway-copy-editor-diff-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-radius: var(--winui-control-corner-radius);
  background-color: var(--winui-control-fill-tertiary);
  font-size: 12px;
  line-height: 17px;
}

.floway-copy-editor-diff-before {
  color: var(--winui-text-fill-secondary);
  text-decoration: line-through;
  word-break: break-word;
}

.floway-copy-editor-diff-after {
  color: var(--winui-text-fill-primary);
  word-break: break-word;
}

.floway-copy-editor-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-accent-tint-stroke);
  background-color: var(--winui-accent-tint-fill-default);
  color: var(--winui-text-fill-primary);
  font-size: 12px;
  line-height: 16px;
}

@media (forced-colors: active) {
  .floway-copy-editor-dock,
  .floway-copy-editor-surface,
  .floway-copy-editor-highlight-tag {
    border-width: 2px;
    box-shadow: none;
    backdrop-filter: none;
  }
}
`;
