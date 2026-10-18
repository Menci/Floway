import * as monaco from 'monaco-editor';
import './monaco-workers';
import { useLayoutEffect, useRef } from 'react';

import { monospaceStack } from '../../font-stacks';
import { DARK_SCHEME_QUERY, useMediaQuery } from '../../lib/use-media-query';

export function JsonEditor({ active, invalid, label, onChange, readOnly = false, value }: {
  active: boolean;
  invalid?: boolean;
  label: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  value: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const initialLabelRef = useRef(label);
  const dark = useMediaQuery(DARK_SCHEME_QUERY);
  const initialDarkRef = useRef(dark);

  useLayoutEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useLayoutEffect(() => {
    const container = containerRef.current!;
    const style = getComputedStyle(container);
    const model = monaco.editor.createModel(initialValueRef.current, 'json');
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      ariaLabel: initialLabelRef.current,
      fontFamily: monospaceStack,
      fontSize: Number.parseFloat(style.getPropertyValue('--floway-font-size-mono')),
      lineHeight: 20,
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: false },
      model,
      padding: { top: 8, bottom: 8 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      theme: initialDarkRef.current ? 'vs-dark' : 'vs',
      wordWrap: 'on',
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

  useLayoutEffect(() => {
    const editor = editorRef.current!;
    const model = editor.getModel()!;
    if (model.getValue() !== value) model.setValue(value);
    editor.updateOptions({ ariaLabel: label, readOnly, theme: dark ? 'vs-dark' : 'vs' });
    if (active) {
      // A persistent editor is laid out and painted before the newly visible
      // mode reaches the screen, including its very first activation.
      // https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.IStandaloneCodeEditor.html#render
      editor.layout();
      editor.render(true);
    }
    editor.getDomNode()!.querySelector('[role="textbox"]')!.setAttribute('aria-invalid', String(invalid === true));
  }, [active, dark, invalid, label, readOnly, value]);

  return <div className="h-[240px] min-w-0 overflow-hidden border border-solid border-fui-divider rounded" data-json-editor="" hidden={!active} ref={containerRef} />;
}
