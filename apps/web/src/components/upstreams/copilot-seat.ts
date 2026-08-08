// The seat's plan, named as GitHub names it. The SKU is what the token exchange
// carries, so this is the reading that stays fresh on its own; the same fact
// reaches `copilot_internal/user` as `copilot_plan`, which only the operator's
// refresh ever calls.
//
// The identifiers are matched but never treated as a closed set: Microsoft
// types its own as `WellKnownSku | string`, and an unrecognised SKU is left to
// the caller rather than guessed at.
// https://github.com/microsoft/vscode/blob/5fb9376dbdc8b0f1bdc9eb8186f429e023503f92/extensions/copilot/src/platform/authentication/common/copilotToken.ts#L330-L376
// https://github.com/microsoft/vscode/blob/5fb9376dbdc8b0f1bdc9eb8186f429e023503f92/src/vs/workbench/services/chat/common/chatEntitlementService.ts#L1013-L1031
// https://github.com/github/CopilotForXcode/blob/2ba57a272719ad72f2bb44667133d759812949c1/Tool/Sources/Status/Types/GitHubCopilotQuotaInfo.swift#L77-L82
//
// The plan names are the seven GitHub sells today.
// https://github.com/github/docs/blob/60321755e16a2252417e95479ac5faaf854c660a/data/variables/copilot.yml
import type { CopilotRecord } from './copilot-quota';

const PLAN_NAMES: Record<string, string> = {
  free_limited_copilot: 'Free',
  free_educational_quota: 'Student',
  monthly_subscriber_quota: 'Pro',
  trial_30_monthly_subscriber_quota: 'Pro',
  plus_monthly_subscriber_quota: 'Pro+',
  max_monthly_subscriber_quota: 'Max',
  copilot_standalone_seat_quota: 'Business',
  copilot_for_business_seat_quota: 'Business',
  copilot_enterprise_seat_quota: 'Enterprise',
};

// A SKU this table does not know names no plan: unlike a ChatGPT plan type,
// these are internal identifiers and none of them reads as a product name, so
// the row falls back to naming the provider.
export const planLabel = (record: CopilotRecord): string | null => {
  const sku = record.state?.copilotToken?.sku ?? null;
  if (sku === null) return null;
  const plan = PLAN_NAMES[sku];
  return plan === undefined ? null : `Copilot ${plan}`;
};
