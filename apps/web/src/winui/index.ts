import { buttonCss } from './controls/button.css';
import { cardCss } from './controls/card.css';
import { choiceCss } from './controls/choice.css';
import { dialogCss } from './controls/dialog.css';
import { drawerCss } from './controls/drawer.css';
import { fieldCss } from './controls/field.css';
import { menuCss } from './controls/menu.css';
import { popoverCss } from './controls/popover.css';
import { selectCss } from './controls/select.css';
import { switchCss } from './controls/switch.css';
import { textInputCss } from './controls/text-input.css';
import { tooltipCss } from './controls/tooltip.css';
import { winuiTokenCss } from './tokens';

// The whole override layer as one stylesheet: the token vocabulary first, so a
// reader meets the `--winui-*` names before the rules that spend them, then the
// controls. Order beyond that carries no meaning — every rule doubles its
// subject's class, so none of them is resolved against another by document
// order. See ./tokens.ts for the selector convention every rule here follows.
// The document head is where this lands, next to the app's other critical
// stylesheets in ../root.tsx.
export const winuiCss = [
  winuiTokenCss,
  buttonCss,
  cardCss,
  choiceCss,
  dialogCss,
  drawerCss,
  fieldCss,
  menuCss,
  popoverCss,
  selectCss,
  switchCss,
  textInputCss,
  tooltipCss,
].join('\n');
