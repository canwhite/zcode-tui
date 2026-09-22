# 交付总结：换厂商只需改 .env

> 完成时间：2026-09-22 ｜ 范围：`.env` 四字段驱动厂商切换（痛点 [painpoint-vendor-switch.md](painpoint-vendor-switch.md) 的 F-001 ~ F-005）

## 最终效果

`.env` 里四个字段决定一切：

```bash
ZCODE_VENDOR=bigmodel
ZCODE_VENDOR_MODEL=GLM-5.3
ZCODE_VENDOR_API_KEY=...
ZCODE_VENDOR_BASE_URL=https://open.bigmodel.cn/api/anthropic   # 选填
```

改完跑 `make install` 即可生效；`ZCODE_VENDOR_BASE_URL` 不填时由厂商带出。

## 分流规则

按用户提议确定：**看填写的端点是不是某个账号型套餐的端点**，决定 key 写哪。

| 填写的 BASE_URL | 判定 | key 落点 |
|---|---|---|
| `https://open.bigmodel.cn/api/anthropic` | 套餐 | 加密凭据库 `~/.zcode/v2/credentials.json` |
| `https://api.z.ai/api/anthropic` | 套餐 | 加密凭据库 |
| `https://api.moonshot.cn/anthropic` | 非套餐 | 个人配置 `~/.zcode/v2/provider_config.json` |
| `https://api.deepseek.com/anthropic` | 非套餐 | 个人配置 |
| `https://api.minimaxi.com/anthropic` | 非套餐 | 个人配置 |
| `https://open.bigmodel.cn/api/paas/v4` | 非套餐 | 个人配置 |
| 任意自建端点 | 非套餐 | 个人配置 |

**必须精确匹配套餐端点，不能做后缀匹配。** 上表第 3~5 行同样以 `/anthropic` 结尾，任何"看着像 anthropic 就当套餐"的判断都会把它们误写进凭据库链路——这会表现为请求全部失败，而用户改 key、改地址都不解决。

## 完成清单

| todo | 结果 |
|---|---|
| 厂商模块 | ✅ 28 厂商、14 短名、端点一致性、模型越界报错、自定义放行 |
| `configure` 四字段 | ✅ 套餐 + 个人配置两条写入路径都跑通 |
| `.env` 迁移 | ✅ 删 8 键，`BIGMODEL_API_KEY` → `ZCODE_VENDOR_API_KEY` |
| `make install` + `doctor` | ✅ install 读 `.env` 配置；doctor 报出生效厂商，配了没生效会 WARN |
| 四份文档 | ✅ 订正 `builtinModelIds`→`personalModelIds`，三份旧文档加了层级标注 |

写入路径实测：`personalModelIds` 正确、**幂等**（跑两次仍 1 条）、权限 `-rw-------`。

## 改动过计划的三处

1. **链路判据**：从"BASE_URL 判别"→"厂商类型"→最终按用户意见简化为"端点是否命中套餐端点"。
2. **BASE_URL 从必填改选填**：厂商字段能带出端点，强制手抄只会引入抄错风险——而抄错 `/api/anthropic` 与 `/api/paas/v4` 恰好会让配置滑进另一条链路。
3. **账号族不再从 providerId 切分推导**：原实现用 `split("-")[0]`，`bigmodel`/`zai` 恰好没有连字符所以蒙对，换个含连字符的族名就会静默切错。改为读配置里的 `access.accountType`。

## 需要你知道的三件事

**1. 非套餐厂商没跑过真实请求。** 只验证了写入结构正确，我没有 Moonshot / DeepSeek 的 key。你填上对应 key 跑 `make install` 即可验证。

**2. 两条链路的 key 存储方式不同。** 套餐 key 在加密凭据库，普通厂商 key**明文内联**在 `~/.zcode/v2/provider_config.json`（权限已收紧到 0600）。`configure` 输出的提示里写了这一点，文档中也如实记录，没有粉饰成"已加密"。

**3. `.env` 只在仓库树内生效。** 它由 cwd 逐级向上查找，所以在 `/tmp` 等目录启动全局 `zcode` 时读不到。你现有配置不受影响（凭据已落库），但换厂商的配置在仓库外不生效；`doctor` 会以 WARN 提示。

## 备份与清理

- `.env.bak-before-vendor-migration` —— 迁移前的 `.env`，确认无误后可删。
- `.zshrc` 的 PATH 行是上一轮 `make install` 加的，与本次改动无关。

## 相关文档

- [painpoint-vendor-switch.md](painpoint-vendor-switch.md) —— 痛点分析
- [plan-vendor-switch.md](plan-vendor-switch.md) —— 总纲
- [plan-vendor-config-write.md](plan-vendor-config-write.md) —— 实现基准（含完整交付记录与 11 条风险）
- [plan-vendor-config-contract.md](plan-vendor-config-contract.md) —— 早期契约草案（五字段设计已被取代）
