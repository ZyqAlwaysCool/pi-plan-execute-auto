# pi-plan-execute-auto

## Pi Native 跨 Harness 分阶段研发工作流插件设计方案与可行性评估说明

**插件名称**

```text
pi-plan-execute-auto
```

为避免与其他通用工作流扩展冲突，本插件统一使用具有辨识度的命令前缀：

```text
/plan-execute
```

主 Pi Agent 可调用的工具使用对应名称：

```text
plan_execute_finalize
```

**文档目的**

本文用于让主 Pi Agent 理解并审查 `pi-plan-execute-auto` 研发自动化插件方案。

请不要默认本文中的架构选择一定正确。评审重点是：

1. Pi Extension API 是否足够支撑该设计。
2. AgentPrism Workflows 是否可以直接复用来完成 Stage B。
3. `pi-harness-delegate` 中哪些能力值得直接复用或借鉴。
4. 哪些需求现有项目尚未满足。
5. 是否存在更简单、复用程度更高的实现方式。
6. 只有在现有能力明确不足时，才建议自行实现新的基础设施。

---

# 1. 背景与核心需求

目标是解决复杂研发任务中多 Coding Agent CLI 之间的自动协作问题。

当前人工流程大致分成两个阶段。

## Stage A：人类与强模型共同规划

Human 与主 Pi Agent 持续进行多轮讨论：

```text
Human <------> Main Pi Agent
```

讨论内容包括：

* 需求澄清；
* 项目代码调查；
* 技术方案；
* 架构选择；
* 实施阶段划分；
* 测试方案；
* 每阶段验收标准。

这里必须保留 Human-in-the-loop。

主 Pi Agent 是用户的主要研发伙伴，不是 Stage B 中某个执行 Agent 的“上级 Agent”。

更准确的关系是：

```text
Human <------> Main Pi Agent
```

两者共同完成规划。

安装时优先通过 Pi 官方包命令 `pi install -l <本插件目录>` 将当前源码包声明到测试项目；`pi list` 应显示该包。交互式首次运行使用 `/plan-execute setup`：启动时检查是否在 Git 仓库根目录；若当前目录没有仓库，先在 Pi UI 询问并仅经显式选择才 `git init`，若在现有仓库的子目录则提示回根目录，绝不自动创建嵌套仓库。可以另经独立确认创建不包含用户文件的空基线提交；不自动 add/commit 用户文件，真正执行仍要求现有 HEAD 和干净源工作区。之后插件探测可用的 Claude、Codex、OpenCode、Pi CLI；模型候选来自 CLI 或独立临时仓库中的沙箱只读 ACP 会话，所有模型发现都发生在网络风险预确认后。通过 Pi UI 由人类分别选择 Executor、Reviewer、以及双方选定模型都实际公告的 `low` / `medium` / `high` / `max` 档位（或 backend default），并单独确认项目的 ACP 网络风险。候选清单不等于真实模型调用成功；沙箱 ACP session 必须在执行前核实所选模型及强度，真实测试状态见 README。非敏感选择缓存在项目 `.pi-plan-execute-auto/config.json`；项目文件可被模型更改，所以批准指纹与网络同意仍保留在用户 Pi 目录并按项目真实路径和 `.git` 身份绑定。缓存变更不能替代用户重新批准；冻结后该 run 的选择不得被新的 setup 静默替换。无交互 CI 才使用显式环境变量回退。ACP 仍共享宿主网络，配置向导只是非敏感仓库的风险确认，不能替代网络隔离。

## 1.1 不可放宽的工作流约束

以下约束属于 `pi-plan-execute-auto` 的业务合同，不是可选优化：

1. Stage A 的产出必须被划分为一个或多个有序 phase；不允许生成没有 phase 的平面执行计划。
2. 每个 phase 必须有独立的实施说明和验收合同。
3. Executor 每一轮只能围绕当前 phase 实施，并必须执行该 phase 的独立自测。
4. Reviewer 每一轮只能对当前 phase 做独立审查；审查输入必须包含该 phase 的基线 commit、实际 diff、源码、自测和验收合同。
5. Reviewer `PASS` 且确定性验收通过后，必须为该 phase 主动创建一个 commit。
6. phase commit 创建并记录成功前，不得进入下一 phase。
7. REWORK 中间轮次不得被当作 phase 完成，也不得生成“完成 commit”。

---

# 2. Stage A 的最终产物

用户确认方案已经成熟以后，主动触发 Stage A Finalization。

例如：

```text
/plan-execute
```

`/plan-execute finalize` 是同义命令。无参数命令只要求主 Pi 基于当前对话生成待审阅的 Golden Package，不跳过人类审批，也不直接允许模型自选 ACP 配置。

或者主 Pi Agent 调用插件注册的：

```text
plan_execute_finalize
```

此时主 Pi Agent 根据完整讨论上下文生成一个 **Golden Document Package**。

关键原则：

> 用户在任务开始时不需要提前知道应该有哪些说明文档，但最终执行计划必须包含至少一个明确的 phase。

不同任务需要的辅助文档可能完全不同，但 phase 结构是硬性合同。

例如大型架构迁移可能生成：

```text
.pi-plan-execute-auto/<run-id>/

manifest.yaml
architecture.md
decisions.md
migration.md

phases/
  phase-01.md
  phase-02.md
  phase-03.md

acceptance/
  phase-01.yaml
  phase-02.yaml
  phase-03.yaml
```

一个规模较小的功能仍然必须至少有一个 phase：

```text
.pi-plan-execute-auto/<run-id>/

manifest.yaml
implementation.md

phases/
  phase-01.md

acceptance/
  phase-01.yaml
```

因此插件不应该硬编码：

```text
architecture.md 必须存在
migration.md 必须存在
...
```

但必须硬性要求：

```text
phases 至少包含一项
每个 phase 都有独立 spec
每个 phase 都有独立 acceptance contract
phase 顺序明确且 id 唯一
```

主 Pi Agent 必须生成一个自描述的：

```text
manifest.yaml
```

它描述本任务实际生成了什么，以及完整、有序的阶段结构。

---

# 3. Stage A Package Contract

`manifest.yaml` 是机器读取 Stage A 结果的入口。

概念示例：

```yaml
version: 1

documents:
  - id: architecture
    path: architecture.md
    purpose: architecture decisions

  - id: migration
    path: migration.md
    purpose: migration strategy

phases:
  - id: phase-01
    order: 1
    spec: phases/phase-01.md
    acceptance: acceptance/phase-01.yaml
    commit:
      required: true
      message: "pi-plan-execute-auto: complete phase-01"

  - id: phase-02
    order: 2
    spec: phases/phase-02.md
    acceptance: acceptance/phase-02.yaml
    commit:
      required: true
      message: "pi-plan-execute-auto: complete phase-02"
```

每个 phase 的 acceptance contract 还应至少能机器读取以下信息：

```yaml
version: 1
phase_id: phase-01

scope:
  allowed_paths:
    - src/auth/**
    - test/auth/**

self_tests:
  - id: auth-unit
    command: npm test -- auth
    required: true

review:
  require_no_blocking_findings: true

commit:
  required: true
  allow_empty: false
```

`self_tests` 是 Executor 每轮都必须执行的当前阶段自测；插件在 Reviewer `PASS` 后还要独立重跑 required commands，不能只信任 Executor 报告。Executor 的自测和插件重跑的 acceptance shell 都必须在专用 OS sandbox 中运行：仅允许专用 worktree 的写入和 run-private scratch；Golden Package 只读，source worktree、共享 Git 管理目录及其他宿主路径不可见。插件重跑的 acceptance shell 使用隔离的 network namespace，不允许访问宿主 TCP 服务或互联网；需要联网的 acceptance 合同当前必须暂停并重新设计受控测试服务，不能降级到宿主网络执行。ACP Actor 为调用模型供应商仍使用宿主 network namespace，其工具任意外传工作区内容的剩余风险必须作为敏感仓库的禁用条件，直至部署 OS 强制的供应商出口隔离。默认不启动 ACP：非敏感仓库的管理员必须显式设置 `PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1` 才能启用，这仅是风险确认，不能当成网络隔离。验收合同的人工审批不授予命令任意修改宿主文件的权限。

这里：

```text
Stage A Documents
```

才是真正的金标准。

`manifest.yaml` 是：

```text
Document Package Index / Contract
```

而不是对原始方案的替代。

---

# 4. Stage A Finalization Loop

Stage A 不应该是：

```text
讨论
→ AI 写文件
→ 直接进入 Stage B
```

应该存在一个很小的校验循环：

```text
Human + Main Pi
        ↓
Finalize
        ↓
Main Pi 生成 Docs Package
        ↓
Plugin Structural Validator
        ↓
        ├── PASS
        │     ↓
        │  Human Approval
        │     ↓
        │   Freeze
        │
        └── FAIL
              ↓
     Validation Errors
              ↓
        Main Pi Same Session
              ↓
          修复文档
              ↓
         再次 Validation
```

Pi Extension 原生支持向当前主 Session 注入消息，并触发新的 Agent turn，因此 Validator 错误可以重新反馈给同一个 Main Pi Agent，而不需要创建另外一个 Planner Agent。`pi.sendMessage()` 可以把扩展消息注入主会话上下文，并在 agent idle 时通过 `triggerTurn` 触发继续处理。Pi Extension 同时支持 commands、tools、自定义 TUI 和持久化 extension state。

---

# 5. Stage A Validator 的职责边界

Validator **只验证机器可确定的事实**。

例如：

```text
manifest 是否合法
引用文件是否存在
phases 是否至少包含一项
phase id 是否重复
phase order 是否唯一、连续且确定
每个 phase spec 是否存在
每个 phase acceptance 是否存在
每个 phase 是否要求完成 commit
引用路径是否合法
YAML / JSON 是否能解析
必填结构是否完整
```

Validator 不应该判断：

```text
架构设计是否优秀
方案是否最优
技术选型是否正确
```

这些仍然属于：

```text
Human + Main Pi Agent
```

Stage A 最终只有用户显式确认后才能冻结。

---

# 6. Stage A 冻结以后不再 Replan

当前版本明确不设计：

```text
REPLAN
REPLAN_REVIEWER
自动修改计划
```

Stage A 一旦：

```text
Human Approved
```

则 Document Package 被冻结。

Stage B 只能：

```text
EXECUTE
REVIEW
REWORK
PASS
NEXT PHASE
```

不能修改原始执行计划。

如果 Stage B 长时间无法闭环，则回报 Main Pi Agent，由 Main Pi Agent 与 Human 决定后续如何处理。

---

# 7. Stage B 总体模型

目标关系：

```text
Human <------> Main Pi Agent
                    ^
                    |
                 Plugin
                    |
          +---------+---------+
          |                   |
     Executor Agent      Reviewer Agent
          |                   |
     own harness           own harness
     own session           own session
     own tools             own tools
```

需要特别明确：

> Executor 和 Reviewer 不是 Main Pi Agent 的传统 subagent。

它们可能分别运行：

```text
OpenCode
Codex
Claude Code
Pi
其他 ACP Harness
```

每一个都是完整、独立的 Coding Agent Harness：

* 独立 Session；
* 独立 context；
* 独立 tools；
* 独立 permission；
* 独立终端生命周期。

插件只是负责协调它们。

因此建议术语使用：

```text
External Agent Harness
```

或者：

```text
Agent Runtime
```

而不是统一称为 subagent。

---

# 8. Stage B 核心循环

Stage B 必须严格串行执行 manifest 中的有序 phases。每个 phase 都是独立的实施、验证、审查和提交单元。

对于每一个 phase：

```text
Phase N
   ↓
Record Phase Base Commit
   ↓
Executor — Current Phase Only
   ↓
Implement
   ↓
Phase-specific Self Test
   ↓
Structured Execution Report
   ↓
Deterministic Validator
   ↓
Reviewer — Current Phase Only
   ↓
Independent Review of Current Phase Diff
   ↓
Structured Review Report
   ↓
   ├── PASS
   │     ↓
   │  Re-run Deterministic Acceptance
   │     ↓
   │  Plugin-owned Phase Commit
   │     ↓
   │  Record Commit SHA
   │     ↓
   │  Next Phase
   │
   └── REWORK
         ↓
   Feedback to Same Executor Session
         ↓
   Same Phase Continue
         ↓
   Phase-specific Self Test
         ↓
      Reviewer
```

每轮 Executor 都必须：

```text
只实现 Current Phase Spec
从当前 phase 的 base commit 和已有工作区状态继续
运行 Current Phase Acceptance Contract 要求的自测
返回带 phase_id 和 round 的结构化报告
不得提前实现后续 phase
不得自行创建 phase 完成 commit
```

每轮 Reviewer 都必须：

```text
只审核当前 phase 的交付范围
以该 phase 的 base commit 为 diff 基线
独立读取源码、测试和实际工作区
独立核验 Executor 的自测证据
检查是否误改 Golden Docs 或提前实现后续 phase
返回带 phase_id 和 round 的 PASS / REWORK 报告
不得修改工作区或创建 commit
```

Reviewer 不允许只根据 Executor 的自述做审查。Reviewer 至少应该自己读取：

```text
Frozen Golden Docs
Current Phase Spec
Current Phase Acceptance Contract
Phase Base Commit
Actual Workspace
Git Diff from <phase-base-commit> to current working tree
Relevant Source
Tests
Current Phase Execution Reports
Current Phase Previous Findings
```

Reviewer 必须自行运行只读 `git status` / `git diff <phase-base-commit>`，并检查插件提供的完整 canonical patch 与 SHA-256。为满足这一要求又不暴露共享 Git 管理目录，OS sandbox 为每个 Actor、Reviewer 和 acceptance 命令建立 run-private 的只读浅 Git 镜像：只包含当前 phase base commit 及其 tree/blob 对象，不包含早期 history、其他 refs 或可写的 shared gitdir/index。工作区内 `.git` 指针在 sandbox 中指向该镜像；Git metadata 以只读挂载呈现，Reviewer 可以独立核验 baseline/diff，但不能 stage、commit 或修改宿主 Git 元数据。插件仍在宿主侧从真实 Git worktree 生成 canonical diff，并在 Reviewer 后、提交前重算并核对同一 diff hash；镜像不能替代插件的提交证据验证。

并可以自行运行允许的验证命令。

## 8.1 Phase Commit Contract

phase commit 是阶段完成的硬性边界，建议由插件在 Reviewer `PASS` 后统一创建，而不是交给 Executor 或 Reviewer 自由执行。

提交前插件必须：

```text
确认 Reviewer verdict == PASS
重新运行确定性 acceptance commands
确认 Golden Document Package 哈希未变化
确认 HEAD 仍等于当前 phase 的 base commit
确认变更属于当前 phase
排除插件 runtime artifacts
记录最终 git diff 和测试结果
```

然后插件主动执行一次提交，例如：

```text
git add -- <validated phase paths>
git commit -m "pi-plan-execute-auto: complete phase-01"
```

提交成功后持久化：

```text
phase_id
base_commit_sha
phase_commit_sha
review_rounds
execution_report
review_report
acceptance_results
```

只有 `phase_commit_sha` 已成功写入工作流状态后，phase 才能标记为完成并进入下一阶段。

安全约束：

```text
Executor / Reviewer 在 phase 循环中不得改变 HEAD
如果 Harness 擅自提交，插件必须暂停并升级到 Main Pi，不得自动 reset 或改写历史
如果提交失败，phase 保持未完成并暂停
默认要求 Stage B 使用干净的专用 branch/worktree
每个 phase 正常情况下恰好产生一个完成 commit
```

如果某个合法 phase 没有文件变化，但合同仍要求阶段提交，应在 manifest 中显式声明是否允许 empty commit；不得由插件静默推断。

---

# 9. Loop Breaker

一个 phase 不能无限：

```text
EXECUTE → REVIEW → EXECUTE → REVIEW
```

配置例如：

```yaml
max_review_rounds: 3
```

达到阈值以后插件停止自动执行。该 phase 不得创建完成 commit，也不得进入下一 phase。

不是自动修改计划。

而是：

```text
Plugin
  ↓
Workflow Suspended
  ↓
Status Summary
  ↓
Main Pi Session
```

插件把当前状态注入 Main Pi：

```text
phase-03 在 3 轮 review 后仍未通过。

仍存在：
R003 ...
R006 ...

Executor session:
...

Reviewer reports:
...

请分析后决定下一步，必要时要求人工确认。
```

然后：

```text
Human <------> Main Pi
```

重新进入人工判断。

---

# 10. 为什么优先复用 AgentPrism Workflows

AgentPrism Workflows 已经提供：

```text
agent()
gate()
parallel()
pipeline()
phase()
checkpoint()
retry()
verify()
```

并直接驱动真实：

```text
Claude Code
Codex
OpenCode
Pi
Custom ACP Agent
```

其 `agent()` 使用实际 coding harness，而不是重新实现模型 agent loop；每个 backend 保留自己的 tools、permission、session 和 context management。

它已经提供：

```text
ACP runtime
backend routing
structured output
JSON Schema validation
structured-output repair
timeouts
retry
permission handling
journaling
workflow resume
worktree isolation
workflow validation
live agent events
```

这些全部属于我们不应该重新实现的基础设施。

因此初始原则应是：

> Stage B 优先基于 `@automatalabs/workflows` SDK 实现。

而不是自行维护：

```text
Codex CLI parser
OpenCode JSONL parser
Claude Code parser
ACP client
Session manager
Permission broker
Crash journal
Structured output repair
```

---

# 11. AgentPrism `gate()` 与需求高度接近

AgentPrism 官方示例明确支持：

```text
实现阶段
→ reviewer 验证
→ reviewer feedback
→ fix loop
→ green
```

`gate()` 就是针对 producer/validator feedback loop 的工作流 primitive。

因此我们的 Stage B 很可能可以表达为：

```text
for each phase:
    executor
    reviewer
    gate until pass
```

这意味着：

> 不应该自行开发一个新的通用 State Machine Engine。

---

# 12. AgentPrism 当前最重要的待验证缺口：Same Executor Session

这里存在一个不能忽略的差异。

AgentPrism 当前对 `gate()` 的描述是：

```text
reviewer feedback threaded into fresh attempts
```

也就是说下一次 producer attempt 默认是新的 agent call。

但当前设计希望：

```text
Executor Round 1
       ↓
Reviewer REWORK
       ↓
Executor Round 2
```

尽可能继续：

```text
同一个 Executor Harness Session
```

因为原 Executor 已经理解当前 phase、代码状态和之前的实现过程。

AgentPrism 确实支持持久 Agent Session：

```text
keepSession: true
```

成功的 Agent Session 可以被 host 重新 attach；其 REPL 路径甚至支持保留 agent handle，并通过 `queue()` 在同一个 session 上创建后续 turn。

但是：

> 目前不能直接假设 `gate()` 会自动把下一轮 producer 放回同一个 executor session。

这是整个技术方案当前**最需要 PoC 验证的点**。

优先评估以下方式，按复用程度排序：

```text
A. AgentPrism 是否已有 gate/session 组合方式可以直接实现

B. 使用 WorkflowManager / lower-level runner
   在 host 层重新 attach session

C. 使用 AgentPrism REPL persistent agent handle + queue()
   实现 executor/reviewer loop

D. 只有前三种均不满足时，
   才自己编写极薄的 loop controller
```

禁止在没有验证 A/B/C 前重新实现 Agent Runtime。

---

# 13. `pi-harness-delegate` 的定位

`pi-harness-delegate` 已经是成熟的 Pi-native cross-harness delegation extension。

它支持当前多个真实 harness，包括 Codex、OpenCode、Claude Code 等，并完成了：

```text
harness detection
normalized permissions
machine-readable CLI / ACP transport
session id
resume
transcript
cancel
usage metrics
live TUI activity
verify command
```

例如 Codex 使用 `codex exec --json`，OpenCode 可以使用 `run --format json` 或 ACP；每次执行记录 session ID，并允许后续 resume。

这证明：

> Pi Extension → External Harness

这种架构已经被实践验证。

---

# 14. 为什么不建议直接以 pi-harness-delegate 为 Stage B Engine

它的核心抽象更接近：

```text
delegate one task
→ one external harness
→ result
```

而我们的 Stage B 核心是：

```text
phase lifecycle
+
executor/reviewer loop
+
structured contracts
+
round control
+
workflow persistence
```

如果完全建立在 `delegate()` 上，仍然需要自行开发较多 workflow orchestration 基础能力。

而 AgentPrism 已经有现成：

```text
gate
journal
resume
structured output
ACP runtime
workflow validation
```

因此当前建议：

```text
AgentPrism
= runtime/workflow dependency

pi-harness-delegate
= Pi UX 和 harness integration 参考实现
```

避免同时维护两个 competing runtime layers。

---

# 15. pi-harness-delegate 中值得直接借鉴的资产

主要参考：

```text
Harness autodetection
Permission normalization
Pi command design
Live activity rendering
Cancel UX
Transcript UX
Usage metrics
Configuration conventions
Danger-mode presentation
```

尤其是：

```text
readonly
edit
danger
```

这一层统一 permission 心智模型非常适合我们的 TUI。

不要重新设计五套 Vendor-specific permission UI。

---

# 16. Pi Extension 自身负责什么

建议插件本身保持薄。

主要负责：

```text
Stage A Finalization integration

Document Package validator

Human approval / freeze

Stage A → Stage B handoff

Stage B Workflow configuration

AgentPrism lifecycle integration

Status projection into Pi TUI

Loop threshold escalation to Main Pi
```

不负责：

```text
ACP protocol implementation
Codex/OpenCode/Claude transport
Generic agent runtime
Session protocol
Structured-output transport
Workflow journal
Generic retry engine
Generic permission protocol
```

这些优先使用 AgentPrism。

---

# 17. Main Pi 如何知道插件存在

Pi Extension 可以注册一个自定义 tool，并通过 `promptSnippet` / `promptGuidelines` 把工具用途加入主 Pi system prompt。

因此可以让 Main Pi 从会话开始就知道：

```text
plan_execute_finalize:
当用户明确确认复杂研发方案已经定稿时，
使用此工具整理并验证 pi-plan-execute-auto 的分阶段 Stage A Document Package。
```

Pi Extension 官方支持动态注册 tool，并可以向默认 system prompt 增加 tool-specific guideline；也支持在 `before_agent_start` 时注入额外 system/context 信息。

因此不需要维护一份修改后的 Pi system prompt fork。

---

# 18. 推荐用户交互

正常讨论阶段：

```text
Human:
我要重构 auth...

Pi:
分析、调查、讨论...
```

直到：

```text
Human:
方案可以了，整理并开始自动执行。
```

Main Pi 调用：

```text
plan_execute_finalize
```

TUI：

```text
Stage A Finalization

Generating document package...
✓ Documents written
✓ Manifest valid
✓ 5 phases found
✓ Acceptance contracts valid

[Review Package]
[Approve & Start]
[Cancel]
```

用户确认后：

```text
Stage B

Phase 1 / 5
Executor: OpenCode
Reviewer: Codex
Round: 1

Executor      ✓ complete
Self test     ✓ passed
Reviewer      ● reviewing
Phase commit  ○ pending
```

发生 REWORK：

```text
Phase 1 / 5
Round 2

Reviewer:
2 blocking findings

Executor:
resuming...
```

达到阈值：

```text
Workflow paused

Phase 3 failed to close after 3 review rounds.

[Return to Main Pi]
[Inspect Reports]
[Stop]
```

然后插件把结构化状态注入 Main Pi Session。

---

# 19. Main Pi 是升级决策者

Stage B Executor 不允许决定：

```text
我要找用户
我要修改计划
我要跳过阶段
```

Reviewer 也不直接与 Human 建立新的控制面。

当自动流程无法继续：

```text
Stage B Plugin
      ↓
Pause
      ↓
Summary
      ↓
Main Pi Session
```

最终：

```text
Human <------> Main Pi
```

决定后续动作。

这是整个设计中的核心人机关系。

---

# 20. Stage B Report Contract

Executor 和 Reviewer 都必须使用结构化报告。

Executor 至少：

```text
phase_id
round
base_commit
status
summary
changed_files
self_tests
resolved_findings
known_issues
```

Reviewer 至少：

```text
phase_id
round
base_commit
verdict
summary
findings
evidence
acceptance_assessment
out_of_scope_changes
```

插件创建 phase commit 后还必须生成不可变的阶段完成记录：

```text
phase_id
base_commit_sha
phase_commit_sha
committed_at
review_rounds
acceptance_results
execution_report_path
review_report_path
```

允许的 Reviewer verdict 第一版只有：

```text
PASS
REWORK
```

AgentPrism 的 `agent({schema})` 已经提供跨 Claude/Codex/OpenCode/Pi 的结构化输出与再次验证/repair，因此优先直接使用这一机制。

在其上仍可以添加我们自己的业务 policy validator，例如：

```text
PASS 时不能存在 blocking findings
```

不需要重新实现基础 JSON Schema transport。

---

# 21. Permission Strategy

第一版建议：

Executor：

```text
edit
```

Reviewer：

```text
readonly
```

Reviewer 必须可以读取代码和执行安全的验证命令，但原则上不直接修改工作区。

AgentPrism 已实现 ACP permission request handling；`pi-harness-delegate` 也已经证明在 Pi UX 中可以把各 harness 权限映射为统一 `readonly/edit/danger`。

因此 permission 应优先复用现有机制。

不要自己实现 Vendor permission parser。

---

# 22. Persistence

需要区分两类 persistence。

## Main Pi Session

由 Pi 自己负责。

插件额外状态可以通过：

```text
pi.appendEntry()
```

持久化，而且 custom entry 不必进入 LLM context。

## Stage B Workflow

优先由 AgentPrism journal/resume 负责。

AgentPrism 已实现 deterministic journal 和 `resumeFromRunId`，已完成的匹配 agent call 可 replay，而不是重新消耗 token。

因此第一版不要自己实现：

```text
SQLite EventStore
Custom event sourcing
Crash recovery engine
```

除非验证 AgentPrism persistence 与 Pi host 集成存在明确无法接受的缺陷。

---

# 23. 当前推荐依赖关系

```text
Pi
│
├── Main Agent
│
├── Session
│
├── TUI
│
└── Extension API
       │
       ▼
pi-plan-execute-auto
│
├── Stage A Finalizer
├── Package Validator
├── Human Approval
├── Stage B Bridge
├── Phase Committer
└── Status UI
       │
       ▼
@automatalabs/workflows
       │
       ▼
AgentPrism
│
├── ACP
├── Structured Output
├── Sessions
├── Journal
├── Retry
├── Permission
└── Workflow primitives
       │
       ├── Codex
       ├── OpenCode
       ├── Claude Code
       └── Pi / custom ACP
```

`pi-harness-delegate` 不在 dependency chain 中：

```text
pi-harness-delegate
      ↓
reference implementation
```

---

# 24. TypeScript 实现原则

整个项目统一 TypeScript。

但代码规范应刻意限制 TypeScript 复杂度。

要求：

```text
普通 interface
普通 class / function
async / await
简单 union
简单 generic
明确控制流
```

避免：

```text
conditional types
mapped type gymnastics
infer
decorator
mixin
复杂泛型约束
过度函数式组合
隐式 magic
```

目标是：

> 熟悉 Go / Python 的工程师，在 AI 辅助下可以直接阅读主要业务代码。

---

# 25. 推荐实施顺序

## Phase 1 — Stage A + Pi TUI

实现：

```text
Extension loading
Main Pi awareness
/plan-execute finalize
plan_execute_finalize
Phased Docs Package generation
Manifest with at least one ordered phase
Per-phase spec and acceptance contracts
Structural Validator
Validation error → Main Pi same session
Human approval
Freeze
TUI
```

此阶段不执行 Stage B。

目标：

> 把 Human ↔ Main Pi 的规划和文档冻结体验做顺。

---

## Phase 2 — AgentPrism Integration PoC

只验证：

```text
Pi Extension
→ AgentPrism
→ OpenCode Executor
→ Codex Reviewer
```

重点验证：

```text
structured output
permissions
events
TUI projection
cancel
session identity
```

特别验证：

> Reviewer REWORK 后，Executor 是否可以继续同一个 harness session。

同时验证：

```text
Executor / Reviewer 不会在审查完成前改变 HEAD
Reviewer PASS 后插件可以安全创建唯一 phase commit
commit SHA 可以成为下一 phase 的 base commit
```

Same-session 已有 lower-level session API 可供优先 PoC；端到端的 phase commit 边界与恢复行为仍需验证。

---

## Phase 3 — Stage B Loop

基于 Phase 2 结果选择：

```text
AgentPrism gate()
```

或者：

```text
AgentPrism lower-level session API / REPL handle
```

实现：

```text
ordered phases
capture phase base commit
phase-scoped execute
phase-scoped self test
phase-scoped review
rework in same phase
pass
re-run deterministic acceptance
plugin-owned phase commit
record commit SHA
next phase
max rounds
pause to Main Pi
```

不要自己实现 Agent runtime。

---

## Phase 4 — Production Hardening

最后才处理：

```text
crash resume
full transcript UX
permission refinements
usage/cost
workflow recovery
configuration UX
additional harnesses
```

---

# 26. 本方案明确不做的事情

当前版本不设计：

```text
通用 Workflow DSL
自己的 ACP implementation
自己的 Agent Runtime framework
自己的 generic State Machine engine
自己的 TUI framework
自己的 session protocol
自己的 permission protocol
REPLAN
多 Reviewer voting
并行 Phase
远程 distributed agents
```

这些都不是当前痛点。

---

# 27. 对 Pi Agent 的重点评审问题

请结合当前 Pi Extension API 和本机环境，对以下问题逐项分析：

| 问题                      | 需要确认                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Stage A Finalization    | `/plan-execute finalize` 是否可以可靠要求当前 Main Pi Agent 使用完整现有 conversation context 生成分阶段文档，而不是另开 Agent |
| Validation feedback     | 是否可以通过 `pi.sendMessage()` 把 Validator errors 送回同一 Main Pi session 并自动触发修复                  |
| Plugin awareness        | 使用 tool `promptSnippet/promptGuidelines` 是否足够让主 Pi 正确理解什么时候应该调用插件                          |
| TUI                     | 是否可以用 Pi 原生 widget/custom UI 完成 Stage A/Stage B 状态面板，无需另起 TUI                              |
| AgentPrism embedding    | `@automatalabs/workflows` 是否适合作为 Pi extension dependency 直接嵌入                              |
| Same executor session   | REWORK 后如何最低成本继续同一 OpenCode/Codex executor session                                         |
| `gate()`                | 能否配置成 same-session producer；如果不能，是否应该使用 lower-level runner 或 REPL persistent handle        |
| Phase commit boundary   | 如何保证 Executor/Reviewer 不提前改变 HEAD，并由插件在 PASS 后创建、验证和记录唯一的阶段 commit               |
| Main-session escalation | Stage B pause 后怎样把结构化状态安全地反馈给 Main Pi，而不污染大量 agent transcript                              |
| Permissions             | AgentPrism ACP permission 与 Pi UI 如何桥接最自然                                                  |
| Persistence             | Pi session + AgentPrism journal 是否已经足够，是否完全无需额外数据库                                         |
| Harness detection       | 是否复用/借鉴 pi-harness-delegate detection，而不是另写复杂 detection                                    |
| Runtime fallback        | 某 harness ACP 不稳定时，是否有必要复用 pi-harness-delegate CLI transport 作为 fallback                   |

---

# 28. 可行性初步判断

基于目前公开实现，本方案整体属于：

```text
高可行性
```

原因不是“这些能力理论上可以实现”，而是大部分基础能力已经存在：

Pi Extension 已经支持 tools、commands、system/context injection、TUI、session persistence 和向当前 Agent session 主动发送消息。

`pi-harness-delegate` 已经实际证明 Pi 可以稳定驱动多个独立 coding harness，并处理 session/resume、permission、transcript 和 live UI。

AgentPrism Workflows 已经实际实现基于 ACP 的 Codex/OpenCode/Claude/Pi workflow、structured output、journal/resume、permissions、workflow validation 和 review/fix primitives。

因此目前真正需要原创开发的主要是：

```text
Stage A Finalization Protocol

Mandatory Phased Document Package Contract

Stage A Structural Validator

Pi-native Stage A/Stage B UX

Stage A → Stage B handoff

Our phase-scoped executor/reviewer policy

Same-session REWORK integration

Plugin-owned phase commit boundary and commit evidence
```

其中最后一项是当前最大的技术验证点。

---

# 29. 最终设计原则

本项目优先遵守：

```text
Main Pi owns planning interaction.

Human owns final approval.

Golden Docs own execution intent.

Plugin owns coordination and the phase commit boundary.

AgentPrism owns cross-harness runtime infrastructure.

Executor owns phase-scoped implementation and self-test.

Reviewer owns phase-scoped independent verification.

Every completed phase owns one recorded commit.

Existing infrastructure is reused before new infrastructure is created.
```

最关键的一条是：

> **不要为了实现业务 workflow，而重新实现已经存在的 Agent Runtime / ACP / Session / Journal / Permission / Structured Output 基础设施。**

如果某项需求现有项目已经提供 80% 能力，应优先通过薄适配补齐剩余 20%，而不是重新设计一套体系。

---

# 30. 请 Pi Agent 输出的评估结果

请完成源码和本机环境检查后，输出：

```text
1. 整体方案：可行 / 有条件可行 / 不建议

2. Pi Extension 部分：
   哪些 API 可以直接完成
   哪些存在限制

3. AgentPrism 部分：
   哪些能力可以直接复用
   哪些假设不成立

4. Same-session REWORK：
   推荐的具体实现路径

5. pi-harness-delegate：
   哪些代码/设计值得复用
   是否需要成为 dependency

6. 需要我们自己实现的最小代码范围

7. 第一阶段 Stage A + TUI 的建议目录结构

8. 最小 PoC：
   用最少代码验证最大的技术未知项

9. 发现任何现成项目已经完整解决某个计划实现的模块时，
   明确指出并建议删除我们的重复实现。

10. Phase commit：
    推荐的 commit owner、Git 前置条件、失败恢复方式和阶段完成证据。
```

评估时优先阅读本机已安装包、实际 TypeScript 类型定义和源码，而不是仅根据本文推断 API 行为。

