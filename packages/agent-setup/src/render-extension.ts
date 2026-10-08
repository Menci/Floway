import jsesc from 'jsesc';

import { normalizeAgentSetupEndpoint } from './extension-endpoint.ts';
import { SETUP_NODE_OMP_EXTENSION, SETUP_NODE_PI_EXTENSION } from './script-assets.generated.ts';

export const renderAgentExtension = ({ agent, provider, endpoint, apiKey }: { agent: 'pi' | 'omp'; provider: string; endpoint: string; apiKey: string }): string => {
  const connections = jsesc([{ provider, endpoint: normalizeAgentSetupEndpoint(endpoint), apiKey }], { json: true, isScriptContext: true });
  const source = agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION;
  return `// Managed by Floway Agent Setup.\nconst connections = ${connections};\n${source}`;
};
