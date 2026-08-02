// monaco-yaml's own Vite workaround: its worker entry has to be re-exported
// from a file in this project and referenced as `./…?worker`, or the editor
// fails at runtime with "Unexpected usage" from `loadForeignModule`.
// https://github.com/remcohaszing/monaco-yaml/blob/9a15c651c95f5ab4c6b16c42f6570ab0540c641a/README.md#why-doesnt-it-work-with-vite
import 'monaco-yaml/yaml.worker.js';
