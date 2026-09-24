# 第九轮独立审查：`claude-safe-acp` 真实接入验收

> **后续语义更正：** 本轮原始审查把 `claude/sonnet` 误解释为“底层必须是 Anthropic Sonnet family”。该判断已被后续复核推翻。这里的 `claude` 是 CLI/harness，`sonnet` 是 Claude Code 的逻辑模型选择器；可信宿主通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` 等把该 alias 映射到第三方 gateway model（例如 `deepseek-flash[1m]`）属于 Claude Code 官方支持的配置语义。以下原始记录保留用于审计时间线，以文末“复核后的代码修复”为当前结论。

基线：当前分支 `claude-safe-acp`，审查时 HEAD `0a843e0`，相对 `main` 为 `e6e107b`、`6ba84a7`、`162ca99`、`0a843e0` 四个提交。审查开始时工作区干净。此次修复在工作区、**尚未提交**：`src/claude-relay.ts`、`tests/claude-relay.test.ts`；既有第一至第八轮证据未改写。所有实时测试都在自动清理的合成 Git 仓库及可信 `/usr/bin/bwrap` 上进行，不输出认证变量、凭据或上游地址。

## 实现检查

- 确已实现宿主 loopback relay：真实认证留在宿主进程；Claude ACP 沙箱只收到非真实 token 与随机 capability URL，采用 `--clearenv`；路由限定 POST `/v1/messages` 或 `/v1/messages/count_tokens`，请求 model 按 route 检查。AgentPrism custom backend 的 Claude sessionMeta 禁用 settings 来源、危险权限模式及若干内部工具。**这只证明实现存在，不证明真实 provider 成功，也不实现 ACP actor 的 OS 网络出口限制。**
- OpenCode 同时增加所选 provider 凭据摘取及可执行文件/父目录权限校验。新增手工 Claude workflow 仅声明可执行；本轮未在 GitHub 上运行。

## 独立测试与复现

1. `npm run check`、`npm run build`、`npm test` **76/76，0 skip**；`npm run test:sandbox:required` **11/11，0 skip**，使用 root-owned `/usr/bin/bwrap`。这些结果**不是** Claude provider 成功。
2. 在用户同类的交互式 shell 环境（宿主已设置 Claude 认证/自定义端点，变量值未输出）运行 `npm run test:acp:claude:required`，模型保持 `claude/sonnet`，思考 `high`：真实 ACP Executor、Reviewer、完整单阶段流程 **0/3**；前两项收到 `AGENT_EXECUTION_ERROR`，`errorKind=model_not_found`，完整阶段未完成。ACP 已到达请求错误阶段，但没有有效的模型响应、独立审查或 phase commit。**不得把宿主 `claude -p` 的 `OK` 当成此测试通过。**
3. 宿主环境的 `ANTHROPIC_DEFAULT_SONNET_MODEL` 与 `ANTHROPIC_MODEL` 都指向 **`deepseek-flash[1m]`**，而测试选的是 `claude/sonnet`。隔离 Claude ACP 目录探针返回 5 项、其中 `claude/sonnet` 和 `claude/sonnet[1m]` 可见，**不含 DeepSeek**。把路线静默改成 DeepSeek 违反已批准的模型路由，且目录缺失不能证明直接输入该 model 可用；未做此替换。自定义 gateway 当前也未证明能服务实际 Claude Sonnet 模型。
4. 用**假 token 和假上游**独立复现：原 relay 在上游把 token 放入任意非认证响应头时，会将该头原样交给沙箱，尽管原测试只覆盖 `authorization` 与同名自定义 header。已在未提交工作区中为 `safeResponseHeaders` 增加响应头白名单及密钥内容检查，并补充同名、异名、`location` 和 `request-id` 回显回归。`tests/claude-relay.test.ts` **3/3**，静态/沙箱测试仍通过。不能凭精确字节屏蔽推断恶意上游绝不可能通过转码泄露，必须信任被批准的上游。
5. 当前宿主 `ANTHROPIC_BASE_URL` 为 **HTTP、非 loopback**（不输出目标地址）。原 relay 会向该地址发送真实宿主认证；为避免明文外传，未提交修复改为拒绝向非 loopback HTTP 上游注入凭据，并增加单元测试。修复后的真实 Claude Executor 单项 **0/1**、在启动前按预期明确拒绝该不安全地址；未重跑会被相同边界拒绝的另外两项。前述 0/3 是保护修复之前的实际测试，不得混作修复后通过。当前环境要真实接入，必须使用经批准的 HTTPS 或 loopback 上游，并确保**用户批准的精确 model** 在该上游可用。
6. OpenCode/Codex 原路径回归：`npm run test:acp:required` **1/3**，Codex Reviewer 通过，OpenCode Executor 和完整阶段被新二进制权限校验阻断：安装路径 `/home/zyq/.opencode/` 与 `bin/` 均为 775。没有自动更改用户目录权限。为了区分实现回归与本机安装权限，**临时复制同一 OpenCode 可执行文件到项目之外的私有 0700 目录**，仅对该次测试把目录置于 PATH 首位，测试后删除：OpenCode Executor 与完整阶段 **2/2** 通过（其余独立 Reviewer 单项未在该次重跑）。这不意味着默认安装路径现已通过。

## 结论与剩余动作

**Claude 四端整体验收 FAIL。** 当前实现的沙箱/relay 可启动并返回真实 provider 错误，但 `claude/sonnet` 在现用自定义 gateway 上 `model_not_found`；凭据中转的原实现还存在已复现的响应头泄露及非 loopback HTTP 明文传输风险，两项已在工作区修复但未提交。不得静默把 Sonnet 换成 `deepseek-flash[1m]` 或降低 `high`。后续需由用户明确批准实际 gateway + 模型的精确路由，配置安全上游传输，再以安全修复后的代码重跑 Claude Executor、Reviewer、完整阶段 **3/3**；OpenCode 默认安装路径的权限/信任问题也需单独解决。ACP 任意网络出口仍未受供应商专用 OS 限制，不适用于敏感仓库。


## 复核后的代码修复

后续复核确认并区分了三类问题：

1. **确认的 Claude relay 安全漏洞**：任意上游响应头可以换名回显宿主 secret；非 loopback 明文 HTTP upstream 会接收真实宿主认证。这两项均为真实缺陷。响应头白名单/secret 内容过滤以及非 loopback HTTP 拒绝已经提交，且 required CI 通过。
2. **确认的 OpenCode WSL 兼容回归**：把当前用户自有的 0775 父目录一律视为不可信，会误拒绝常见 umask 0002 安装。现在仍要求实际 executable 本身不可 group/world-write，并继续拒绝 project/worktree/Golden/temp、world-writable、foreign-owned 路径；仅允许由当前可信 OS 用户拥有的 group-writable 父目录。新增 0775 用户安装回归测试。
3. **确认的 Claude CLI 模型映射兼容回归**：此前修复把 `claude/sonnet` 当成了“底层必须是 Sonnet”，并用 `settings.availableModels=["sonnet"]` 锁住 picker；这会按 Claude Code 自身规则阻止 `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]` 这样的合法 alias mapping。现在撤销该错误限制，并只从可信宿主复制经过校验的非秘密模型路由变量（`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL`、custom-model metadata，以及仅保留 `modelOverrides` / `availableModels` 的 `CLAUDE_MODEL_CONFIG`）。真实 credential、base URL、custom request headers、proxy 和其它环境变量仍不进入 sandbox。relay 的 model gate 同时接受逻辑 selector 的标准解析和宿主明确配置的 alias target，仍拒绝无关 model。

复核还发现 relay capability 仅靠 URL path 不足：完整 Claude agent 需要 Bash，而命令工具若能直连 loopback relay，就可能绕过正常 ACP turn 发原始 provider 请求。因此 relay 现在额外要求每 run 随机 bearer capability；Claude session 同时强制 command sandbox `enabled + failIfUnavailable + allowUnsandboxedCommands=false`，严格空网络 allowlist，并从命令环境拒绝 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`。Claude 主进程仍是完整独立 ACP/CLI 会话并能访问 relay，限制只作用于其 shell/command 子进程。

Linux/WSL 的 Claude command-network sandbox 依赖可信系统 `bubblewrap` 与 `socat`；缺少 `/usr/bin/socat` 时 Claude provider session 现在启动前 fail closed。真实 Claude 3/3 仍需在 **HTTPS 或 loopback upstream**、用户明确批准的 Claude CLI model selector（以及当时可信宿主的 model mapping）、安装了 `bubblewrap + socat` 的环境重新执行后才能更新为通过。
