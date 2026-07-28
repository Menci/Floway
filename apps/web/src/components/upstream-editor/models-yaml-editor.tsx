import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { configureMonacoYaml } from 'monaco-yaml';
import YamlWorker from 'monaco-yaml/yaml.worker.js?worker';

type MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

(globalThis as typeof globalThis & { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker: (_moduleId, label) => label === 'yaml' ? new YamlWorker() : new EditorWorker(),
};

loader.config({ monaco });
configureMonacoYaml(monaco, {
  completion: true,
  enableSchemaRequest: false,
  format: { enable: true, printWidth: 120 },
  hover: true,
  validate: true,
  yamlVersion: '1.2',
});

export default function ModelsYamlEditor({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  return <Editor
    height="100%"
    language="yaml"
    path="models.yaml"
    options={{
      automaticLayout: true,
      fontFamily: 'Cascadia Code, monospace',
      fontSize: 14,
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: false },
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      tabSize: 2,
    }}
    theme={window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'light'}
    value={value}
    onChange={next => onChange(next ?? '')}
  />;
}
