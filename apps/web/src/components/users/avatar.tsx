import { fluentComponents } from '../../fluent';
import { hueBadgeTone, hueFromString } from '../../lib/hue';
import { useBadgeHue } from '../ui/badge-hue';

const { Avatar } = fluentComponents;

// Identity hues customize PersonPicture's neutral fill while retaining its
// geometry and initials sizing.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/PersonPicture/PersonPicture.xaml#L65-L66
export function UserAvatar({ username }: { username: string }) {
  const hue = useBadgeHue(hueBadgeTone(hueFromString(username)));
  return <Avatar aria-hidden color="colorful" initials={hue} name={username} size={24} />;
}
