# Claude 与四端统一接入：凭据边界调研（尚未实施新通道）

## 已核实的事实

- 本项目安装的 `@automatalabs/acp-agents@3.3.0` 把 `claude` 列为内置后端，借助 `@agentclientprotocol/claude-agent-acp@0.79.0`（Claude Agent SDK）启动 ACP。`claude/sonnet` 是 AgentPrism 支持的路由；缺的不是 AgentPrism Claude adapter。
- 当前宿主 `claude -p --model sonnet` 真请求返回 `OK`；当前进程设置了 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`（未读取/输出值）。在独立 HOME/配置目录中移除前者，`claude auth status` 从 `loggedIn: true` 变为 false。宿主成功因此不能证明其具有可独立转移的登录凭据或访问默认 Anthropic 端点。沙箱所检查的 `~/.claude/.credentials.json` 不存在。
- `src/sandbox.ts` 的 `--clearenv` 不转发宿主令牌、端点或整个 Claude 配置。Claude 真正的三项隔离测试目前 **0/3**，都在启动前因没有安全的独立凭据而拒绝；尚无沙箱 Claude provider 请求。Pi (`pi/openai-codex/gpt-5.5`) **3/3**，Codex/OpenCode 指定路由 **3/3**，不能把不同提供方或模型当作 Claude 的静默替代。
- AgentPrism 的 `onAuth` / `AuthStore` 提供 `env` 和 ACP gateway `_meta` 凭据接口，后者不是秘密隔离。已安装 Claude ACP 的 `createEnvForProvider()` 将 gateway headers 组装到 `ANTHROPIC_CUSTOM_HEADERS`，并把 provider env 同时写到 Claude SDK 的 subprocess `env` 与 settings `env`；把真实 `Authorization` header 放在 ACP gateway `_meta` 仍会使秘密进入模型可能调用内部文件/执行工具的子进程环境。内存 AuthStore 的日志脱敏不能取代 OS 不可达证明。见 `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`（`authenticate`、`createEnvForProvider`、`session/query`）及 `node_modules/@automatalabs/acp-agents/dist/auth/auth-types.d.ts`。
- `clientHandlers` 只接管 ACP agent 主动委托给客户端的 fs/terminal 请求；AgentPrism 文档明确说明 agent 默认使用自身的内部文件/执行工具。因此配置客户端 permission deny、仅清理工具子进程 env、或使用文件描述符传令牌，都**未经证明**能阻止内部工具通过继承环境或 `/proc` 读取父进程秘密。不能作为现成修复。

## 方案比较

| 方案 | 是否保留 Claude ACP 后端 | 当前判断 |
| --- | --- | --- |
| 用户自行完成独立 CLI 登录，且有安全可暂存的凭据文件 | 是 | 最小改动；只有该凭据在隔离 Claude ACP 中实际可用且首次模型请求前能安全移除磁盘副本才可判通过。目前宿主使用环境令牌，条件不满足。登录文件是否由当前 CLI 生成、删除时机是否影响后续请求，均须真实测试。 |
| 直接向 Claude ACP / SDK 转发 `ANTHROPIC_AUTH_TOKEN` 或真实 gateway headers（包括 AgentPrism `onAuth` / gateway `_meta`） | 是 | **拒绝**：adapter 最终把秘密传到 SDK env/settings，不能证明模型可调用的内部 Bash/Read/子 agent 不可见。只用于非敏感仓库的网络风险同意，不是凭据泄露同意。 |
| **可信宿主侧凭据注入代理**（建议为当前环境令牌模式设计） | 是 | 可行的研究方向，**未实施、未验收**。宿主可信进程独占读取现有令牌及原有 endpoint；Claude ACP 沙箱只见不含凭据的本地代理地址和无效占位认证值，宿主代理向固定批准的上游注入真实认证。不能直接把真实 headers 交给 AgentPrism gateway auth。需要严格 OS/协议边界及合成+真实 ACP 测试，不能现在宣称成功。 |
| 使用 Pi/OpenCode 的 Anthropic 模型作为 `pi/...` / `opencode/...` | 否 | 或能调用相同模型家族，但执行器、权限/工具及登录语义均非 Claude Code ACP；仅在用户明确选择该路由且真实测试通过时可用，不算 Claude 后端验收。 |

## 建议的宿主凭据代理验收门槛

1. 插件仅由可信宿主侧代码读取认证环境，**不在命令行、文件、ACP `_meta`、子进程 env、MCP 参数、报告、日志中携带真实秘密**。代理进程位于 ACP PID/挂载命名空间之外；只为获批准的仓库、run、backend、上游 origin 和模型绑定；项目可编辑缓存不能更换目标或授予同意。没有相应人类网络风险同意则拒绝。
2. 沙箱内只看到固定本地端点、非敏感占位凭据；代理只允许固定 Anthropic-compatible API 路径/方法，限定请求大小、并发、超时、速率和重定向；拒绝任意 URL、HTTP CONNECT、带密钥的重定向/响应头、来自沙箱的认证头透传。正确处理 SSE streaming、中断与代理 HTTP(S) 出口。令牌仅在可信宿主请求上游时注入，不通过返回值反射。模型工具仍可向这个受限代理发起可能计费的请求：不是模型用量或 ACP 网络出口隔离，应明确提示人类。
3. 上游 endpoint 必须由用户拥有的配置与独立批准记录确定；不可静默从定制 gateway 切回默认 Anthropic、改路由、换模型或降思考强度。测试精确请求 model 字段和 ACP 公告的选定值；上游内部重新映射模型若不可验证，则须如实标注。凭据从宿主环境消失、代理退出、恢复时须 fail closed，并清理监听端点。
4. 先在合成仓库用**假令牌/假上游**证明：模型可执行 Bash/Read、读 `/proc`、跟随链接、读取 env/FD、向代理发送畸形路径、重定向、重复/大请求和取消时不能获得假令牌或宿主文件；检查进程死后无监听者/磁盘副本，再经单独批准做可能计费的 Claude Executor、Reviewer、完整阶段真实测试。任何失败不降级/不宣称四端通过。

## 结论

**统一接入可在架构上实现，但目前仅有三个精确路由完成隔离验收。** 若目标是继续使用现有环境令牌加定制 endpoint，同时保留 Claude Code ACP 和现有凭据安全约束，可信宿主侧受限凭据代理是最有希望的方向；这是设计提案，不是已经通过的修复。实现和真实计费测试前，应先就代理的额外网络/用量风险取得明确批准。
