// The layout vocabulary shared across forms and stacked text. Each value here
// is one number that used to be several, and each is written down once so a
// new call site copies the token rather than a neighbour's spelling.

// A title over its description. WinUI states this gap as `0`
// (https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L409-L450),
// but only under `BaseTextBlockStyle`'s `LineStackingStrategy="MaxHeight"` and
// `TextLineBounds="Full"`, where every line carries its own full leading. Our
// CSS `line-height` is tight, so a literal `0` collapses the pair. The 4px is
// ours, and stands in for the leading that metric would have supplied.
export const TIGHT_STACK_CLASS = 'grid gap-1';

// The width at which a two-column form falls to one column. WinUI declares no
// adaptive triggers for form columns at all — there is no `AdaptiveTrigger` and
// no `MinWindowWidth` key anywhere in microsoft-ui-xaml's `controls/dev/`, and
// the Gallery's own `Breakpoint640Plus = 641` is that app's choice rather than
// a spec. So this number is ours, and it is 680 because that is where
// `--floway-page-inset` and `--floway-panel-inset` already step down: a form's
// columns collapse at the same moment the space around them narrows.
export const TWO_COLUMN_FORM_CLASS = 'grid grid-cols-2 max-[680px]:grid-cols-1';
