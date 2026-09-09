import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { checkDockerAvailable, DEFAULT_DOCKER_CONFIG, isServiceHealthy } from "../src/docker"
import { DolphinSchedulerClient } from "../src/client"
import { generateTechNewsReport, executeScheduledTask } from "../src/executor"
import { DolphinSchedulerPlugin } from "../src/index"

describe("goal-dolphinscheduler-plugin 验收测试套件", () => {
  // CAP-001
  test("CAP-001: Docker 编排文件存在且配置正确", async () => {
    const composePath = DEFAULT_DOCKER_CONFIG.composeFile
    expect(fs.existsSync(composePath)).toBe(true)

    const content = fs.readFileSync(composePath, "utf-8")
    expect(content).toContain("apache/dolphinscheduler-standalone-server:3.2.2")
    expect(content).toContain("12345:12345")
    expect(content).toContain("Asia/Shanghai")

    const hasDocker = await checkDockerAvailable()
    expect(typeof hasDocker).toBe("boolean")
  })

  // CAP-002
  test("CAP-002: DolphinScheduler Client 配置与 Cron 标准化", () => {
    const client = new DolphinSchedulerClient({
      baseUrl: "http://localhost:12345/dolphinscheduler",
      username: "admin",
      password: "dolphinscheduler123",
    })

    // 5位 Linux cron -> 6位 DS cron
    expect(client.normalizeCron("0 9 * * *")).toBe("0 0 9 * * ?")
    expect(client.normalizeCron("30 8 1 * *")).toBe("0 30 8 1 * ?")
    // 已经包含 6 位
    expect(client.normalizeCron("0 0 9 * * ?")).toBe("0 0 9 * * ?")
  })

  // CAP-003 & CAP-004
  test("CAP-003 & CAP-004: 模拟 API 验证工作流与定时调度创建链路", async () => {
    // 启动一个局域 Mock HTTP 服务模拟 DolphinScheduler API
    let receivedLogin = false
    let receivedProjectCreate = false
    let receivedProcessCreate = false
    let receivedScheduleOnline = false

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname.endsWith("/login")) {
          receivedLogin = true
          return Response.json({ code: 0, data: { sessionId: "mock-session-123" } })
        }
        if (url.pathname.endsWith("/projects") && req.method === "GET") {
          return Response.json({ code: 0, data: { totalList: [] } })
        }
        if (url.pathname.endsWith("/projects") && req.method === "POST") {
          receivedProjectCreate = true
          return Response.json({ code: 0, data: { code: 9876543210 } })
        }
        if (url.pathname.includes("/task-definition/gen-task-codes")) {
          return Response.json({ code: 0, data: [1122334455] })
        }
        if (url.pathname.includes("/process-definition") && req.method === "POST") {
          receivedProcessCreate = true
          return Response.json({ code: 0, data: { code: 5544332211 } })
        }
        if (url.pathname.includes("/release")) {
          return Response.json({ code: 0, data: true })
        }
        if (url.pathname.includes("/schedules") && req.method === "POST") {
          if (url.pathname.endsWith("/online")) {
            receivedScheduleOnline = true
            return Response.json({ code: 0, data: true })
          }
          return Response.json({ code: 0, data: { id: 888 } })
        }

        return Response.json({ code: 0, data: null })
      },
    })

    try {
      const mockClient = new DolphinSchedulerClient({
        baseUrl: `http://127.0.0.1:${server.port}/dolphinscheduler`,
      })

      const res = await mockClient.createScheduledTask({
        name: "daily-tech-news",
        cron: "0 9 * * *",
        prompt: "查询9点科技讯息",
      })

      expect(res.name).toBe("daily-tech-news")
      expect(res.scheduleId).toBe(888)
      expect(res.online).toBe(true)
      expect(receivedLogin).toBe(true)
      expect(receivedProjectCreate).toBe(true)
      expect(receivedProcessCreate).toBe(true)
      expect(receivedScheduleOnline).toBe(true)
    } finally {
      server.stop()
    }
  })

  // CAP-005
  test("CAP-005: 插件声明与 Tool Schema 规范验证", async () => {
    const pluginInstance = await DolphinSchedulerPlugin({
      directory: process.cwd(),
      worktree: process.cwd(),
    } as any)

    expect(pluginInstance).toHaveProperty("tool")
    expect(pluginInstance.tool).toHaveProperty("schedule_task")
    expect(pluginInstance.tool).toHaveProperty("manage_schedules")

    const scheduleTool = pluginInstance.tool!.schedule_task
    expect(scheduleTool.description).toContain("Apache DolphinScheduler")

    // 测试 Zod 参数合法性验证
    const validArgs = {
      taskName: "daily-tech-news",
      cron: "0 0 9 * * ?",
      prompt: "每天9点查询科技讯息",
    }
    expect(scheduleTool.args.taskName.safeParse(validArgs.taskName).success).toBe(true)
    expect(scheduleTool.args.cron.safeParse(validArgs.cron).success).toBe(true)
    expect(scheduleTool.args.prompt.safeParse(validArgs.prompt).success).toBe(true)

    // 缺少必要字段时应当失败
    expect(scheduleTool.args.taskName.safeParse(undefined).success).toBe(false)
  })

  // CAP-006
  test("CAP-006: 任务回调执行、报告生成与归档闭环", async () => {
    const tempDir = path.resolve(process.cwd(), "reports/test-output")
    const res = await executeScheduledTask({
      taskName: "unit-test-task",
      reportsDir: tempDir,
      notifyDesktop: false,
    })

    expect(res.ok).toBe(true)
    expect(fs.existsSync(res.reportPath!)).toBe(true)

    const content = fs.readFileSync(res.reportPath!, "utf-8")
    expect(content).toContain("科技动态与前沿观察日报")
    expect(content).toContain("人工智能与大模型前沿")

    // 清理测试目录
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // CAP-007
  test("CAP-007: 容错与优雅降级", async () => {
    const pluginInstance = await DolphinSchedulerPlugin({
      directory: process.cwd(),
      worktree: process.cwd(),
    } as any)

    const scheduleTool = pluginInstance.tool!.schedule_task

    // 传入无效 endpoint 不自动启动 docker
    const result = await scheduleTool.execute(
      {
        taskName: "fail-test",
        cron: "0 0 9 * * ?",
        prompt: "测试错误处理",
        autoStartDocker: false,
      },
      {} as any,
    )

    expect(typeof result).toBe("object")
    const textOutput = typeof result === "string" ? result : result.output
    expect(textOutput).toContain("DolphinScheduler")
  })

  // CAP-USER-001: 命名空间编码/解码与归属权解析
  test("CAP-USER-001: 命名空间编码/解码与归属权解析", () => {
    const client = new DolphinSchedulerClient()
    const encoded = client.encodeTaskName("alice", "daily-news")
    expect(encoded).toBe("usr_alice__daily-news")

    expect(client.decodeTaskName("usr_alice__daily-news", "alice")).toBe("daily-news")
    expect(client.decodeTaskName("usr_alice__daily-news", "bob")).toBeNull()
    expect(client.extractOwner("usr_alice__daily-news")).toBe("alice")
    expect(client.extractOwner("some-legacy-task")).toBeNull()
  })

  // CAP-USER-002: 单项目多用户列表过滤与防越权
  test("CAP-USER-002: 单项目多用户列表过滤与防越权删除保护", async () => {
    let deletedCodes: string[] = []

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname.endsWith("/projects") && req.method === "GET") {
          return Response.json({ code: 0, data: { totalList: [{ code: 1001, name: "OPENCODE_TASKS" }] } })
        }
        if (url.pathname.includes("/process-definition") && req.method === "GET") {
          return Response.json({
            code: 0,
            data: {
              totalList: [
                { code: "101", name: "usr_alice__news-morning", releaseState: "ONLINE" },
                { code: "102", name: "usr_bob__news-morning", releaseState: "ONLINE" },
                { code: "103", name: "usr_alice__stock-alert", releaseState: "ONLINE" },
                { code: "104", name: "legacy-common-task", releaseState: "ONLINE" },
              ],
            },
          })
        }
        if (url.pathname.includes("/schedules") && req.method === "GET") {
          return Response.json({ code: 0, data: { totalList: [{ id: 999, crontab: "0 0 9 * * ?", releaseState: "ONLINE" }] } })
        }
        if (url.pathname.includes("/process-definition/") && req.method === "DELETE") {
          const parts = url.pathname.split("/")
          const code = parts[parts.length - 1]
          deletedCodes.push(code)
          return Response.json({ code: 0, data: true })
        }
        return Response.json({ code: 0, data: true })
      },
    })

    try {
      const mockClient = new DolphinSchedulerClient({
        baseUrl: `http://127.0.0.1:${server.port}/dolphinscheduler`,
      })

      // 1. Alice 查询只能看到自己的任务，且名字还原
      const aliceTasks = await mockClient.listScheduledTasksForUser("alice")
      expect(aliceTasks.length).toBe(2)
      expect(aliceTasks.map((t) => t.name).sort()).toEqual(["news-morning", "stock-alert"].sort())
      expect(aliceTasks.map((t) => t.code).sort()).toEqual(["101", "103"].sort())

      // 2. Bob 查询只能看到自己的任务
      const bobTasks = await mockClient.listScheduledTasksForUser("bob")
      expect(bobTasks.length).toBe(1)
      expect(bobTasks[0].name).toBe("news-morning")
      expect(bobTasks[0].code).toBe("102")

      // 3. Alice 尝试越权删除 Bob 的任务 (code: 102) 应当被拦截
      let forbiddenError: Error | null = null
      try {
        await mockClient.deleteScheduledTaskForUser("alice", "102")
      } catch (err: any) {
        forbiddenError = err
      }
      expect(forbiddenError).not.toBeNull()
      expect(forbiddenError!.message).toContain("权限不足")
      expect(deletedCodes.includes("102")).toBe(false)

      // 4. Alice 删除自己的任务 (code: 101) 成功
      await mockClient.deleteScheduledTaskForUser("alice", "101")
      expect(deletedCodes.includes("101")).toBe(true)
    } finally {
      server.stop()
    }
  })

  // CAP-USER-003: 工作区参数与产物落盘隔离
  test("CAP-USER-003: 工作区参数与产物落盘隔离", async () => {
    const aliceWs = path.resolve(process.cwd(), "reports/test-workspace-alice")
    const bobWs = path.resolve(process.cwd(), "reports/test-workspace-bob")

    try {
      const aliceRes = await executeScheduledTask({
        taskName: "my-tech-report",
        userId: "alice",
        workspace: aliceWs,
        notifyDesktop: false,
      })

      const bobRes = await executeScheduledTask({
        taskName: "my-tech-report",
        userId: "bob",
        workspace: bobWs,
        notifyDesktop: false,
      })

      expect(aliceRes.ok).toBe(true)
      expect(bobRes.ok).toBe(true)

      // 报告必须分别落在各自的工作区内
      expect(aliceRes.reportPath!.startsWith(aliceWs)).toBe(true)
      expect(bobRes.reportPath!.startsWith(bobWs)).toBe(true)

      expect(fs.existsSync(aliceRes.reportPath!)).toBe(true)
      expect(fs.existsSync(bobRes.reportPath!)).toBe(true)
    } finally {
      fs.rmSync(aliceWs, { recursive: true, force: true })
      fs.rmSync(bobWs, { recursive: true, force: true })
    }
  })
})
