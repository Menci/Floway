import type { IRInputToolChoice } from '../ir/input/types.ts';

type IRInputAllowedToolsMode = Extract<IRInputToolChoice, { type: 'allowed_tools' }>['mode'];

// Open-string wire modes narrow to the selection modes this IR represents.
export const isAllowedToolsMode = (mode: string): mode is IRInputAllowedToolsMode => mode === 'auto' || mode === 'required';
