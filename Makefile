# 一条命令安装：make install 后，在 .env 填好地址与 API Key 即可直接使用 zcode。
#
# 本文件只做转发，判定逻辑全部在 scripts/install/ 下的 Node 脚本里。
# 这样做的原因：逻辑写在 make 的 shell 方言里既难测试，也无法被其他入口复用；
# 而 `node scripts/install/install.mjs <mode>` 本身就是完整可用的入口。

.DEFAULT_GOAL := help
NODE ?= node
INSTALL := $(NODE) scripts/install/install.mjs

.PHONY: help install prune clean doctor

help:
	@echo "可用目标："
	@echo "  make install   安装依赖、构建、全局暴露 zcode，并预置 .env 与模型"
	@echo "  make doctor    运行安装自检（等价于 zcode doctor）"
	@echo "  make prune     移除构建/发布/开发期依赖，保留运行 zcode 所需闭包"
	@echo "  make clean     清空 node_modules 与 dist，并移除全局启动器"
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
