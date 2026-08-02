// Under Vite, monaco-yaml's worker entry must be re-exported from a project
// file referenced as `./…?worker`, or it fails with "Unexpected usage".
// https://github.com/remcohaszing/monaco-yaml/blob/9a15c651c95f5ab4c6b16c42f6570ab0540c641a/README.md#why-doesnt-it-work-with-vite
import 'monaco-yaml/yaml.worker.js';
