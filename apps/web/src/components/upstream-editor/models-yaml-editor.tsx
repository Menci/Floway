import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { configureMonacoYaml } from 'monaco-yaml';
import { useEffect, useRef } from 'react';

import YamlWorker from './models-yaml.worker.ts?worker';
import { monospaceStack } from '../../font-stacks';
import { DARK_SCHEME_QUERY, useMediaQuery } from '../../lib/use-media-query';

interface MonacoEnvironment {
  getWorker: (moduleId: string, label: string) => Worker;
}

(globalThis as typeof globalThis & { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker: (moduleId, label) => label === 'yaml' || moduleId.includes('monaco-yaml') ? new YamlWorker() : new EditorWorker(),
};

configureMonacoYaml(monaco, {
  completion: true,
  enableSchemaRequest: false,
  format: { enable: true, printWidth: 120 },
  hover: true,
  validate: true,
  yamlVersion: '1.2',
});

// Monaco keys its models by URI in one process-wide registry, so each mount
// takes a name of its own and two editors can never contend for one buffer.
let modelSerial = 0;

// Monaco's built-in themes, picked off the one query the rest of the app's
// scheme follows.
const monacoTheme = (dark: boolean) => dark ? 'vs-dark' : 'vs';

export default function ModelsYamlEditor({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const dark = useMediaQuery(DARK_SCHEME_QUERY);
  const initialDarkRef = useRef(dark);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const model = monaco.editor.createModel(
      initialValueRef.current,
      'yaml',
      monaco.Uri.parse(`inmemory://floway/models-${modelSerial++}.yaml`),
    );
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontFamily: monospaceStack,
      fontSize: 13,
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: false },
      model,
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      theme: monacoTheme(initialDarkRef.current),
    });
    editorRef.current = editor;
    const subscription = model.onDidChangeContent(() => onChangeRef.current(model.getValue()));
    return () => {
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ theme: monacoTheme(dark) });
  }, [dark]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  return <div className="h-full min-h-0 min-w-0 w-full" ref={containerRef} />;
}
