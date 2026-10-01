
export interface RoleRewrite {
  readonly systemToDeveloper: boolean;
  readonly developerToSystem: boolean;
  readonly midConversationSystemToUser: boolean;
}

/** A flag is data on an upstream model, and this is a stage reading it. There is no
 *  category of stage a flag switches on or off. */
export const rolesFor = (flags: readonly string[]): RoleRewrite | null => {
  const rewrite: RoleRewrite = {
    systemToDeveloper: flags.includes('rewrite-system-to-developer'),
    developerToSystem: flags.includes('rewrite-developer-to-system'),
    midConversationSystemToUser: flags.includes('rewrite-mid-conv-system-to-user'),
  };
  return rewrite.systemToDeveloper || rewrite.developerToSystem || rewrite.midConversationSystemToUser
    ? rewrite
    : null;
};

/** The three rewrites in their settled order, and the state that makes "mid-conversation"
 *  mean what it says: the last step affects only a system message that appears after the
 *  leading run, which is why the fold carries a flag rather than testing the index.
 *
 *  Written once, over roles alone. A protocol walks its own items, hands in the role it read
 *  off one and takes back the role to write, so the ordering exists in one place however
 *  differently the two protocols that use it shape a turn. An item with no role at all —
 *  an OpenAI Responses reasoning item between two system messages — still crosses the leading run,
 *  which is what makes the system message after it mid-conversation. */
export const roleRewriter = (rewrite: RoleRewrite) => {
  let crossedLeadingSystemRun = false;
  return <Role extends string | undefined>(role: Role): Role | RewrittenRole => {
    let result: Role | RewrittenRole = role;
    if (rewrite.systemToDeveloper && result === 'system') result = 'developer';
    if (rewrite.developerToSystem && result === 'developer') result = 'system';
    if (!crossedLeadingSystemRun && result !== 'system') crossedLeadingSystemRun = true;
    if (rewrite.midConversationSystemToUser && crossedLeadingSystemRun && result === 'system') result = 'user';
    return result;
  };
};

/** The only roles the fold ever writes. Every protocol it runs on admits all three, so a
 *  rewritten role needs no cast to go back onto the item it came from. */
type RewrittenRole = 'system' | 'developer' | 'user';
