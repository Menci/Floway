import { IdentityAvatar } from '../ui/identity-avatar';

// Identity pictures intentionally use Fluent Web's username-derived palette
// and typography rather than WinUI PersonPicture's neutral appearance.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-avatar/library/src/components/Avatar/useAvatar.tsx#L35-L39
export function UserAvatar({ username }: { username: string }) {
  return <IdentityAvatar aria-hidden color="colorful" idForColor={username} name={username} size={24} />;
}
