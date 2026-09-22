#!/usr/bin/env node
// .env 生成与校验：只追加缺失键，绝不覆盖已存在的值。
//
// 取舍：不做完整 dotenv 解析（引号、转义、插值），只识别 `KEY=VALUE` 形态。
// .env.example 是全仓库的配置契约，保持它与解析器同样的简单形态即可；
// 引入完整解析会凭空多出一份与 dotenv 竞争的实现。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./toolchain.mjs";

export const envPath = join(repoRoot, ".env");
const examplePath = join(repoRoot, ".env.example");

/** 缺少这些键，用户就无法“只改 env 就用起来”。 */
export const REQUIRED_KEYS = ["BIGMODEL_API_KEY"];

/**
 * 解析 `KEY=VALUE` 形态的行，保留注释与空行顺序。
 * @returns {{key: string, value: string, comment?: string, raw: string}[]}
 */
export function parseEnvEntries(text) {
  const entries = [];
  let pendingComment;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      pendingComment = pendingComment ? `${pendingComment}\n${raw}` : raw;
      continue;
    }
    if (line === "") {
      pendingComment = undefined;
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      pendingComment = undefined;
      continue;
    }
    entries.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
      raw,
      ...(pendingComment ? { comment: pendingComment } : {}),
    });
    pendingComment = undefined;
  }
  return entries;
}

/**
 * 确保项目根存在 .env，并把 .env.example 中尚未出现的键追加进去。
 * 已存在的键一律保留原值——用户可能已经指向自建服务，覆盖会破坏他的配置。
 *
 * @returns {{created: boolean, appended: string[], emptyRequired: string[]}}
 */
export function ensureEnvFile(log = console.log) {
  let created = false;
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new Error(`缺少 ${examplePath}，无法生成 .env`);
    }
    copyFileSync(examplePath, envPath);
    created = true;
    log(`[env] 已从 .env.example 生成 ${envPath}`);
  }

  const current = parseEnvEntries(readFileSync(envPath, "utf8"));
  const present = new Set(current.map((entry) => entry.key));
  const template = existsSync(examplePath)
    ? parseEnvEntries(readFileSync(examplePath, "utf8"))
    : [];

  const missing = template.filter((entry) => !present.has(entry.key));
  if (missing.length > 0) {
    const block = missing
      .map((entry) => [entry.comment, entry.raw].filter(Boolean).join("\n"))
      .join("\n");
    const base = readFileSync(envPath, "utf8");
    writeFileSync(envPath, `${base.replace(/\n*$/, "\n")}\n${block}\n`, "utf8");
    log(`[env] 已追加缺失键：${missing.map((entry) => entry.key).join(", ")}`);
  } else {
    log("[env] 无需追加，已存在全部模板键");
  }

  // 校验必填键是否真正有值：只有键名没有值，等于没配。
  const after = parseEnvEntries(readFileSync(envPath, "utf8"));
  const emptyRequired = REQUIRED_KEYS.filter((key) => {
    const entry = after.find((candidate) => candidate.key === key);
    return !entry || entry.value === "";
  });

  if (emptyRequired.length > 0) {
    log(`[env] 以下必填键仍为空：${emptyRequired.join(", ")}`);
  }

  return { created, appended: missing.map((entry) => entry.key), emptyRequired };
}
