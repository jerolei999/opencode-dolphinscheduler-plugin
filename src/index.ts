import { type Plugin, tool } from "./plugin-env"
import * as path from "node:path"
import { ensureDolphinSchedulerReady, DEFAULT_DOCKER_CONFIG } from "./docker"
import { DolphinSchedulerClient } from "./client"
import { executeScheduledTask } from "./executor"

export const DolphinSchedulerPlugin: Plugin = async ({ directory, worktree }) => {
  const client = new DolphinSchedulerClient()

  const getCurrentUser = () => {
    const userId = (process.env.OPENCODE_USER_ID || "default-user").trim()
    const tenantId = (process.env.OPENCODE_TENANT_ID || "default").trim()
    const workspaceDir = directory || process.cwd()
    return { userId, tenantId, workspaceDir }
  }

  return {
    tool: {
      schedule_task: tool({
        description:
          "创建或设置基于 Apache DolphinScheduler 的定时任务。当用户表达在特定时间、每天固定点数或周期性执行某种任务（例如：'帮我设置9点查询最新的科技讯息'）时调用此工具。",
        args: {
          taskName: tool.schema
            .string()
            .describe("任务唯一标识名，使用小写字母、数字和连字符，如 daily-tech-news"),
          cron: tool.schema
            .string()
            .describe(
              "由自然语言解析出的 Cron 表达式（例如每天9点解析为 '0 0 9 * * ?' 或 '0 9 * * *'）",
            ),
          prompt: tool.schema
            .string()
            .describe("任务要执行的具体内容、要求或提示词（例如：'查询最新科技资讯并整理为早报'）"),
          description: tool.schema
            .string()
            .optional()
            .describe("任务的可读中文描述"),
          autoStartDocker: tool.schema
            .boolean()
            .optional()
            .describe("若本地 DolphinScheduler 服务未运行，是否自动启动 Docker 容器，默认为 true"),
          notifyDesktop: tool.schema
            .boolean()
            .optional()
            .describe("执行时是否发送桌面系统通知，默认为 true"),
          webhookUrl: tool.schema
            .string()
            .optional()
            .describe("可选的通知 Webhook URL（如飞书、钉钉、企微机器人）"),
        },
        async execute(args, context) {
          const autoStart = args.autoStartDocker ?? true
          const notify = args.notifyDesktop ?? true

          // 1. 确保 Docker 服务健康
          const dockerStatus = await ensureDolphinSchedulerReady({ autoStart })
          if (!dockerStatus.ok) {
            return {
              title: "定时任务创建受阻",
              output: `未能连接到 DolphinScheduler 调度服务：\n${dockerStatus.message}\n请检查 Docker 是否正常启动。`,
            }
          }

          // 2. 构造本地执行脚本路径（携带用户隔离参数）
          const { userId, workspaceDir } = getCurrentUser()
          const executorPath = path.resolve(__dirname, "executor.ts")
          const masterUrl = (process.env.OPENCODE_MASTER_DOCKER_URL || process.env.OPENCODE_MASTER_URL || "http://host.docker.internal:4000").replace(/\/+$/, "")
          const triggerToken = process.env.OPENCODE_TRIGGER_TOKEN || process.env.OPENCODE_API_KEY || "dev-admin-key"
          const payloadStr = JSON.stringify({
            userId,
            taskName: args.taskName,
            prompt: args.prompt,
            webhookUrl: args.webhookUrl,
          }).replace(/'/g, "'\\''")

          const localFallback = [
            `bun run "${executorPath}"`,
            `--taskName="${args.taskName}"`,
            `--userId="${userId}"`,
            `--workspace="${workspaceDir}"`,
            args.webhookUrl ? `--webhookUrl="${args.webhookUrl}"` : "",
            args.notifyDesktop === false ? `--notifyDesktop=false` : "",
          ].filter(Boolean).join(" ")

          const command = `#!/usr/bin/env bash
set -e
MASTER_URL="${masterUrl}"
TRIGGER_TOKEN="${triggerToken}"

echo "[DolphinScheduler] 1. Dispatching prompt to Master: \${MASTER_URL} for user: ${userId}..."
RESP=$(curl -s -f -X POST "\${MASTER_URL}/api/v1/schedules/trigger" \\
  -H "Authorization: Bearer \${TRIGGER_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '${payloadStr}' 2>/dev/null || true)

if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "\$RESP" | jq -r '.sessionId // empty')
else
  SESSION_ID=$(echo "\$RESP" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4 || true)
fi

if [ -z "\$SESSION_ID" ]; then
  echo "[DolphinScheduler] ⚠️ Master dispatch failed, falling back to local executor..."
  ${localFallback}
  exit 0
fi

echo "[DolphinScheduler] 2. Master accepted task. Session ID: \${SESSION_ID}. Starting non-blocking polling probe..."
MAX_WAIT=1800
ELAPSED=0
PROBE_INTERVAL=3

while [ \$ELAPSED -lt \$MAX_WAIT ]; do
  sleep \$PROBE_INTERVAL
  ELAPSED=\$((ELAPSED + PROBE_INTERVAL))

  STATUS_RESP=$(curl -s -f "\${MASTER_URL}/api/v1/sessions/\${SESSION_ID}/status" \\
    -H "Authorization: Bearer \${TRIGGER_TOKEN}" 2>/dev/null || true)

  if [ -n "\$STATUS_RESP" ]; then
    if command -v jq >/dev/null 2>&1; then
      EXEC_STATUS=$(echo "\$STATUS_RESP" | jq -r '.status // empty')
    else
      EXEC_STATUS=$(echo "\$STATUS_RESP" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || true)
    fi

    if [ "\$EXEC_STATUS" = "idle" ] || [ "\$EXEC_STATUS" = "ended" ]; then
      echo "[DolphinScheduler] ✅ Agent task completed successfully in \${ELAPSED}s. (Status: \${EXEC_STATUS})"
      exit 0
    elif [ "\$EXEC_STATUS" = "error" ]; then
      echo "[DolphinScheduler] ❌ Agent execution failed! (Status: error)"
      exit 1
    fi
  fi

  if [ \$((ELAPSED % 15)) -eq 0 ]; then
    echo "[DolphinScheduler] Agent still executing in background... (\${ELAPSED}s elapsed)"
  fi
done

echo "[DolphinScheduler] ⚠️ Polling probe timeout after \${MAX_WAIT}s"
exit 124
`

          // 3. 在 DolphinScheduler 中创建并发布定时任务（单项目带用户隔离命名空间）
          try {
            const taskResult = await client.createScheduledTaskForUser(userId, {
              name: args.taskName,
              description: args.description || args.prompt,
              cron: args.cron,
              command,
              prompt: args.prompt,
              webhookUrl: args.webhookUrl,
            })

            return {
              title: "定时任务创建成功",
              output: [
                `✅ 定时任务已成功创建并上线！`,
                `• 任务名称: ${taskResult.name}`,
                `• 所属用户: ${userId}`,
                `• 调度规则 (Cron): ${taskResult.cron}`,
                `• 工作流编号: ${taskResult.processDefinitionCode}`,
                `• 调度编号: ${taskResult.scheduleId || "已绑定"}`,
                `• 调度状态: 在线 (ONLINE)`,
                `• 回调中枢: Master (${masterUrl}/api/v1/schedules/trigger)`,
                `• 执行内容: ${args.prompt}`,
                `• 调度平台 UI: http://localhost:12345/dolphinscheduler/ui (admin / dolphinscheduler123)`,
                ``,
                `到点后 DolphinScheduler 将自动回调 Master，触发真实 OpenCode Agent 会话生成日报并沉淀至 ${path.relative(process.cwd(), path.join(workspaceDir, "reports/daily"))}/。`,
              ].join("\n"),
              metadata: {
                taskResult,
                userId,
              },
            }
          } catch (err: any) {
            return {
              title: "调度平台注册失败",
              output: `调用 DolphinScheduler 接口失败: ${err.message}\n服务地址: ${DEFAULT_DOCKER_CONFIG.endpoint}`,
            }
          }
        },
      }),

      manage_schedules: tool({
        description: "查看、列出或删除 DolphinScheduler 中的定时调度任务。",
        args: {
          action: tool.schema
            .enum(["list", "delete"])
            .describe("操作类型：list (列出全部任务), delete (删除任务)"),
          processDefinitionCode: tool.schema
            .string()
            .optional()
            .describe("要删除的工作流 Code (delete 操作必填)"),
          scheduleId: tool.schema
            .number()
            .optional()
            .describe("要删除的 Schedule 编号"),
        },
        async execute(args) {
          const { userId } = getCurrentUser()

          if (args.action === "list") {
            try {
              const list = await client.listScheduledTasksForUser(userId)
              if (list.length === 0) {
                return `用户 [${userId}] 当前没有任何已配置的 DolphinScheduler 定时任务。`
              }
              const lines = [` 当前定时任务列表（用户: ${userId}）：`]
              for (const item of list) {
                lines.push(
                  `- 任务: ${item.name} | Code: ${item.code} | Cron: ${item.crontab || "无"} | 状态: ${item.scheduleState || item.releaseState}`,
                )
              }
              return lines.join("\n")
            } catch (err: any) {
              return `获取定时任务列表失败: ${err.message}`
            }
          }

          if (args.action === "delete") {
            if (!args.processDefinitionCode) {
              return "删除失败：未提供 processDefinitionCode。"
            }
            try {
              await client.deleteScheduledTaskForUser(userId, args.processDefinitionCode, args.scheduleId)
              return `✅ 任务 ${args.processDefinitionCode} 已成功下线并删除（操作者: ${userId}）。`
            } catch (err: any) {
              return `删除任务失败: ${err.message}`
            }
          }

          return "未知操作。"
        },
      }),
    },
  }
}

export default DolphinSchedulerPlugin
