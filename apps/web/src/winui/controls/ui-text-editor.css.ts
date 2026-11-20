import { reducedMotion } from './selectors';

// WinUI 3 surfaces for the in-context UI text editor overlay, hosted inside a
// native manual top-layer popover that re-promotes when editor surfaces open.
export const uiTextEditorCss = `
.floway-ui-text-editor-layer {
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

.floway-ui-text-editor-layer::backdrop {
  background: transparent;
  pointer-events: none;
}

/* FluentProvider supplies theme CSS variables for all controls inside the top
   layer while staying visually transparent and click-through outside the
   editor surfaces themselves. */
.fui-FluentProvider.floway-ui-text-editor-provider {
  position: fixed;
  inset: 0;
  background-color: transparent;
  pointer-events: none;
}

.floway-ui-text-editor-portal-host {
  pointer-events: auto;
}

.floway-ui-text-editor-highlight {
  position: fixed;
  pointer-events: none;
  border-radius: var(--winui-control-corner-radius);
  border: 1.5px solid var(--winui-accent-fill-default);
  background-color: var(--winui-accent-tint-fill-default);
  opacity: 0.42;
  box-sizing: border-box;
}

.floway-ui-text-editor-highlight-tag {
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

.floway-ui-text-editor-dock {
  --floway-ute-edge-inset: 16px;
  position: fixed;
  right: var(--floway-ute-edge-inset);
  bottom: var(--floway-ute-edge-inset);
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
}

.floway-ui-text-editor-dock-divider {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background-color: var(--winui-divider-stroke-default);
  flex: none;
}

.floway-ui-text-editor-surface {
  position: fixed;
  pointer-events: auto;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 16px 40px var(--winui-tooltip-shadow-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.floway-ui-text-editor-flyout {
  width: min(460px, calc(100vw - 24px));
  max-height: min(640px, calc(100vh - 24px));
  overflow: visible;
}

.floway-ui-text-editor-panel {
  --floway-ute-edge-inset: 16px;
  --floway-ute-dock-clearance: calc(var(--floway-ute-edge-inset) + 40px + 6px);
  right: var(--floway-ute-edge-inset);
  bottom: var(--floway-ute-dock-clearance);
  width: min(460px, calc(100vw - 2 * var(--floway-ute-edge-inset)));
  max-height: min(480px, calc(100vh - var(--floway-ute-dock-clearance) - 34px));
}

.floway-ui-text-editor-header {
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

.floway-ui-text-editor-header[data-draggable="true"] {
  cursor: grab;
  user-select: none;
}

.floway-ui-text-editor-header[data-draggable="true"]:active {
  cursor: grabbing;
}

.floway-ui-text-editor-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.floway-ui-text-editor-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.floway-ui-text-editor-header-back {
  margin-inline-start: -6px;
}

.floway-ui-text-editor-header-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 0 1 auto;
}

.floway-ui-text-editor-flyout-header {
  position: relative;
}

.floway-ui-text-editor-header-key-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  margin-inline-start: -6px;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--winui-control-corner-radius);
  background: transparent;
  color: var(--winui-text-fill-primary);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--winui-control-faster-animation-duration) linear;
}

.floway-ui-text-editor-header-key-trigger:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-ui-text-editor-header-key-trigger:active,
.floway-ui-text-editor-header-key-trigger[data-open="true"] {
  background-color: var(--winui-subtle-fill-tertiary);
}

.floway-ui-text-editor-header-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase300) - 1px);
  line-height: var(--lineHeightBase300);
  font-weight: 500;
  color: var(--winui-text-fill-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  min-width: 0;
}

.floway-ui-text-editor-header-key-chevron {
  flex: none;
  color: var(--winui-text-fill-secondary);
  transition: transform var(--winui-chevron-turn-duration) var(--winui-chevron-turn-easing);
}

.floway-ui-text-editor-header-key-chevron[data-open="true"] {
  transform: rotate(180deg);
}

.floway-ui-text-editor-key-listbox {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  right: 8px;
  z-index: 20;
  max-height: min(280px, 50vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: var(--winui-overlay-corner-radius);
  border: 1px solid var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  box-shadow: 0 8px 24px var(--winui-tooltip-shadow-color);
}

.floway-ui-text-editor-key-option {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}

.floway-ui-text-editor-key-option[data-highlighted="true"]:not([aria-selected="true"]) {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-ui-text-editor-key-option-value {
  width: 100%;
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
  color: var(--winui-text-fill-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.floway-ui-text-editor-key-option-key {
  width: 100%;
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase200) - 1px);
  line-height: 16px;
  color: var(--winui-text-fill-secondary);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.floway-ui-text-editor-body {
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  flex: 1 1 auto;
}

.floway-ui-text-editor-body--list {
  padding: 0;
  gap: 0;
}

.floway-ui-text-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--winui-divider-stroke-default);
  border-bottom-left-radius: var(--winui-overlay-corner-radius);
  border-bottom-right-radius: var(--winui-overlay-corner-radius);
  background-color: var(--winui-layer-fill-default);
  flex: none;
}

.floway-ui-text-editor-footer-start {
  display: flex;
  align-items: center;
  gap: 4px;
}

.floway-ui-text-editor-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.floway-ui-text-editor-field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.floway-ui-text-editor-field-header .fui-Label {
  padding: 0;
  line-height: 20px;
}

.floway-ui-text-editor-field-header .fui-Button {
  margin-inline-end: -4px;
}


.floway-ui-text-editor-meta {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-secondary);
  word-break: break-word;
}

.floway-ui-text-editor-stale-trigger {
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

.floway-ui-text-editor-stale-trigger:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-ui-text-editor-applied-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--winui-system-fill-success);
  flex: none;
  vertical-align: middle;
}

.floway-ui-text-editor-missing-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--winui-system-fill-critical);
  flex: none;
  vertical-align: middle;
}

.floway-ui-text-editor-stale-popover {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(320px, calc(100vw - 32px));
}

.floway-ui-text-editor-stale-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 17px;
}

.floway-ui-text-editor-empty {
  padding: 28px 16px;
  font-size: 13px;
  line-height: 18px;
  color: var(--winui-text-fill-secondary);
  text-align: center;
}

.floway-ui-text-editor-notice-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
  font-size: 12px;
  line-height: 16px;
  flex: none;
}

.floway-ui-text-editor-notice-bar[data-tone="error"] {
  background-color: var(--winui-system-fill-critical-background);
  color: var(--winui-system-fill-critical);
}

.floway-ui-text-editor-notice-bar[data-tone="success"] {
  background-color: var(--winui-system-fill-success-background);
  color: var(--winui-system-fill-success);
}

.floway-ui-text-editor-entry-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 10px 12px 16px;
  border-bottom: 1px solid var(--winui-divider-stroke-default);
}

.floway-ui-text-editor-entry-item:last-child {
  border-bottom: 0;
}

.floway-ui-text-editor-interactive-item {
  cursor: pointer;
  transition: background-color 80ms ease;
}

.floway-ui-text-editor-interactive-item:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.floway-ui-text-editor-interactive-item:active {
  background-color: var(--winui-subtle-fill-tertiary);
}

.floway-ui-text-editor-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.floway-ui-text-editor-entry-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.floway-ui-text-editor-entry-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase300) - 1px);
  line-height: var(--lineHeightBase300);
  color: var(--winui-text-fill-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.floway-ui-text-editor-entry-key[data-missing="true"] {
  color: var(--winui-text-fill-secondary);
  text-decoration: line-through;
}

.floway-ui-text-editor-session-time {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--winui-text-fill-primary);
}

.floway-ui-text-editor-session-lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: 6px;
}

.floway-ui-text-editor-session-line {
  font-size: 12px;
  line-height: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.floway-ui-text-editor-session-preview-part {
  display: inline;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--winui-text-fill-primary);
  font-weight: 400;
  border-radius: 3px;
  cursor: copy;
  transition: color var(--winui-control-faster-animation-duration) linear;
}

.floway-ui-text-editor-session-preview-part:hover {
  color: var(--winui-accent-text-fill-primary);
}

.floway-ui-text-editor-session-preview-part[data-copied="true"] {
  color: var(--winui-accent-text-fill-primary);
}

.floway-ui-text-editor-session-preview-sep {
  color: var(--winui-text-fill-tertiary);
  user-select: none;
  pointer-events: none;
}

.floway-ui-text-editor-session-key {
  font-family: var(--fontFamilyMonospace);
  font-size: calc(var(--fontSizeBase200) - 1px);
  color: var(--winui-text-fill-tertiary);
  margin-inline-start: 8px;
}

.floway-ui-text-editor-session-key[data-leading="true"] {
  margin-inline-start: 0;
  color: var(--winui-text-fill-secondary);
}

.floway-ui-text-editor-session-more {
  font-size: 12px;
  line-height: 16px;
  color: var(--winui-text-fill-tertiary);
  margin-top: 1px;
}

.floway-ui-text-editor-diff-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding-right: 6px;
}

.floway-ui-text-editor-diff-row {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  font-size: 12px;
  line-height: 17px;
}

.floway-ui-text-editor-diff-lang {
  font-size: 12px;
  line-height: 17px;
  color: var(--winui-text-fill-tertiary);
  flex: none;
}

.floway-ui-text-editor-diff-values {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.floway-ui-text-editor-diff-before-line {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
}

.floway-ui-text-editor-diff-before {
  color: var(--winui-text-fill-secondary);
  text-decoration: line-through;
  word-break: break-word;
}

.floway-ui-text-editor-diff-after {
  color: var(--winui-text-fill-primary);
  word-break: break-word;
}

@media (forced-colors: active) {
  .floway-ui-text-editor-dock,
  .floway-ui-text-editor-surface,
  .floway-ui-text-editor-key-listbox,
  .floway-ui-text-editor-highlight-tag {
    border-width: 2px;
    box-shadow: none;
  }
}

${reducedMotion(['.floway-ui-text-editor-header-key-chevron'], 'transition-duration')}
`;
