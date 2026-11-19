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
  color: var(--winui-text-fill-primary);
  font-family: var(--fontFamilyBase);
  font-size: 14px;
  line-height: 20px;
}

.floway-copy-editor-layer::backdrop {
  background: transparent;
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
  max-width: min(420px, calc(100vw - 24px));
  padding: 2px 8px;
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
  padding: 6px 8px;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
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
  box-shadow: 0 12px 32px var(--winui-tooltip-shadow-color);
  backdrop-filter: blur(28px) saturate(125%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.floway-copy-editor-flyout {
  width: min(460px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 24px));
}

.floway-copy-editor-panel {
  right: 16px;
  bottom: 64px;
  width: min(460px, calc(100vw - 32px));
  max-height: min(640px, calc(100vh - 96px));
}

.floway-copy-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  flex: none;
}

.floway-copy-editor-body {
  padding: 12px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1 1 auto;
}

.floway-copy-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--winui-divider-stroke-default);
  flex: none;
}

.floway-copy-editor-key-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 8px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-control-stroke-default);
  background-color: var(--winui-card-background-fill-default);
  color: var(--winui-text-fill-primary);
  font-family: var(--fontFamilyMonospace);
  font-size: 12px;
  line-height: 18px;
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

.floway-copy-editor-draft-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-card-stroke-default);
  background-color: var(--winui-card-background-fill-default);
}

.floway-copy-editor-draft-item[data-exported="true"] {
  opacity: 0.78;
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
