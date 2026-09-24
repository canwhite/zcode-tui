/**
 * 用户可见的环境变量键名，以及改名期间的双读规则。
 *
 * 背景：本产品从 `zcode` 改名为 `qcode`，用户可见的键统一改为 `QCODE_` 前缀。改名是
 * 分批做的，于是同一件事出现了两个键名，而**读的一方各读各的**：例如凭据库读
 * `ZCODE_DATA_BASE_DIR`、个人配置读 `QCODE_DATA_BASE_DIR`，只设其一就会出现
 * "配置写到了 A 目录、密钥写到了 B 目录"这种一半生效的静默错配。
 *
 * 规则：读的时候一律**新名优先、旧名兜底**。
 *   - 新名优先：它是 `.env.example` 与文档里宣传的那个；
 *   - 旧名兜底：已经设置旧名的部署不能被静默改道——改了落点却不报错是最难排查的一类问题。
 *
 * 写新代码只准用 `current`；`legacy` 只存在于读取路径。
 */

export interface RenamedEnvKeys {
  /** 规范名。新代码、文档、模板一律用它。 */
  readonly current: string;
  /** 改名前的旧名，仅供兼容读取。 */
  readonly legacy: string;
}

/** 数据根目录：会话、凭据、个人 Provider 配置都挂在它下面。 */
export const DATA_BASE_DIR_ENV_KEYS: RenamedEnvKeys = {
  current: "QCODE_DATA_BASE_DIR",
  legacy: "ZCODE_DATA_BASE_DIR",
};

/** 用户级配置家目录（默认 `~/.claude`）。 */
export const CONFIG_HOME_ENV_KEYS: RenamedEnvKeys = {
  current: "QCODE_CONFIG_HOME",
  legacy: "ZCODE_CONFIG_HOME",
};

/** 关闭「配置家目录不存在时自动创建」的开关。 */
export const CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV_KEYS: RenamedEnvKeys = {
  current: "QCODE_NO_CONFIG_HOME_BOOTSTRAP",
  legacy: "ZCODE_NO_CONFIG_HOME_BOOTSTRAP",
};

/** 覆盖内置服务端点的显式入口。 */
export const BASE_URL_ENV_KEYS: RenamedEnvKeys = {
  current: "QCODE_BASE_URL",
  legacy: "ZCODE_BASE_URL",
};

/** 端点 origin 覆盖（与 BASE_URL 同源的另一个旧入口）。 */
export const ENDPOINT_ORIGIN_ENV_KEYS: RenamedEnvKeys = {
  current: "QCODE_ENDPOINT_ORIGIN",
  legacy: "ZCODE_ENDPOINT_ORIGIN",
};

/**
 * 按名片「新名优先、旧名兜底」读取；去空白，空串视为未设置。
 *
 * 返回 undefined 而不是空串：调用方普遍用 `?? 默认值` 兜底，空串会让默认值失效。
 */
export function readRenamedEnv(
  env: Readonly<Record<string, string | undefined>>,
  keys: RenamedEnvKeys,
): string | undefined {
  const value = env[keys.current]?.trim() || env[keys.legacy]?.trim();
  return value && value.length > 0 ? value : undefined;
}
