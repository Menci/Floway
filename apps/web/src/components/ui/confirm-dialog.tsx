import { useTranslation } from 'react-i18next';

import { DialogShell } from './dialog-shell';
import { OutcomeMessageBar } from './outcome-message-bar';
import { fluentComponents } from '../../fluent';

const { Button, DialogActions, DialogTitle, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // A destructive confirmation is an accent button wearing the danger hue.
  // WinUI has no danger button, so the three fills are Fluent's own danger
  // ramp -- Background3 and its hover and pressed shades, one #c50f1f family
  // in both themes because the status ramp reads the same shared colour either
  // way.
  //
  // The label has to be the foreground for a surface that does not follow the
  // theme. That is StaticInverted, white in both.
  //
  // Not OnBrand, which is the trap here: OnBrand is white in both themes in
  // stock Fluent, but ../../winui/theme.ts re-points it at WinUI's
  // TextOnAccentFillColorPrimary, and that token is keyed to the accent's own
  // lightness -- white in light, black in dark, because WinUI's dark accent is
  // the lighter blue. On a fill that stays dark red, the dark half of that
  // reads black on red, 3.46:1 at rest and 2.36 pressed.
  //
  // Not DangerForegroundInverted either: that is the danger hue for use ON an
  // inverted surface, not the label to place on a danger fill; over
  // DangerBackground3 it reads at 1.74:1 in light and 1.17:1 in dark.
  //
  // Every rule is qualified to the enabled states, and pressed is `:active`
  // alone because WinUI enters Pressed on a keyboard invoke as well as under
  // the pointer. The `!important` that lets these outrank the WinUI layer's
  // accent fill would otherwise also outrank the disabled painting, and a
  // disabled accent button in WinUI abandons the accent for
  // AccentFillColorDisabled under TextOnAccentFillColorDisabled -- which the
  // layer paints for this button already, and which is the whole signal that
  // the confirmation is in flight.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L106-L110
  //
  // Colour is confined to `@media not (forced-colors: active)`. WinUI answers
  // Windows High Contrast by mapping the whole AccentButton brush set onto
  // system brushes, so intent stops being expressible there; forced colours
  // keeps Fluent's drawing, which paints this button from Highlight and
  // HighlightText like any other primary one.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L53-L65
  danger: {
    '@media not (forced-colors: active)': {
      '&:not(:disabled):not([aria-disabled="true"])': {
        backgroundColor: 'var(--colorStatusDangerBackground3) !important',
        color: 'var(--colorNeutralForegroundStaticInverted) !important',
      },
      '&:not(:disabled):not([aria-disabled="true"]):hover': {
        backgroundColor: 'var(--colorStatusDangerBackground3Hover) !important',
      },
      '&:not(:disabled):not([aria-disabled="true"]):active': {
        backgroundColor: 'var(--colorStatusDangerBackground3Pressed) !important',
      },
    },
  },
});

export function ConfirmDialog({
  actionIntent = 'danger',
  actionLabel,
  busy = false,
  cancelLabel,
  error,
  message,
  onCancel,
  onConfirm,
  onDismissError,
  onExited,
  onOpenChange,
  open,
  title,
}: {
  actionIntent?: 'danger' | 'primary';
  actionLabel: string;
  busy?: boolean;
  cancelLabel?: string;
  /**
   * A failed attempt at the action, reported here rather than behind the
   * dialog. Without it the caller has nowhere to put the failure while the
   * dialog is still open, and a page-level report sits under the very dialog
   * the operator is looking at.
   */
  error?: string | null;
  message: string;
  onCancel?: () => void;
  onConfirm: () => void;
  onDismissError?: () => void;
  /** See DialogShell: the deed a confirmation does to its own tree goes here. */
  onExited?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  const styles = useStyles();

  return (
    <DialogShell
      open={open}
      onExited={onExited}
      actions={<DialogActions>
        <Button
          className="!whitespace-nowrap"
          disabled={busy}
          onClick={() => {
            if (onCancel) onCancel();
            else onOpenChange(false);
          }}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button
          appearance="primary"
          className={mergeClasses('!whitespace-nowrap', actionIntent === 'danger' && styles.danger)}
          disabledFocusable={busy}
          onClick={onConfirm}
        >
          {actionLabel}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => !busy && onOpenChange(data.open)}
      surfaceClassName="!w-[min(430px,calc(100vw-48px))]"
      title={<DialogTitle>{title}</DialogTitle>}
    >
      <div className="grid gap-3 min-w-0">
        <span>{message}</span>
        {error && <OutcomeMessageBar onDismiss={onDismissError}>{error}</OutcomeMessageBar>}
      </div>
    </DialogShell>
  );
}
