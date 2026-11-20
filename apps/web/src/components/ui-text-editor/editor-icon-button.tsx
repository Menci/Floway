import { createContext, useContext, type MouseEvent, type ReactElement } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, Tooltip } = fluentComponents;

// Shares the top-layer portal container inside UiTextEditorOverlay so every
// Tooltip and Popover rendered by the UI text editor mounts above native/Fluent
// dialogs without being obscured or dismissed.
export const UiTextEditorPortalContext = createContext<HTMLElement | null>(null);

export const useUiTextEditorPortal = (): HTMLElement | null => useContext(UiTextEditorPortalContext);

export function EditorIconButton({
  className,
  icon,
  label,
  onClick,
}: {
  className?: string;
  icon: ReactElement;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const mountNode = useUiTextEditorPortal();
  return (
    <Tooltip content={label} mountNode={mountNode} relationship="label">
      <Button
        appearance="subtle"
        aria-label={label}
        className={className}
        icon={icon}
        size="small"
        onClick={onClick}
      />
    </Tooltip>
  );
}
