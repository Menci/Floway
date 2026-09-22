import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { useEffect, useRef } from 'react';

import { Checkbox } from './fluent-form-controls';
import { PANEL_BAND_CLASS } from './panel';
import { fluentComponents } from '../../fluent';
import { monospaceStack } from '../../font-stacks';
import { useTranslation } from '../../i18n/translation';
import { DARK_SCHEME_QUERY, useMediaQuery } from '../../lib/use-media-query';

const { Button } = fluentComponents;
(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment ??= {
  getWorker: () => new EditorWorker(),
};

export default function BodyEditor({ text, json, label }: { text: string; json: boolean; label: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const dark = useMediaQuery(DARK_SCHEME_QUERY);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Reuse the owning monospace tokens; Monaco virtualizes long lines and documents.
    // https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.IStandaloneEditorConstructionOptions.html
    const style = getComputedStyle(container);
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontFamily: monospaceStack,
      fontSize: Number.parseFloat(style.getPropertyValue('--floway-font-size-mono')),
      padding: { top: Number.parseFloat(style.getPropertyValue('--spacingVerticalS')), bottom: Number.parseFloat(style.getPropertyValue('--spacingVerticalS')) },
      minimap: { enabled: false },
      readOnly: true,
      domReadOnly: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      folding: true,
      wordWrap: 'on',
      model: monaco.editor.createModel('', 'plaintext'),
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    model.setValue(text);
    monaco.editor.setModelLanguage(model, json ? 'json' : 'plaintext');
    editor.updateOptions({ ariaLabel: label });
    editor.setScrollTop(0);
  }, [text, json, label]);

  useEffect(() => { editorRef.current?.updateOptions({ theme: dark ? 'vs-dark' : 'vs' }); }, [dark]);

  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2`}>
      <Button size="small" onClick={() => void editorRef.current?.getAction('actions.find')?.run()}>{t('common.bodyViewer.find')}</Button>
      {json && <Button size="small" onClick={() => void editorRef.current?.getAction('editor.foldLevel2')?.run()}>{t('common.bodyViewer.fold')}</Button>}
      {json && <Button size="small" onClick={() => void editorRef.current?.getAction('editor.unfoldAll')?.run()}>{t('common.bodyViewer.unfold')}</Button>}
      <Checkbox defaultChecked label={t('common.bodyViewer.wrap')} onChange={(_, data) => editorRef.current?.updateOptions({ wordWrap: data.checked ? 'on' : 'off' })} />
    </div>
    <div className="flex-1 min-h-0 min-w-0" ref={containerRef} />
  </div>;
}
