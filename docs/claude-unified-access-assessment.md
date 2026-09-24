# Claude 与四端统一接入：安全凭据 Relay 已实现

## 当前架构

Stage B 的四个 backend 都走同一个宿主边界：

```text
Main Pi / StageBController
  -> AgentPrism AcpAgent
  -> run-scoped CustomBackendConfig
  -> root-owned bubblewrap
  -> backend ACP runtime
     - claude-agent-acp
     - codex-acp
     - opencode acp
     - pi-acp
```

`AcpAgent` 是一 agent 一独立 ACP process/connection 的 SDK 路径，不经过 AgentPrism runner pool。插件没有把 Executor/Reviewer 实现成 Main Pi 或其它 backend 的 subagent：Executor 持有自己的完整 ACP session，并在同一 phase 的 REWORK turn 间保持；每个 Reviewer round 创建新的完整 ACP session。真实集成测试还断言完整 Stage B 中 Executor 与 Reviewer 的 session id 不相同。

## Claude 凭据边界

Claude 不再要求把真实 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 或宿主 `.claude` credential 文件放进 bubblewrap。创建 Claude sandbox 时，可信宿主进程启动一个 run-private loopback relay：

1. relay 在宿主读取 `ANTHROPIC_AUTH_TOKEN`（优先）或 `ANTHROPIC_API_KEY`，以及可选的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS`；
2. sandbox 只得到不可用于上游认证的 dummy token 和随机高熵 capability URL；
3. relay 只接受 loopback、该 capability、POST，以及 `/v1/messages` / `/v1/messages/count_tokens`；
4. 请求 body 必须声明与用户批准的 `claude/<model>` route 匹配的 model；精确 model id 精确匹配，Claude 的 `sonnet` / `opus` / `haiku` CLI alias 只允许对应 family；
5. sandbox 传入的 `Authorization` / `x-api-key` / Host 等敏感或 hop-by-hop headers 被丢弃，真实认证只由宿主 relay 注入；
6. upstream redirect 不会自动跟随；带 credential/query/fragment 的 upstream URL 或非 loopback 的明文 HTTP upstream 被拒绝；
7. 响应头采用协议必需字段白名单，含凭据原文的头会被移除；流式 body 使用跨 chunk secret scrubber 防止上游意外回显宿主 secret。此为针对真实凭据原文字节的防护，不对恶意上游转换编码后的回显做绝对保密保证；
8. request size、并发数、header/request/upstream timeout 都有硬上限；relay 生命周期绑定到 `SandboxedBackend.cleanup()`。

Claude sandbox 使用 `--clearenv`，不继承宿主 provider secret，也不继承宿主 HTTP(S) proxy；provider 请求只指向本地 relay。额外关闭 telemetry、error reporting、auto updater 和 Claude 非必要流量。

## Claude session 强制策略

run-scoped Claude custom backend 在每个 session 上强制：

```json
{
  "claudeCode": {
    "options": {
      "settingSources": [],
      "allowDangerouslySkipPermissions": false,
      "disallowedTools": ["Agent", "Task", "WebSearch", "WebFetch"]
    }
  }
}
```

因此项目里的 `.claude/settings.json` / `.claude/settings.local.json`、用户 Claude settings、hooks/MCP 配置不能改变 Stage B 的执行策略；`bypassPermissions` 不进入可选 mode；Claude 的内部 Agent/Task subagent 路径被禁用。文件写边界仍由外层 bubblewrap 而不是 ACP mode/permission label 决定。

## OpenCode 同步 hardening

OpenCode 不再把整个宿主 `auth.json` 暂存进 sandbox。只提取所选 `provider/model` 对应的 provider credential entry；项目 provider JSONC 也只提取所选 provider/model，`apiKey` 可以来自 provider config 或独立 auth store。其它 provider secret 不进入 run scratch。

外部 `opencode` executable 还会校验为可执行常规文件、不可 group/world-write、owner 为 root 或当前用户，并拒绝来自 source worktree、dedicated worktree、Golden root、`/tmp` 或 `/var/tmp` 的 PATH binary。这样项目不能通过修改 PATH 把自己的假 `opencode` 注入 Stage B。

## 非计费验证

required CI 对 hardening 分支执行：

- `npm run check`
- `npm run build`
- `npm run test:sandbox:required`
- `npm test`

新增测试覆盖 Claude relay 的 auth header 替换、model/path pinning、query 拒绝、custom-header 保护、跨 chunk secret 回显脱敏、缺少凭据 fail-closed，以及实际 bwrap argv/env 中不出现宿主 Claude secret、宿主代理不被传入、Claude unsafe session feature 被锁定。OpenCode 测试覆盖 selected-provider credential isolation 和 project-PATH binary 拒绝。

## 真实 provider 验收

`tests/real-acp.builtins.integration.ts` 现在可以单独只跑 Claude：

```bash
PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 \
PI_PLAN_EXECUTE_ACP_TEST_CLAUDE_MODEL=claude/<model> \
npm run test:acp:claude:required
```

它包含三项 billable gate：真实 sandboxed Executor、真实 sandboxed Reviewer、完整单阶段 Stage B（包括 acceptance 与插件-owned phase commit）。完整 workflow 还断言 Executor/Reviewer session id 不同。

仓库增加了手工 `workflow_dispatch` 的 Claude ACP integration workflow；它只从 GitHub protected secrets 读取宿主 Claude credential，不会把 secret 写入 repo 或 sandbox。本轮本机使用真实认证环境运行三项 Claude 测试结果 **0/3**：`claude/sonnet` 收到 `model_not_found`；当前自定义上游为非 loopback HTTP，新增安全修复会在启动前拒绝。代码修复仍未提交，详细证据在 [`review-round-09.md`](../review-round-09.md)，不能称作四端验收通过。

## 尚未消除的边界

**ACP actor 的任意网络 egress 仍未由内核限制为 provider-only。** Claude relay解决的是 credential non-disclosure 和 provider API pinning，不是 Bash/curl 等 agent tool 的通用 egress firewall。Stage B 因此仍要求 per-project 网络风险同意，且当前不得宣称适用于敏感仓库。Acceptance shell 已使用独立 network namespace，这一限制只针对需要 provider 网络的 ACP actors。

在 provider-only egress 有 OS 级实现之前，安全结论应保持：filesystem + credential isolation 已强制，ACP arbitrary network egress 仍是已知显式风险。
