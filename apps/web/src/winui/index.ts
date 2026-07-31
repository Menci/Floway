import { accordionCss } from './controls/accordion.css';
import { badgeTagCss } from './controls/badge-tag.css';
import { buttonCss } from './controls/button.css';
import { cardCss } from './controls/card.css';
import { choiceCss } from './controls/choice.css';
import { colorPickerCss } from './controls/color-picker.css';
import { dialogCss } from './controls/dialog.css';
import { drawerCss } from './controls/drawer.css';
import { fieldCss } from './controls/field.css';
import { listCss } from './controls/list.css';
import { menuCss } from './controls/menu.css';
import { messageBarCss } from './controls/message-bar.css';
import { navCss } from './controls/nav.css';
import { popoverCss } from './controls/popover.css';
import { progressCss } from './controls/progress.css';
import { scrollbarCss } from './controls/scrollbar.css';
import { selectCss } from './controls/select.css';
import { switchCss } from './controls/switch.css';
import { tableCss } from './controls/table.css';
import { tabsCss } from './controls/tabs.css';
import { textInputCss } from './controls/text-input.css';
import { textCss } from './controls/text.css';
import { toastCss } from './controls/toast.css';
import { toolbarCss } from './controls/toolbar.css';
import { tooltipCss } from './controls/tooltip.css';
import { winuiResetCss } from './reset.css';
import { winuiTokenCss } from './tokens';

// The whole override layer as one stylesheet: the box-model reset first, then
// the token vocabulary, so a reader meets the `--winui-*` names before the
// rules that spend them, then the controls. Order beyond that carries no meaning — every rule doubles its
// subject's class, so none of them is resolved against another by document
// order. See ./tokens.ts for the selector convention every rule here follows.
// The document head is where this lands, next to the app's other critical
// stylesheets in ../root.tsx.
export const winuiCss = [
  winuiResetCss,
  winuiTokenCss,
  accordionCss,
  badgeTagCss,
  buttonCss,
  cardCss,
  choiceCss,
  colorPickerCss,
  dialogCss,
  drawerCss,
  fieldCss,
  listCss,
  menuCss,
  messageBarCss,
  navCss,
  popoverCss,
  progressCss,
  scrollbarCss,
  selectCss,
  switchCss,
  tableCss,
  tabsCss,
  textInputCss,
  textCss,
  toastCss,
  toolbarCss,
  tooltipCss,
].join('\n');
