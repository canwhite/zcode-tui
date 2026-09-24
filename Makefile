# 一条命令安装：make install 后，在 .env 填好地址与 API Key 即可直接使用 qcode。
#
# 本文件只做转发，判定逻辑全部在 scripts/install/ 下的 Node 脚本里。
# 这样做的原因：逻辑写在 make 的 shell 方言里既难测试，也无法被其他入口复用；
# 而 `node scripts/install/install.mjs <mode>` 本身就是完整可用的入口。

.DEFAULT_GOAL := help
NODE ?= node
INSTALL := $(NODE) scripts/install/install.mjs

.PHONY: help install prune clean doctor permission-allow permission-edit permission-status

help:
	@echo "可用目标："
	@echo "  make install            安装依赖、构建、全局暴露 qcode，并预置 .env 与模型"
	@echo "  make doctor             运行安装自检（等价于 qcode doctor）"
	@echo "  make prune              移除构建/发布/开发期依赖，保留运行 qcode 所需闭包"
	@echo "  make clean              清空 node_modules 与 dist，并移除全局启动器"
	@echo ""
	@echo "  make permission-status  查看当前权限模式"
	@echo "  make permission-allow   切换为 allow 模式（无需确认）"
	@echo "  make permission-edit    切换为 edit 模式（每次确认）"
	@echo ""
	@echo "直接入口（不依赖 make）：$(NODE) scripts/install/install.mjs install"

install:
	@$(INSTALL) install

doctor:
	@$(INSTALL) doctor

prune:
	@$(INSTALL) prune

clean:
	@$(INSTALL) clean

# ===== Permission Mode =====
# ZCode CLI 权限模式切换（控制文件编辑是否需要确认）
# allow  = 默认允许所有操作（无确认）
# edit   = 每次编辑需要确认

PERMISSION_DB := $(HOME)/.zcode/cli/db/db.sqlite
PERMISSION_SCOPE := proj_users-doing-desktop-zcode-tui

permission-status:
	@echo "当前权限模式："
	@sqlite3 $(PERMISSION_DB) "SELECT scope_id, value FROM local_setting WHERE key = 'mode' AND scope = 'project';" 2>/dev/null || echo "未找到配置"

permission-allow:
	@sqlite3 $(PERMISSION_DB) "UPDATE local_setting SET value = '{\"mode\":\"allow\"}' WHERE key = 'mode' AND scope = 'project' AND scope_id = '$(PERMISSION_SCOPE)';" 2>/dev/null
	@echo "已切换为: allow（默认允许所有操作）"

permission-edit:
	@sqlite3 $(PERMISSION_DB) "UPDATE local_setting SET value = '{\"mode\":\"edit\"}' WHERE key = 'mode' AND scope = 'project' AND scope_id = '$(PERMISSION_SCOPE)';" 2>/dev/null
	@echo "已切换为: edit（每次编辑需要确认）"
