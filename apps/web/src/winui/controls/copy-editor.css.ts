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

.floway-copy-editor-portal-host {
  pointer-events: auto;
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
  font-size: calc(var(--fontSizeBase200) - 1px);
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
  gap: 4px;
  padding: 4px;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 8px 24px var(--winui-tooltip-shadow-color);
  backdrop-filter: blur(24px) saturate(125%);
}

.floway-copy-editor-dock-divider {
  width: 1px;
  height: 16px;
  margin: 0 2px;
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
  width: min(460px, calc(100vw - 24px));
  max-height: min(640px, calc(100vh - 24px));
}

.floway-copy-editor-panel {
  right: 16px;
  bottom: 62px;
  width: min(460px, calc(100vw - 32px));
  max-height: min(480px, calc(100vh - 96px));
}

.floway-copy-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  flex: none;
  min-height: 44px;
  box-sizing: border-box;
}

.floway-copy-editor-header[data-draggable="true"] {
  cursor: grab;
  user-select: none;
}

.floway-copy-editor-header[data-draggable="true"]:active {
  cursor: grabbing;
}

.floway-copy-editor-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.floway-copy-editor-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.floway-copy-editor-header-back {
  margin-inline-start: -6px;
}

.floway-copy-editor-header-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 0 1 auto;
}

.floway-copy-editor-header-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase300) - 1px);
  line-height: var(--lineHeightBase300);
  font-weight: 500;
  color: var(--winui-text-fill-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.floway-copy-editor-body {
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  flex: 1 1 auto;
}

.floway-copy-editor-body--list {
  padding: 0;
  gap: 0;
}

.floway-copy-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--winui-divider-stroke-default);
  background-color: var(--winui-layer-fill-default);
  flex: none;
}

.floway-copy-editor-footer-start {
  display: flex;
  align-items: center;
  gap: 4px;
}

.floway-copy-editor-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.floway-copy-editor-field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.floway-copy-editor-field-header .fui-Label {
  padding: 0;
  line-height: 20px;
}

.floway-copy-editor-field-header .fui-Button {
  margin-inline-end: -4px;
}

.floway-copy-editor-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.floway-copy-editor-candidate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: var(--winui-control-corner-radius);
  border: 1px solid var(--winui-control-stroke-default);
  background-color: var(--winui-control-fill-default);
  color: var(--winui-text-fill-primary);
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase200) - 1px);
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

.floway-copy-editor-candidate-attr {
  color: var(--winui-text-fill-secondary);
}

.floway-copy-editor-meta {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-secondary);
  word-break: break-word;
}

.floway-copy-editor-stale-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--winui-control-corner-radius);
  background: transparent;
  color: var(--winui-system-fill-caution);
  cursor: pointer;
  flex: none;
  vertical-align: middle;
}

.floway-copy-editor-stale-trigger:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-copy-editor-applied-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--winui-system-fill-success);
  flex: none;
  vertical-align: middle;
}

.floway-copy-editor-missing-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--winui-system-fill-critical);
  flex: none;
  vertical-align: middle;
}

.floway-copy-editor-stale-popover {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(320px, calc(100vw - 32px));
}

.floway-copy-editor-stale-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 17px;
}

.floway-copy-editor-empty {
  padding: 28px 16px;
  font-size: 13px;
  line-height: 18px;
  color: var(--winui-text-fill-secondary);
  text-align: center;
}

.floway-copy-editor-notice-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  font-size: 12px;
  line-height: 16px;
  flex: none;
}

.floway-copy-editor-notice-bar[data-tone="error"] {
  background-color: var(--winui-system-fill-critical-background);
  color: var(--winui-system-fill-critical);
}

.floway-copy-editor-notice-bar[data-tone="success"] {
  background-color: var(--winui-system-fill-success-background);
  color: var(--winui-system-fill-success);
}

.floway-copy-editor-draft-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 10px 12px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
}

.floway-copy-editor-draft-item:last-child {
  border-bottom: 0;
}

.floway-copy-editor-interactive-item {
  cursor: pointer;
  transition: background-color 80ms ease;
}

.floway-copy-editor-interactive-item:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-copy-editor-interactive-item:active {
  background-color: var(--winui-subtle-fill-tertiary);
}

.floway-copy-editor-draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.floway-copy-editor-draft-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.floway-copy-editor-draft-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase300) - 1px);
  line-height: var(--lineHeightBase300);
  color: var(--winui-text-fill-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.floway-copy-editor-draft-key[data-missing="true"] {
  color: var(--winui-text-fill-secondary);
  text-decoration: line-through;
}

.floway-copy-editor-batch-time {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--winui-text-fill-primary);
}

.floway-copy-editor-batch-lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: 6px;
}

.floway-copy-editor-batch-line {
  font-size: 12px;
  line-height: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.floway-copy-editor-batch-preview-part {
  color: var(--winui-text-fill-primary);
  font-weight: 400;
  border-radius: 3px;
  cursor: copy;
  transition: color 80ms ease;
}

.floway-copy-editor-batch-preview-part:hover {
  color: var(--winui-accent-text-fill-primary);
}

.floway-copy-editor-batch-preview-part[data-copied="true"] {
  color: var(--winui-accent-text-fill-primary);
}

.floway-copy-editor-batch-preview-sep {
  color: var(--winui-text-fill-tertiary);
  user-select: none;
  pointer-events: none;
}

.floway-copy-editor-batch-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase200) - 1px);
  color: var(--winui-text-fill-tertiary);
  margin-inline-start: 8px;
}

.floway-copy-editor-batch-key[data-leading="true"] {
  margin-inline-start: 0;
  color: var(--winui-text-fill-secondary);
}

.floway-copy-editor-batch-more {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-tertiary);
  margin-top: 1px;
}

.floway-copy-editor-diff-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding-right: 6px;
}

.floway-copy-editor-diff-row {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  font-size: 12px;
  line-height: 17px;
}

.floway-copy-editor-diff-lang {
  font-size: 12px;
  line-height: 17px;
  color: var(--winui-text-fill-tertiary);
  flex: none;
}

.floway-copy-editor-diff-values {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.floway-copy-editor-diff-before-line {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
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
