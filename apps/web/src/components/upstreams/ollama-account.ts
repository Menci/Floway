import type { OllamaRecord } from './ollama-usage';

// Ollama's own plan identifiers, which are plain words rather than internal
// SKUs, so one this table does not know is forwarded as it arrived.
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/api/client.go#L506
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
};

export const planLabel = (record: OllamaRecord): string | null => {
  const plan = record.state?.account?.plan ?? null;
  return plan === null ? null : `Ollama ${PLAN_NAMES[plan] ?? plan}`;
};
