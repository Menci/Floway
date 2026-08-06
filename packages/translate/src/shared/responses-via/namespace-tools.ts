import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ResponsesTool } from '@floway-dev/protocols/responses';

export interface FlattenedNamespaceFunction {
  targetName: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface NamespaceToolNames {
  sourceToTarget: Map<string, string>;
  targetToSource: Map<string, { namespace: string; name: string }>;
}

const targetNameOf = (namespace: string, tool: string): string =>
  `${namespace}_${tool}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');

const uniqueToolName = (preferred: string, reserved: Set<string>): string => {
  if (!reserved.has(preferred)) {
    reserved.add(preferred);
    return preferred;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${preferred}_${suffix}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
};

export const flattenNamespaceFunctions = (
  tools: readonly ResponsesTool[] | null | undefined,
  target: string,
): { functions: FlattenedNamespaceFunction[]; names: NamespaceToolNames } => {
  const functions: FlattenedNamespaceFunction[] = [];
  const names: NamespaceToolNames = {
    sourceToTarget: new Map(),
    targetToSource: new Map(),
  };
  const reservedNames = new Set(
    (tools ?? []).flatMap(tool =>
      (tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string'
        ? [tool.name]
        : []),
  );

  for (const tool of tools ?? []) {
    if (tool.type !== 'namespace') continue;
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) {
      throw new TranslatorInputError(`Cannot translate a namespace tool without a string name and tools array to ${target}.`);
    }
    for (const child of tool.tools) {
      if (child === null || typeof child !== 'object' || (child as { type?: unknown }).type !== 'function') {
        throw new TranslatorInputError(`Cannot translate non-function child in namespace '${tool.name}' to ${target}.`);
      }
      const functionTool = child as {
        name?: unknown;
        description?: unknown;
        parameters?: unknown;
        strict?: unknown;
      };
      if (typeof functionTool.name !== 'string'
        || functionTool.parameters === null
        || typeof functionTool.parameters !== 'object'
        || Array.isArray(functionTool.parameters)) {
        throw new TranslatorInputError(`Cannot translate malformed function child in namespace '${tool.name}' to ${target}.`);
      }
      const sourceName = `${tool.name}.${functionTool.name}`;
      const targetName = uniqueToolName(targetNameOf(tool.name, functionTool.name), reservedNames);
      const source = { namespace: tool.name, name: functionTool.name };
      names.sourceToTarget.set(sourceName, targetName);
      names.targetToSource.set(targetName, source);
      functions.push({
        targetName,
        ...(typeof functionTool.description === 'string' ? { description: functionTool.description } : {}),
        parameters: functionTool.parameters as Record<string, unknown>,
        ...(typeof functionTool.strict === 'boolean' ? { strict: functionTool.strict } : {}),
      });
    }
  }

  return { functions, names };
};
