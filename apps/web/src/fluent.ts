/**
 * Fluent UI React 统一导入入口。
 *
 * ## 为什么需要这个文件
 *
 * {@link https://www.npmjs.com/package/@fluentui/react-components | @fluentui/react-components}
 * 是一个双模（CJS + ESM）包：构建产物同时包含 `lib-commonjs/index.js`（CJS）
 * 和 `lib/index.js`（ESM 命名导出）。
 *
 * 生产构建中 Vite/Rolldown 能正确走 ESM 入口，`import { FluentProvider } from "..."`
 * 命名导出正常工作。但在 dev mode 下，Vite 对该包的依赖预构建（esbuild）可能无法可靠
 * 检测到全部 1200+ 命名导出，转而将整个 `module.exports` 对象包装进 `default` 导出。
 * 此时 `import { FluentProvider }` 会报错：
 *
 * ```
 * Named export 'FluentProvider' not found. The requested module
 * '@fluentui/react-components' is a CommonJS module...
 * ```
 *
 * 本文件使用 `import * as ns` 拿到模块命名空间，再依次尝试：
 * 1. `ns.FluentProvider` → esbuild 正确检测到命名导出时有效
 * 2. `ns.default` → esbuild 将 CJS 包装成 default 时有效
 * 3. `ns["module.exports"]` → 旧版打包器的 fallback
 *
 * 组件通过 `const { Button, Text, makeStyles } = fluentComponents;` 解构使用，
 * 无需关心底层模块格式差异，也不需要在每个文件中重复写出完整的导入列表。
 */
import * as fluentNamespace from "@fluentui/react-components";

type FluentComponents = typeof import("@fluentui/react-components");
type FluentComponentsInterop = Partial<FluentComponents> & {
  default?: Partial<FluentComponents>;
  "module.exports"?: Partial<FluentComponents>;
};

const wrappedNamespace = fluentNamespace as unknown as FluentComponentsInterop;

export const fluentComponents = (
  wrappedNamespace.FluentProvider
    ? wrappedNamespace
    : wrappedNamespace.default ?? wrappedNamespace["module.exports"]
) as FluentComponents;
