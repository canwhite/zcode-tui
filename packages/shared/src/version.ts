// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，
// 用 typeof 检查 + fallback 避免 ReferenceError。
declare const __QCODE_VERSION__: string;
declare const __QCODE_COMMIT__: string;
declare const __QCODE_BUILD_TIME__: string;

export const QCODE_VERSION: string =
  typeof __QCODE_VERSION__ !== "undefined" ? __QCODE_VERSION__ : "0.0.0-dev";
export const QCODE_COMMIT: string =
  typeof __QCODE_COMMIT__ !== "undefined" ? __QCODE_COMMIT__ : "unknown";
export const QCODE_BUILD_TIME: string =
  typeof __QCODE_BUILD_TIME__ !== "undefined" ? __QCODE_BUILD_TIME__ : "unknown";
