import { createContext, useContext, type MouseEvent, type ReactElement } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, Tooltip } = fluentComponents;

// Shares the top-layer portal container inside CopyEditorOverlay so every
// Tooltip and Popover rendered by the copy editor mounts above native/Fluent
// dialogs without being obscured or dismissed.
export const CopyEditorPortalContext = createContext<HTMLElement | null>(null);

export const useCopyEditorPortal = (): HTMLElement | null => useContext(CopyEditorPortalContext);

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
  const mountNode = useCopyEditorPortal();
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
