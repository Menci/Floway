import type { OllamaRecord } from './ollama-usage';

// The plans Ollama sells, keyed by the identifier its account endpoint reports.
// https://ollama.com/pricing
//
// The identifier is a plain word rather than an internal SKU, and the field is
// an unconstrained string, so one this table does not know is forwarded as it
// arrived.
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/api/types.go#L939-L949
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
};

export const planLabel = (record: OllamaRecord): string | null => {
  const plan = record.state?.account?.plan ?? null;
  return plan === null ? null : `Ollama ${PLAN_NAMES[plan] ?? plan}`;
};
