import type { CopilotRecord } from './copilot-quota';

// The seat's plan, named as GitHub names it, assembled the way VS Code
// assembles it: the SKU is matched first, because a free or education seat is
// discriminated by its SKU rather than by a plan of its own, and everything
// else is named from `copilot_plan`.
// https://github.com/microsoft/vscode/blob/b285c0292b56772e2784d014ac1dbcf809c58a17/src/vs/workbench/services/chat/common/chatEntitlementService.ts#L1013-L1030
//
// The names are the ones GitHub sells under.
// https://github.com/github/docs/blob/60321755e16a2252417e95479ac5faaf854c660a/data/variables/copilot.yml#L7-L20
//
// Both namespaces are open strings, so a value neither table knows names no
// plan and the row falls back to the provider rather than to a guess.
const SKU_PLAN_NAMES: Record<string, string> = {
  free_limited_copilot: 'Free',
  free_educational_quota: 'Student',
};

const PLAN_NAMES: Record<string, string> = {
  individual_edu: 'Student',
  individual: 'Pro',
  individual_pro: 'Pro+',
  individual_max: 'Max',
  business: 'Business',
  enterprise: 'Enterprise',
};

export const planLabel = (record: CopilotRecord): string | null => {
  const seat = record.state?.seat?.data ?? null;
  if (seat === null) return null;
  const name = (seat.sku === null ? undefined : SKU_PLAN_NAMES[seat.sku])
    ?? (seat.plan === null ? undefined : PLAN_NAMES[seat.plan]);
  return name === undefined ? null : `Copilot ${name}`;
};
