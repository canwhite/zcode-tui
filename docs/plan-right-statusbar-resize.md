# Plan: 右侧状态栏收缩/展开

> 在 TUI 右侧状态栏上添加收缩/展开按钮，将宽度在「展开态（缩窄后的固定宽度）」与「收缩态（仅图标）」之间切换。

## Context

当前右侧状态栏（`Sidebar` 组件）宽度硬编码为 `SIDEBAR_WIDTH = 42` 列（`app-sidebar-layout.ts:5`），由 `sidebarLayoutForTerminal` 根据终端宽度决定是否显示，但不支持用户主动收缩。pp12 的需求是：提供一个可切换的窄态，在「减少后的宽度」（展开）和「很窄」（收缩，仅图标）之间切换。

## Goal

用户点击按钮或按 `Ctrl+B` 时，状态栏在展开态（`expandedWidth`，默认 42 列）和收缩态（`collapsedWidth`，约 4-6 列，仅图标）之间平滑切换，编辑区空间随之动态调整。

## Plan

### 1. 导出收缩宽度常量

在 `app-sidebar-layout.ts` 中新增：

```ts
export const SIDEBAR_COLLAPSED_WIDTH = 5;   // 仅图标模式
```

### 2. 扩展 SidebarLayout 与 SidebarControllerState

在 `app-sidebar-layout.ts` 中：

```ts
// SidebarLayout 加一个字段
type SidebarLayout = {
  overlay: boolean;
  reservedWidth: number;
  visible: boolean;
  wide: boolean;
  collapsed: boolean;           // 新增：当前是否处于收缩态
};

// SidebarControllerState 加状态
type SidebarControllerState = {
  narrowOverlayOpen: boolean;
  preference: "auto" | "hidden" | "collapsed";  // "collapsed" = 用户主动收起
  sections: SidebarSectionExpansion;
  userCollapsed: boolean;       // 用户手动收起
};
```

### 3. 新增 toggleSidebarCollapse 回调

在 `useSidebarController` 中暴露 `toggleSidebarCollapse: () => boolean`，逻辑：

- 切 `userCollapsed` 状态
- 收缩时 `reservedWidth = SIDEBAR_COLLAPSED_WIDTH`
- 展开时 `reservedWidth = SIDEBAR_WIDTH`

### 4. 按钮组件

在 `Sidebar` 顶部（在 `productVersionHeader` 下方或 `sidebarSection` 区域内）渲染一个切换按钮：

- 收缩态显示 `>`（展开图标）
- 展开态显示 `<`（收缩图标）
- 放在 `Sidebar` 组件内，不需要单独的 `app-sidebar-collapse-button.ts`

### 5. 键盘快捷键

在 `app-keyboard.ts` 的键盘处理分支中加入 `btw` 之后（或 `readOnlyView` 之前）的位置，识别 `Ctrl+B`：

- 调用 `toggleSidebarCollapse`
- 需要在 `TuiOptions` 中加入 `toggleSidebarCollapse` 能力，从 `app.tsx` 一路传入

### 6. 展开/收缩动画

宽度切换不需要 JS 动画，`reservedWidth` 的变化通过 React 的重新渲染自然反映到布局上。

## Think — Debug Methodology

- **宽度在哪里生效**：搜索 `reservedWidth` 的所有消费者（主要是 `actionPanelContentWidthForTerminal`），确认收缩后编辑区宽度计算正确。
- **调试前缀**：`[DEBUG-sidebar]`
- **边界**：动画期间（React 渲染周期内）忽略再次点击，使用 state 锁防抖。

## Do — Verification Strategy

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过。
- **类型检查**：`pnpm typecheck` — 零错误。
- **Lint**：`pnpm lint` — 零错误。
- **手工验证**：
  1. 终端宽度 > 120 列时，状态栏默认展开，点击按钮后收缩到图标模式，编辑区变宽。
  2. 收缩态下点击按钮，状态栏展开回 42 列。
  3. `Ctrl+B` 与按钮行为一致。
  4. 终端宽度变化（resize）后，`collapsed` 状态保持不变。

## Adjust — Rollback and Global Scan

- **Rollback**：移除 `userCollapsed` 状态、`SIDEBAR_COLLAPSED_WIDTH` 常量与 `toggleSidebarCollapse` 回调即可。
- **Global scan**：搜索全库所有硬编码列宽（如 `width: 42`），确认没有其他地方需要同步修改。
- **回退行为**：`userCollapsed` 状态不持久化（不写入配置），刷新/重启后默认展开。

## Open Questions

- **收缩宽度具体列数**：5 列是否够用？需要验证图标 + 最小 padding 是否足够。
- **是否持久化**：`userCollapsed` 是否写入 `~/.claude`？当前 Plan 按「不持久化」处理。
- **动画**：是否需要平滑过渡动画（如 CSS transition）？当前按「无动画，渲染即变」处理。

## Out of Scope

- 保存/恢复收缩偏好的持久化。
- 触摸交互优化。
- 窄终端（< 80 列）的强制最小宽度保护。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

### R-001 收缩后展开按钮不可见或无法点击

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4 × 3 × (1 − 0.3) = **9.6**
**判定**：🟡 MEDIUM

**Failure Scenario**：收缩后按钮区域过窄，被 Yoga 布局引擎裁切；用户无法再次展开，只能重启会话。

**Mitigation**：
- `SIDEBAR_COLLAPSED_WIDTH` **至少 12 列**（按钮本身 1-2 列 + 左右 padding，保证最小点击热区）。
- 按钮 box 显式设置 `flexShrink: 0` 和 `width: 1`（不缩）+ `truncate: false`，确保 Yoga 不裁切。
- 按钮无条件渲染（不因宽度不足跳过），收缩态下同样可见可点。
- 验收：收缩后按钮始终可见，点击后可展开。

### R-002 reservedWidth 变化后，编辑区宽度计算错误

**Severity**: 5 | **Likelihood**: 2 | **Detectability**: 0.4
**Risk Score**: 5 × 2 × (1 − 0.4) = **6**
**判定**：🟢 LOW

**Failure Scenario**：`actionPanelContentWidthForTerminal` 仍使用 `SIDEBAR_WIDTH` 而非 `layout.reservedWidth`，导致编辑区在收缩后没有变宽。

**Mitigation**：
- 实现前：搜索所有引用 `SIDEBAR_WIDTH` 计算布局的位置，确认都改用 `layout.reservedWidth`。
- 实现后：收缩前后实测编辑区宽度，确认数值变化幅度与预期一致（编辑区增加 ≈ `SIDEBAR_WIDTH - SIDEBAR_COLLAPSED_WIDTH` 列）。

### R-003 Ctrl+B 与终端内置快捷键冲突

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 3 × 3 × (1 − 0.4) = **5.4**
**判定**：🟢 LOW

**Failure Scenario**：部分终端中 `Ctrl+B` 被映射为"后退一个词"（`backward-word`），与 `toggleSidebarCollapse` 冲突；用户按 `Ctrl+B` 没有切换侧栏，反而触发了终端的文本导航。

**Mitigation**：
- 验收时在多个终端（iTerm2、macOS Terminal、Windows Terminal）测试 `Ctrl+B` 是否按预期工作。
- 如冲突普遍，考虑改用 `Ctrl+\` 或 `Ctrl+Shift+S`（需与用户确认偏好）。

### R-004 收缩/展开导致 Sidebar 内容布局错乱

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 3 × 3 × (1 − 0.4) = **5.4**
**判定**：🟢 LOW

**Failure Scenario**：Sidebar 内各 section（Subagents、MCP、ModifiedFiles 等）内部使用 `SIDEBAR_CONTENT_WIDTH = SIDEBAR_WIDTH - padding * 2` 做宽度约束；收缩后内容被压扁、文字截断、无法读取引擎名称。

**Mitigation**：
- 收缩态下对 Sidebar 内容做**条件渲染**：`collapsed ? null : <各 section>`（icon 模式下只显示一个折叠图标，内容全部隐藏）。
- 各 section 的宽度约束改为基于 `layout.reservedWidth` 计算，而非硬编码 `SIDEBAR_WIDTH`。

### R-005 Sidebar 收缩后，BtwPanel / ApprovalPanel 等浮层位置计算错误

**Severity**: 4 | **Likelihood**: 2 | **Detectability**: 0.5
**Risk Score**: 4 × 2 × (1 − 0.5) = **4**
**判定**：🟢 LOW

**Failure Scenario**：浮层（如侧问面板）基于 `terminalWidth` 做绝对定位，Sidebar 收缩后浮层内容偏左，与用户预期不符。

**Mitigation**：
- 浮层定位统一基于 `actionPanelContentWidth`（已由 `reservedWidth` 决定），而非 `terminalWidth`；检查 `BtwPanel` 等组件的定位逻辑是否正确引用了布局宽度。

### R-006 终端宽度 resize 后，collapsed 状态与 wide/visible 逻辑不一致

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.5
**Risk Score**: 3 × 2 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：用户收起 Sidebar 后缩小终端宽度，`sidebarLayoutForTerminal` 触发 overlay 逻辑，但 `userCollapsed` 状态仍在；用户重开终端后状态栏行为不符合预期。

**Mitigation**：
- 当终端宽度从不支持显示变为支持显示时（`wide: false → true`），重置 `userCollapsed = false`（自动展开）。
- 当终端宽度从支持显示变为不支持时（`wide: true → false`），**保持** `userCollapsed` 状态；因为 sidebar 本就不显示了，展开/收起没有意义。

### R-007 toggleSidebarCollapse 没有正确传递到所有调用点

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 4 × 3 × (1 − 0.4) = **7.2**
**判定**：🟡 MEDIUM

**Failure Scenario**：`toggleSidebarCollapse` 需要从 `app.tsx` → `AppView` → `Sidebar` 一路传递；中间任一环节漏接都会导致按钮点击无效，且无编译错误，只有运行时能发现。

**Mitigation**：
- TypeScript 类型系统兜底：确保 `TuiOptions` 或 props 中 `toggleSidebarCollapse` 类型非可选。
- 验收时：点击按钮后确认状态栏宽度变化（不需要等动画，即时验证即可）。
