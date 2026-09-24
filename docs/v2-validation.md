# 四后端向导与双层配置验证（整体尚未通过）

## 当前实现

- 向导探测 `claude`、`codex`、`opencode`、`pi` CLI；两角色可分别选择任一后端。只展示选定两模型共同公告的 `low`、`medium`、`high`、`max`，启动时再次设置并核验，不静默降级。
- `.pi-plan-execute-auto/config.json` 只缓存项目身份、路由与思考档位；Pi 用户目录的受保护 profile 保存配置摘要与人的网络风险同意。仅修改项目文件不能批准配置或网络使用。
- Claude/Pi 选项在保存前另需批准可能计费的合成仓库模型请求。四后端均使用合成根目录 bubblewrap 文件系统边界，Reviewer worktree 由外层 OS 只读挂载；**ACP 网络仍可访问宿主网络**，不得用于敏感仓库。Pi ACP 在会话开放前将所选 provider 凭据导入内存并删除临时文件。Claude 不转发宿主环境密钥或整个配置；自定义后端不自动放行。
- Claude/Pi Node ACP 在已转发并校验的无凭据 HTTP(S) 代理存在时启用 `NODE_USE_ENV_PROXY=1`。Codex Reviewer 在外层 OS 只读挂载及写探针通过后，使用其 adapter 的 `agent-full-access` *内层模式*：adapter 的 `read-only` 模式实际上仍启动内层 `workspaceWrite` 并试图在只读 worktree 创建 `.agents`。内层模式不是写权限边界。

## 独立验证与未通过项

- `npm run check`、`npm run build`、`npm test` **71/71（0 跳过）**、`npm run test:sandbox:required` **9/9（0 跳过）**。探针包括四端实际 bwrap 边界、Pi 凭据删除和 Node 代理选项。此前临时项目的 Pi 官方 `pi install -l`、`pi list`、无会话包加载已验；本轮没有把未信任临时项目中的 `pi list` 当成加载证据。
- Codex/OpenCode 的精确路由为 `opencode/deepseek-local/deepseek-flash`、`codex/gpt-6-luna`，思考档位为 `high`。首次本轮真实复测 **2/3**：Codex Reviewer 内层沙箱无法创建 `.agents`，未执行检查；按上述方式修复后，`npm run test:acp:required` **3/3**，包括单阶段沙箱验收及插件提交。
- Pi `provider_error` 已定位：隔离沙箱中的 Pi SDK 模型请求返回 `fetch failed`；未使用代理的 Node 连通性探针超时，使用校验后的无凭据代理后恢复。隔离 SDK 真请求随后为 `stop`。真实 AgentPrism ACP 在 `pi/openai-codex/gpt-5.5`、`high` 下 Executor、Reviewer、单阶段验收及 phase commit **3/3**。其他 Pi provider/model 未据此通过。
- Claude **0/3**。用户终端先后出现 `Not logged in` 与真实 `claude -p --model sonnet` 请求返回 `OK`；本工具进程随后也复测宿主 CLI 真请求返回 `OK`。定位环境变化时只检查变量名称与是否设置，不读取或输出值：本进程设置了 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_BASE_URL`。在合成 HOME/配置目录下撤去前者，`claude auth status --json` 从 `loggedIn: true` 变为 `false`；只撤去后者不改变登录状态。宿主 CLI 成功依赖环境凭据，而隔离沙箱白名单所需的独立 `.claude/.credentials.json` 仍不存在。仅重跑 Claude 三项真实沙箱测试（不重跑 Pi 计费测试）为 **0/3**，全部在启动前明确拒绝；没有真实 Claude ACP provider 请求。不能把宿主 CLI、定制端点或 ACP 目录公告视为隔离验收。先前探索性暂存整个宿主 `.claude.json` 得到 `AUTH_REQUIRED`，已撤回。

**结论：Pi、Codex、OpenCode 的上述精确路由已通过真实沙箱与完整单阶段验收；四后端整体验收 FAIL（Claude 0/3）。** 若使用当前凭据边界，须由用户自行建立不依赖环境变量、且可安全暂存的独立 CLI 登录文件；若必须使用环境令牌或定制网关，需另行设计、审查并实测 OS 强制的凭据隔离，防止模型工具读取令牌。不可转发环境凭据、保留完整宿主配置、降低思考强度或凭目录探测宣布通过。不得在日志或报告中输出凭据；网络风险同意不构成 OS 网络隔离。
