export interface WireUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  createdAt: string;
}
