import { UserAvatar } from './avatar';
import { TruncationTooltip } from '../ui/truncation-tooltip';

export function UserIdentity({ username }: { username: string }) {
  return <span className="floway-identity">
    <UserAvatar username={username} />
    <TruncationTooltip content={username} relationship="label">{ref => <span className="floway-identity-name truncate" ref={ref}>{username}</span>}</TruncationTooltip>
  </span>;
}
