import flowayLogoUrl from '../assets/floway-blue.svg?no-inline';
import { useTranslation } from '../i18n/translation';
import { useSiteSettingsStore } from '../stores/site-settings-store';

export function FlowayLogo() {
  const { t } = useTranslation();
  const siteName = useSiteSettingsStore(state => state.siteName);

  return (
    // The wordmark takes the primary text fill in both themes, as its WinUI
    // counterpart the navigation pane title does.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L198
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
    <div className="inline-flex items-center min-w-0 gap-2.5 text-fui-fg1">
      <img alt="" aria-hidden="true" className="block h-11 w-11 shrink-0 ml-[-1.5px]" src={flowayLogoUrl} />
      {/* The pane title is NoWrap in WinUI, and this one sits in a pane whose
          width is capped, so an operator-supplied name longer than the pane is
          clipped rather than wrapped onto a second line.
          https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L1081-L1086 */}
      <span
        className="min-w-0 truncate font-fui-semibold text-fui-base500 leading-[var(--lineHeightBase500)]"
      >
        {siteName ?? t('app.title')}
      </span>
    </div>
  );
}
