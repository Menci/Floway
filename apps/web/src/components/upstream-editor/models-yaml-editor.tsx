import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { configureMonacoYaml } from 'monaco-yaml';
import { useEffect, useRef } from 'react';

import YamlWorker from './models-yaml.worker.ts?worker';

type MonacoEnvironment = {
  getWorker: (moduleId: string, label: string) => Worker;
};

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

const modelUri = monaco.Uri.parse('inmemory://floway/models.yaml');

export default function ModelsYamlEditor({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    monaco.editor.getModel(modelUri)?.dispose();
    const model = monaco.editor.createModel(initialValueRef.current, 'yaml', modelUri);
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontFamily: 'Cascadia Code, monospace',
      fontSize: 14,
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: false },
      model,
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs',
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
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  return <div className="h-full min-h-0 min-w-0 w-full" ref={containerRef} />;
}
