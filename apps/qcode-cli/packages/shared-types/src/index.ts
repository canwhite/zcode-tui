// Modified by ZCode: 新增 configure 非交互写入所需的字段（Key / 厂商 / 模型覆盖）。
// 本分支全部改动的清单见 README.md「本分支的改动」。
export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunContext = {
  argv: string[];
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
};

export type GlobalLocale = "auto" | "en-US" | "zh-CN";
export type GlobalDetectedLocale = Exclude<GlobalLocale, "auto">;

/**
 * How a headless run reports itself.
 *
 * `text` prints the answer only. `json` prints one summary document after the
 * turn. `stream-json` additionally writes each session event as its own line
 * (NDJSON) while the turn runs, for callers that drive the CLI as a subprocess
 * and need progress — a bridge rendering a chat UI, for instance — rather than
 * only the finished answer.
 */
export type GlobalOutputFormat = "text" | "json" | "stream-json";

export type GlobalOptions = {
  browserExecutable?: string;
  browserUse?: "headless";
  /** 仅 `zcode configure` 使用：非交互写入的 Coding Plan Key。 */
  configureApiKey?: string;
  /** 仅 `zcode configure` 使用：Coding Plan 供应方 / 厂商名。 */
  configureProvider?: string;
  /** 仅 `zcode configure` 使用：模型名覆盖。 */
  configureModel?: string;
  detectedLocale?: GlobalDetectedLocale;
  force: boolean;
  json: boolean;
  locale?: GlobalLocale;
  memoryBench?: boolean;
  noColor: boolean;
  outputFormat?: GlobalOutputFormat;
  verbose: boolean;
};

export type RuntimeInfo = {
  arch: NodeJS.Architecture;
  cwd: string;
  execPath: string;
  node: string;
  platform: NodeJS.Platform;
  sea: boolean;
  versions: NodeJS.ProcessVersions;
};
