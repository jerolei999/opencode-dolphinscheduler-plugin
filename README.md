# OpenCode DolphinScheduler Plugin

面向 OpenCode 的企业级定时任务管理插件，基于开源成熟的 **Apache DolphinScheduler** 调度底座。

支持自然语言对定时任务的诉求（如 *“帮我设置每天9点查询最新的科技资讯并整理为早报”*），由 LLM 解析为定时规则，并在 DolphinScheduler 中自动编排、上线工作流，到点自动回调 **OpenCode Master 云端网关**，实现智能体 Agent 的自动化定时执行与成果归档。

---

## 🌟 核心特性

- **单项目多租户隔离（Project-per-User Namespace）**：在 DolphinScheduler 统一项目下，自动采用 `usr_${userId}__${taskName}` 前缀隔离各用户任务，实现查询过滤与删除防越权（IDOR Protection）。
- **异步解耦架构（Async Handshake + Polling Probe）**：DolphinScheduler 触发时与 Master 进行毫秒级短连接握手，零长连接阻塞，完全免疫网关 60s 超时风险。
- **真实 Agent 闭环**：触发后由 Master 拉起带有租约保护的专属 Session，调用真实 OpenCode 智能体、搜索引擎与代码沙箱，并在 Web 控制台形成完整历史记录。
- **开箱即用 Docker 编排**：内置 DolphinScheduler 3.2.2 单机容器编排，支持本地/云端一键就绪与自动探活守护。

---

## 🏗️ 架构时序

```
① 用户聊天触发: "每天9点查询科技早报"
   │
   ▼
OpenCode 插件 (schedule_task) ──> DolphinScheduler (统一项目 OPENCODE_TASKS)
                                  • 命名空间编码: usr_alice__daily-news
                                  • Cron: 0 0 9 * * ?
                                  • 触发指令: 异步回调 Master
   │
   ▼ (到点 09:00:00 自动触发)
DolphinScheduler ──(毫秒级短请求)──> Master 回调接口 (/api/v1/schedules/trigger)
                                   │
                                   ▼
                             Master 控制面:
                             1. 15ms 内受理并返回 202 (DS 握手完成，立即释放连接)
                             2. 自动为 Alice 创建专属定时 Session
                             3. 路由调度至 Alice 专属 OpenCode Worker 容器
                                   │
                                   ▼
                             OpenCode Worker 执行:
                             • 真实执行搜索、资讯归纳、生成 Markdown
                             • 产物写入 /workspace/alice/reports/daily/
                             • 状态收敛至 session.idle
                                   │
                                   ▼
                             Alice 打开 Web 控制台:
                             看到专属会话 "⏰ 定时任务 · daily-news"，并可继续追问交互！
```

---

## 🚀 快速开始

### 1. 启动 DolphinScheduler

使用内置的 Docker Compose 文件启动调度服务：

```bash
docker compose -f docker/dolphinscheduler.compose.yml up -d
```
服务启动后访问 UI 控制台：
- 访问地址：`http://127.0.0.1:12345/dolphinscheduler/ui`
- 默认账号：`admin`
- 默认密码：`dolphinscheduler123`

### 2. 在 OpenCode 中加载插件

在 OpenCode 的配置文件（如 `.opencode/opencode.jsonc`）中声明本插件：

```jsonc
{
  "plugins": [
    "opencode-dolphinscheduler-plugin"
  ]
}
```

### 3. 配置环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `DOLPHINSCHEDULER_URL` | DolphinScheduler 服务地址 | `http://127.0.0.1:12345/dolphinscheduler` |
| `DOLPHINSCHEDULER_USER` | 调度平台用户名 | `admin` |
| `DOLPHINSCHEDULER_PASSWORD` | 调度平台密码 | `dolphinscheduler123` |
| `OPENCODE_MASTER_DOCKER_URL`| 容器内回调 Master 的地址 | `http://host.docker.internal:4000` |
| `OPENCODE_TRIGGER_TOKEN` | 回调 Master 的鉴权密钥 | `dev-admin-key` |
| `OPENCODE_USER_ID` | 当前操作用户标识 | `default-user` |

---

## 🛠️ 插件工具定义

### `schedule_task`
创建或设置定时任务。
- `taskName`: 任务标识名（如 `daily-tech-news`）
- `cron`: Cron 表达式（如 `0 0 9 * * ?`）
- `prompt`: 任务执行的具体提示词
- `webhookUrl`: 可选的通知机器人地址

### `manage_schedules`
管理当前用户专属的定时任务。
- `action`: `list`（仅列出当前用户的任务）或 `delete`（删除任务，自动做所有权越权检查）
- `processDefinitionCode`: 要操作的工作流编号

---

## 🧪 单元测试

运行完整测试套件（覆盖了生命周期守护、多租户命名空间编码、列表过滤、防越权拦截、工作区文件隔离）：

```bash
bun install
bun test
```

---

## 📄 License

MIT
