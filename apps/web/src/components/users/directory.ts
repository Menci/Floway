import type { ControlPlaneGroup, ControlPlaneUser, ControlPlaneUserDirectory } from '../../api/types';

export interface DirectoryMember {
  user: ControlPlaneUser;
  createdAt: string;
}

export type DirectoryGroupOption = Pick<ControlPlaneGroup, 'id' | 'name' | 'hue'> & { memberCount: number };

export interface UserDirectoryIndex {
  groupsByUser: ReadonlyMap<number, readonly ControlPlaneGroup[]>;
  membersByGroup: ReadonlyMap<number, readonly DirectoryMember[]>;
  groupOptions: readonly DirectoryGroupOption[];
}

export const indexUserDirectory = (directory: ControlPlaneUserDirectory): UserDirectoryIndex => {
  const users = new Map(directory.users.map(user => [user.id, user]));
  const groups = new Map(directory.groups.map(group => [group.id, group]));
  const groupsByUser = new Map(directory.users.map(user => [user.id, [] as ControlPlaneGroup[]]));
  const membersByGroup = new Map(directory.groups.map(group => [group.id, [] as DirectoryMember[]]));
  for (const membership of directory.memberships) {
    const user = users.get(membership.userId)!;
    const group = groups.get(membership.groupId)!;
    groupsByUser.get(user.id)!.push(group);
    membersByGroup.get(group.id)!.push({ user, createdAt: membership.createdAt });
  }
  return {
    groupsByUser,
    membersByGroup,
    groupOptions: directory.groups.map(group => ({ id: group.id, name: group.name, hue: group.hue, memberCount: membersByGroup.get(group.id)!.length })),
  };
};
