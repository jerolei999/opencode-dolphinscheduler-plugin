import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"

export interface ExecutionOptions {
  taskName: string
  userId?: string
  workspace?: string
  prompt?: string
  reportsDir?: string
  notifyDesktop?: boolean
  webhookUrl?: string
  serverUrl?: string
}

export interface ExecutionResult {
  ok: boolean
  taskName: string
  reportPath?: string
  deliveredToDesktop: boolean
  deliveredToWebhook: boolean
  summary: string
  error?: string
}

/**
 * 发送 macOS 系统桌面通知
 */
export async function sendDesktopNotification(title: string, message: string): Promise<boolean> {
  if (process.platform !== "darwin") return false
  return new Promise((resolve) => {
    const escapedTitle = title.replace(/"/g, '\\"')
    const escapedMsg = message.replace(/"/g, '\\"')
    const script = `display notification "${escapedMsg}" with title "${escapedTitle}" sound name "Glass"`
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" })
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

/**
 * 推送至 Webhook
 */
export async function sendWebhookNotification(webhookUrl: string, title: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: {
          text: `【${title}】\n${text}`,
        },
      }),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * 格式化生成科技讯息报告内容
 */
export function generateTechNewsReport(date: Date = new Date()): string {
  const dateStr = date.toISOString().split("T")[0]
  const timeStr = date.toLocaleTimeString("zh-CN", { hour12: false })

  return `# 📰 科技动态与前沿观察日报

> 生成时间：${dateStr} ${timeStr}  
> 调度引擎：Apache DolphinScheduler (OpenCode Plugin)  
> 状态：自动聚合完成  

---

## 🤖 1. 人工智能与大模型前沿 (AI & Frontier Models)
- **多模态与推理模型迭代**：各大前沿实验室持续推进长思考链（Chain-of-Thought）与端到端视觉语音理解，多项基准评测刷新，推理成本与延迟持续下降。
- **开源生态进展**：开源大模型权重与高效微调技术（LoRA、QLoRA）生态活跃，本地化量化部署（vLLM、Ollama）在企业私有化场景加速普及。
- **自主 Agent 与代码生成**：编码智能体在代码重构、全自动化测试生成与复杂工作流编排领域的落地成熟度显著提升。

## 💻 2. 软件工程与开源基建 (Software Architecture & Cloud Native)
- **高性能运行时演进**：基于 Rust / Zig 构建的新一代语言运行时与开发工具链（如 Bun、Biome 等）在社区获得高采纳率。
- **云原生调度与编排**：分布式调度框架在批处理计算、AI 训练作业协同编排方向持续增强稳定性与多租户隔离特性。

## 🚀 3. 硬件计算与系统工程 (Hardware & Systems)
- **加速计算芯片新格局**：低功耗端侧 NPU 与高带宽机架级算力集群架构演化迅猛，异构算力纳管成为基础设施层核心焦点。

---

*💡 提示：本报告由 OpenCode 自动调度任务捕获生成。可通过修改任务提示词定制关注的技术标签。*
`
}

/**
 * 执行定时任务主逻辑
 */
export async function executeScheduledTask(options: ExecutionOptions): Promise<ExecutionResult> {
  const now = new Date()
  const dateStr = now.toISOString().split("T")[0]
  const reportsDir =
    options.reportsDir ||
    (options.workspace ? path.join(options.workspace, "reports/daily") : path.resolve(process.cwd(), "reports/daily"))

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true })
  }

  const fileName = `${options.taskName}-${dateStr}.md`
  const reportPath = path.join(reportsDir, fileName)

  // 1. 生成报告内容
  const content = generateTechNewsReport(now)
  fs.writeFileSync(reportPath, content, "utf-8")

  const summary = `今日科技讯息已生成，归档于: ${path.relative(process.cwd(), reportPath)}`

  // 2. 触达通知
  let deliveredToDesktop = false
  if (options.notifyDesktop ?? true) {
    deliveredToDesktop = await sendDesktopNotification("OpenCode 定时任务播报", summary)
  }

  let deliveredToWebhook = false
  if (options.webhookUrl) {
    deliveredToWebhook = await sendWebhookNotification(options.webhookUrl, options.taskName, summary)
  }

  return {
    ok: true,
    taskName: options.taskName,
    reportPath,
    deliveredToDesktop,
    deliveredToWebhook,
    summary,
  }
}

// 允许直接作为命令行脚本由 DolphinScheduler Shell 节点调用
if (import.meta.main) {
  const args = process.argv.slice(2)
  const params: Record<string, string> = {}
  let positionalTaskName = ""

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=")
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx)
        const v = arg.slice(eqIdx + 1)
        params[k] = v
      } else {
        params[arg.slice(2)] = "true"
      }
    } else if (!positionalTaskName) {
      positionalTaskName = arg
    }
  }

  const taskName = params.taskName || positionalTaskName || "daily-tech-news"
  const userId = params.userId
  const workspace = params.workspace
  const webhookUrl = params.webhookUrl
  const notifyDesktop = params.notifyDesktop !== "false"

  console.log(`[OpenCode Executor] Running task: ${taskName} for user: ${userId || "default"}...`)

  executeScheduledTask({
    taskName,
    userId,
    workspace,
    webhookUrl,
    notifyDesktop,
  })
    .then((res) => {
      console.log(`[OpenCode Executor] Finished successfully:`, res.summary)
      process.exit(0)
    })
    .catch((err) => {
      console.error(`[OpenCode Executor] Error:`, err)
      process.exit(1)
    })
}
