import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@qcode/shared/node";
import { createZCodeCredentialCipher, type ZCodeCredentialCipher } from "./credential-cipher.js";

/**
 * 共享凭据库：**只服务两类调用方**。
 *
 * 1. **MCP 服务器的 OAuth**（`mcp:oauth:*` 键，由 `adapters/src/mcp/oauth-credentials.ts` 使用）；
 * 2. **Coding Plan 的配置写入**（`account-provider:*` 键，由
 *    `bootstrap/src/coding-plan-config.ts` 的 `configureCodingPlanApiKey` 写入 —— 这是
 *    **非登录**路径，key 由用户自行提供）。
 *
 * 工具的「登录态」凭据（`oauth:active_provider`、`oauth:{bigmodel,zai}:*`、`zcodejwttoken`）
 * 已随登录功能整体移除，见 `docs/plan-remove-login-zai-coupling.md`。
 * 老用户磁盘上若仍留有这些键，本模块**不读取、不参与解析、也不主动删除**。
 */

const QCODE_DATA_BASE_DIR_ENV_KEY = "QCODE_DATA_BASE_DIR";
const credentialChangeListeners = new Map<
  string,
  Set<() => void | Promise<void>>
>();

export interface SharedZCodeCredentialStoreOptions {
  baseDir?: string;
  cipher?: ZCodeCredentialCipher;
  env?: Record<string, string | undefined>;
  filePath?: string;
}

export interface SharedZCodeCredentialStore {
  readonly filePath: string;
  delete(key: string): Promise<void>;
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  deleteManyIfValue(
    guardKey: string,
    expectedGuardValue: string,
    keysToDelete: readonly string[],
  ): Promise<boolean>;
  load(key: string): Promise<string | null>;
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  onDidChange?(listener: () => void | Promise<void>): () => void;
  save(key: string, value: string): Promise<void>;
  saveMany(entries: Readonly<Record<string, string>>): Promise<void>;
}

export function createSharedZCodeCredentialStore(
  options: SharedZCodeCredentialStoreOptions = {},
): SharedZCodeCredentialStore {
  const env = options.env ?? process.env;
  const filePath = resolveSharedZCodeCredentialsPath(options);
  const cipher = options.cipher ?? createZCodeCredentialCipher({ env });

  return {
    filePath,

    async delete(key: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        delete rawCredentials[validatedKey];
      });
    },

    async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
      const validatedKey = validateCredentialKey(key);
      const validatedExpectedValue = validateCredentialValue(expectedValue);
      let deleted = false;
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        const encryptedValue = rawCredentials[validatedKey];
        if (
          encryptedValue === undefined ||
          cipher.decrypt(encryptedValue) !== validatedExpectedValue
        ) {
          return;
        }
        delete rawCredentials[validatedKey];
        deleted = true;
      });
      return deleted;
    },

    async deleteManyIfValue(
      guardKey: string,
      expectedGuardValue: string,
      keysToDelete: readonly string[],
    ): Promise<boolean> {
      const validatedGuardKey = validateCredentialKey(guardKey);
      const validatedExpectedValue = validateCredentialValue(expectedGuardValue);
      const validatedKeys = keysToDelete.map(validateCredentialKey);
      let deleted = false;
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        const encryptedGuard = rawCredentials[validatedGuardKey];
        if (
          encryptedGuard === undefined ||
          cipher.decrypt(encryptedGuard) !== validatedExpectedValue
        ) {
          return;
        }
        for (const key of validatedKeys) delete rawCredentials[key];
        deleted = true;
      });
      return deleted;
    },

    async load(key: string): Promise<string | null> {
      const rawCredentials = await readRawCredentialRecord(filePath);
      const rawValue = rawCredentials[validateCredentialKey(key)];
      if (rawValue === undefined) {
        return null;
      }
      return cipher.decrypt(rawValue);
    },

    async loadMany(keys: readonly string[]): Promise<Record<string, string | null>> {
      const validatedKeys = keys.map(validateCredentialKey);
      const rawCredentials = await readRawCredentialRecord(filePath);
      return Object.fromEntries(
        validatedKeys.map((key) => {
          const rawValue = rawCredentials[key];
          return [key, rawValue === undefined ? null : cipher.decrypt(rawValue)];
        }),
      );
    },

    onDidChange(listener: () => void | Promise<void>): () => void {
      let listeners = credentialChangeListeners.get(filePath);
      if (!listeners) {
        listeners = new Set();
        credentialChangeListeners.set(filePath, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) credentialChangeListeners.delete(filePath);
      };
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const encryptedValue = cipher.encrypt(validateCredentialValue(value));
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        rawCredentials[validatedKey] = encryptedValue;
      });
    },

    async saveMany(entries: Readonly<Record<string, string>>): Promise<void> {
      const encryptedEntries = Object.entries(entries).map(
        ([key, value]) =>
          [validateCredentialKey(key), cipher.encrypt(validateCredentialValue(value))] as const,
      );
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        for (const [key, encryptedValue] of encryptedEntries) {
          rawCredentials[key] = encryptedValue;
        }
      });
    }

  };
}

export function resolveSharedZCodeCredentialsPath(
  options: SharedZCodeCredentialStoreOptions = {},
): string {
  if (options.filePath) {
    return resolveUserPath(options.filePath);
  }

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? env[QCODE_DATA_BASE_DIR_ENV_KEY] ?? homedir();
  return join(resolveUserPath(baseDir), ".zcode", "v2", "credentials.json");
}

async function readRawCredentialRecord(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read shared ZCode credentials: ${filePath}`, { cause: error });
  }

  try {
    return parseCredentialRecord(JSON.parse(raw));
  } catch (error) {
    // 损坏的凭据文件若被当成空对象继续保存，会一次性抹掉其他进程的全部凭据。
    // 先保留现场再失败，调用方必须显式处理恢复，不能静默覆盖。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    const evidence = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(`Shared ZCode credentials are corrupt: ${filePath}.${evidence}`, {
      cause: error,
    });
  }
}

async function mutateRawCredentialRecord(
  filePath: string,
  mutation: (value: Record<string, string>) => void | Promise<void>,
): Promise<void> {
  // CLI、设置页和 session 可能位于不同 Node 进程；锁必须覆盖完整的
  // read-modify-write，单独原子 rename 只能防半写，不能防旧快照覆盖新 key。
  await withFileLock(filePath, async () => {
    const value = await readRawCredentialRecord(filePath);
    await mutation(value);
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  });
  const listeners = [...(credentialChangeListeners.get(filePath) ?? [])];
  // 同进程的 Registry Source 需要在登录返回前观察到新凭据；单个监听者失败不应
  // 把已经原子落盘的 Credential 伪装成写入失败。
  await Promise.allSettled(listeners.map((listener) => listener()));
}

function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Credential record must be an object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Credential record value must be a string: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("Credential key must not be empty");
  }
  return trimmed;
}

function validateCredentialValue(value: string): string {
  if (value.length === 0) {
    throw new Error("Credential value must not be empty");
  }
  return value;
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
