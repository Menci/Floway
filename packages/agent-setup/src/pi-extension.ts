import jsesc from 'jsesc';

import { normalizeAgentSetupEndpoint } from './extension-endpoint.ts';
import { SETUP_NODE_PI_EXTENSION } from './script-assets.generated.ts';

export const renderPiExtension = ({ provider, endpoint, apiKey }: { provider: string; endpoint: string; apiKey: string }): string => {
  const connections = jsesc([{ provider, endpoint: normalizeAgentSetupEndpoint(endpoint), apiKey }], { json: true, isScriptContext: true });
  return `// Managed by Floway Agent Setup.\nconst connections = ${connections};\n${SETUP_NODE_PI_EXTENSION}`;
};
