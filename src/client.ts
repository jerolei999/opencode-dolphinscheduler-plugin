/**
 * DolphinScheduler REST API 客户端
 * 支持 Project 管理、工作流定义 (Process Definition) 创建/发布、定时调度 (Schedule) 绑定与启停
 */

export interface DolphinSchedulerConfig {
  baseUrl: string
  token?: string
  username?: string
  password?: string
  defaultProjectName?: string
}

export interface ScheduledTaskPayload {
  name: string
  description?: string
  cron: string
  command?: string
  prompt?: string
  webhookUrl?: string
  timezone?: string
}

export interface ProcessDefinitionResult {
  projectCode: string
  processDefinitionCode: string
  name: string
  scheduleId?: number
  cron?: string
  online: boolean
}

export class DolphinSchedulerClient {
  private baseUrl: string
  private token?: string
  private username: string
  private password: string
  private projectName: string
  private sessionId?: string
  private cachedProjectCode?: string

  constructor(config?: Partial<DolphinSchedulerConfig>) {
    this.baseUrl = (config?.baseUrl || process.env.DOLPHINSCHEDULER_URL || "http://127.0.0.1:12345/dolphinscheduler").replace(/\/+$/, "")
    this.token = config?.token || process.env.DOLPHINSCHEDULER_TOKEN
    this.username = config?.username || process.env.DOLPHINSCHEDULER_USER || "admin"
    this.password = config?.password || process.env.DOLPHINSCHEDULER_PASSWORD || "dolphinscheduler123"
    this.projectName = config?.defaultProjectName || "OPENCODE_TASKS"
  }

  private async request(path: string, options?: RequestInit & { params?: Record<string, string | number | boolean> }): Promise<any> {
    let url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`

    if (options?.params) {
      const search = new URLSearchParams()
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          search.append(k, String(v))
        }
      }
      url += `?${search.toString()}`
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options?.headers as Record<string, string>),
    }

    if (this.token) {
      headers["token"] = this.token
    } else if (this.sessionId) {
      headers["Cookie"] = `sessionId=${this.sessionId}`
    }

    const resp = await fetch(url, {
      ...options,
      headers,
    })

    if (!resp.ok) {
      throw new Error(`DolphinScheduler request failed [${resp.status}]: ${resp.statusText} (${url})`)
    }

    const data = await resp.json()
    if (data.code !== 0 && data.code !== 200 && data.success !== true && !data.data) {
      // 某些接口 code 返回 0 表示成功，或者带有 success=true
      if (data.failed || (data.code && data.code !== 0)) {
        throw new Error(`DolphinScheduler API error [${data.code}]: ${data.msg || "Unknown error"}`)
      }
    }
    return data
  }

  /**
   * 登录获取 Session
   */
  async login(): Promise<void> {
    if (this.token) return

    const res = await this.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        userName: this.username,
        userPassword: this.password,
      }),
    })

    if (res.data?.sessionId) {
      this.sessionId = res.data.sessionId
    }
  }

  /**
   * 获取或初始化默认项目
   */
  async getOrCreateProject(projectName: string = this.projectName): Promise<string> {
    if (this.cachedProjectCode) return this.cachedProjectCode
    await this.login()

    // 1. 查询项目是否存在
    try {
      const listRes = await this.request("/projects", {
        params: {
          pageSize: 20,
          pageNo: 1,
          searchVal: projectName,
        },
      })

      const list = listRes.data?.totalList || listRes.data || []
      const existing = list.find((p: any) => p.name === projectName)
      if (existing && existing.code) {
        this.cachedProjectCode = String(existing.code)
        return this.cachedProjectCode
      }
    } catch {
      // ignore and try create
    }

    // 2. 创建项目
    const createRes = await this.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        projectName,
        description: "Automated tasks managed by OpenCode",
      }),
    })

    const code = createRes.data?.code || createRes.data?.projectCode
    if (!code) {
      throw new Error(`Failed to obtain projectCode from create response: ${JSON.stringify(createRes)}`)
    }

    this.cachedProjectCode = String(code)
    return this.cachedProjectCode
  }

  /**
   * 批量生成任务 Code
   */
  async genTaskCode(projectCode: string): Promise<string> {
    try {
      const res = await this.request(`/projects/${projectCode}/task-definition/gen-task-codes`, {
        params: { genNum: 1 },
      })
      if (Array.isArray(res.data) && res.data[0]) {
        return String(res.data[0])
      }
    } catch {
      // 容错: 生成 14 位随机数字
    }
    return `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`
  }

  /**
   * 规范化标准 6 位或 7 位 Cron 表达式
   */
  normalizeCron(cronStr: string): string {
    const parts = cronStr.trim().split(/\s+/)
    if (parts.length === 5) {
      // 标准 linux cron: min hour day month weekday -> DS cron: sec min hour day month ? *
      const [min, hour, dom, mon, dow] = parts
      const weekday = dow === "*" ? "?" : dow
      return `0 ${min} ${hour} ${dom} ${mon} ${weekday}`
    }
    if (parts.length === 6) {
      // sec min hour day month weekday
      return cronStr.trim()
    }
    return cronStr.trim()
  }

  /**
   * 创建并发布定时工作流
   */
  async createScheduledTask(payload: ScheduledTaskPayload): Promise<ProcessDefinitionResult> {
    const projectCode = await this.getOrCreateProject()
    const taskCode = await this.genTaskCode(projectCode)
    const cron = this.normalizeCron(payload.cron)

    // 构建执行脚本内容 (Shell 任务节点)
    const scriptContent = payload.command
      ? payload.command
      : `#!/usr/bin/env bash
set -e
echo "[OpenCode Scheduled Task]: ${payload.name} started at $(date)"
# 回调执行器或生成汇报
node -e 'console.log("Triggering task: ${payload.name.replace(/'/g, "")}")'
`

    const taskDefinition = [
      {
        code: Number(taskCode),
        version: 1,
        delayTime: "0",
        description: payload.description || "OpenCode scheduled task node",
        environmentCode: -1,
        failRetryInterval: "1",
        failRetryTimes: "0",
        flag: "YES",
        isCache: "NO",
        name: `${payload.name}_node`,
        taskParams: {
          localParams: [],
          rawScript: scriptContent,
          resourceList: [],
        },
        taskPriority: "MEDIUM",
        taskType: "SHELL",
        timeout: 0,
        timeoutFlag: "CLOSE",
        timeoutNotifyStrategy: "",
        workerGroup: "default",
        cpuQuota: -1,
        memoryMax: -1,
        taskExecuteType: "BATCH",
      },
    ]

    const taskRelation = [
      {
        name: "",
        processDefinitionVersion: 1,
        preTaskCode: 0,
        preTaskVersion: 0,
        postTaskCode: Number(taskCode),
        postTaskVersion: 1,
        conditionType: "NONE",
        conditionParams: {},
      },
    ]

    const locations = [
      {
        taskCode: Number(taskCode),
        x: 100,
        y: 100,
      },
    ]

    // 1. 创建工作流定义
    const pdRes = await this.request(`/projects/${projectCode}/process-definition`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: payload.name,
        description: payload.description || `OpenCode task: ${payload.name}`,
        globalParams: "[]",
        timeout: "0",
        taskDefinitionJson: JSON.stringify(taskDefinition),
        taskRelationJson: JSON.stringify(taskRelation),
        locations: JSON.stringify(locations),
        executionType: "PARALLEL",
      }),
    })

    const processDefinitionCode = String(pdRes.data?.code || pdRes.data?.processDefinition?.code || taskCode)

    // 2. 发布工作流定义 (Online)
    await this.request(`/projects/${projectCode}/process-definition/${processDefinitionCode}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: payload.name,
        releaseState: "ONLINE",
      }),
    })

    // 3. 绑定 Schedule 定时规则
    const nowStr = new Date().toISOString().replace("T", " ").replace(/\..+$/, "")
    const scheduleParam = {
      startTime: nowStr,
      endTime: "2126-01-01 00:00:00",
      crontab: cron,
      timezoneId: payload.timezone || "Asia/Shanghai",
    }

    const scheduleRes = await this.request(`/projects/${projectCode}/schedules`, {
      method: "POST",
      params: {
        processDefinitionCode,
        schedule: JSON.stringify(scheduleParam),
        failureStrategy: "CONTINUE",
        warningType: "NONE",
        processInstancePriority: "MEDIUM",
        warningGroupId: 0,
        workerGroup: "default",
      },
    })

    const scheduleId = scheduleRes.data?.id

    // 4. 上线 Schedule
    if (scheduleId) {
      await this.request(`/projects/${projectCode}/schedules/${scheduleId}/online`, {
        method: "POST",
      })
    }

    return {
      projectCode,
      processDefinitionCode,
      name: payload.name,
      scheduleId,
      cron,
      online: true,
    }
  }

  /**
   * 获取所有工作流与定时列表
   */
  async listScheduledTasks(): Promise<Array<{
    code: string
    name: string
    releaseState: string
    crontab?: string
    scheduleState?: string
    scheduleId?: number
  }>> {
    const projectCode = await this.getOrCreateProject()

    const listRes = await this.request(`/projects/${projectCode}/process-definition`, {
      params: { pageNo: 1, pageSize: 50 },
    })

    const items = listRes.data?.totalList || listRes.data || []
    const results = []

    for (const item of items) {
      let crontab: string | undefined
      let scheduleState: string | undefined
      let scheduleId: number | undefined

      try {
        const schRes = await this.request(`/projects/${projectCode}/schedules`, {
          params: { processDefinitionCode: item.code, pageNo: 1, pageSize: 5 },
        })
        const schList = schRes.data?.totalList || schRes.data || []
        if (schList.length > 0) {
          crontab = schList[0].crontab
          scheduleState = schList[0].releaseState
          scheduleId = schList[0].id
        }
      } catch {
        // ignore
      }

      results.push({
        code: String(item.code),
        name: item.name,
        releaseState: item.releaseState,
        crontab,
        scheduleState,
        scheduleId,
      })
    }

    return results
  }

  /**
   * 删除任务
   */
  async deleteScheduledTask(processDefinitionCode: string, scheduleId?: number): Promise<void> {
    const projectCode = await this.getOrCreateProject()

    // 1. 如果有调度规则，先下线再删除
    if (scheduleId) {
      try {
        await this.request(`/projects/${projectCode}/schedules/${scheduleId}/offline`, { method: "POST" })
      } catch {}
      try {
        await this.request(`/projects/${projectCode}/schedules/${scheduleId}`, { method: "DELETE" })
      } catch {}
    }

    // 2. 下线工作流
    try {
      await this.request(`/projects/${projectCode}/process-definition/${processDefinitionCode}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ releaseState: "OFFLINE" }),
      })
    } catch {}

    // 3. 删除工作流
    await this.request(`/projects/${projectCode}/process-definition/${processDefinitionCode}`, {
      method: "DELETE",
    })
  }

  public static readonly USER_PREFIX = "usr_"
  public static readonly USER_SEPARATOR = "__"

  /**
   * 编码：拼接内部带用户命名空间的工作流名称 (例如 usr_alice__daily-tech-news)
   */
  encodeTaskName(userId: string, taskName: string): string {
    const cleanUser = (userId || "default").trim()
    return `${DolphinSchedulerClient.USER_PREFIX}${cleanUser}${DolphinSchedulerClient.USER_SEPARATOR}${taskName}`
  }

  /**
   * 解码：从完整工作流名称中解析并验证当前用户，若匹配则返回原始名称，若不匹配返回 null
   */
  decodeTaskName(fullName: string, userId: string): string | null {
    const cleanUser = (userId || "default").trim()
    const prefix = `${DolphinSchedulerClient.USER_PREFIX}${cleanUser}${DolphinSchedulerClient.USER_SEPARATOR}`
    if (fullName.startsWith(prefix)) {
      return fullName.slice(prefix.length)
    }
    return null
  }

  /**
   * 提取所有者：从内部工作流名称中解析所属用户 ID
   */
  extractOwner(fullName: string): string | null {
    if (!fullName.startsWith(DolphinSchedulerClient.USER_PREFIX)) return null
    const rest = fullName.slice(DolphinSchedulerClient.USER_PREFIX.length)
    const sepIndex = rest.indexOf(DolphinSchedulerClient.USER_SEPARATOR)
    if (sepIndex === -1) return null
    return rest.slice(0, sepIndex)
  }

  /**
   * 为指定用户创建定时任务（单项目模式下使用用户前缀与元数据标记）
   */
  async createScheduledTaskForUser(
    userId: string,
    payload: ScheduledTaskPayload,
  ): Promise<ProcessDefinitionResult & { internalName: string }> {
    const internalName = this.encodeTaskName(userId, payload.name)
    const description = `[User:${userId}] ${payload.description || payload.prompt || payload.name}`

    const result = await this.createScheduledTask({
      ...payload,
      name: internalName,
      description,
    })

    return {
      ...result,
      name: payload.name,
      internalName: result.name,
    }
  }

  /**
   * 列出指定用户的定时任务（在单项目中过滤出属于该用户的任务，并剥离前缀呈现）
   */
  async listScheduledTasksForUser(userId: string): Promise<Array<{
    code: string
    name: string
    internalName: string
    releaseState: string
    crontab?: string
    scheduleState?: string
    scheduleId?: number
  }>> {
    const allTasks = await this.listScheduledTasks()
    const userTasks: Array<{
      code: string
      name: string
      internalName: string
      releaseState: string
      crontab?: string
      scheduleState?: string
      scheduleId?: number
    }> = []

    for (const task of allTasks) {
      const displayName = this.decodeTaskName(task.name, userId)
      if (displayName !== null) {
        userTasks.push({
          ...task,
          name: displayName,
          internalName: task.name,
        })
      }
    }

    return userTasks
  }

  /**
   * 删除指定用户的定时任务（带所有权防越权检查）
   */
  async deleteScheduledTaskForUser(
    userId: string,
    processDefinitionCode: string,
    scheduleId?: number,
  ): Promise<void> {
    const allTasks = await this.listScheduledTasks()
    const target = allTasks.find((t) => String(t.code) === String(processDefinitionCode))

    if (!target) {
      throw new Error(`任务未找到或已被删除: ${processDefinitionCode}`)
    }

    const owner = this.extractOwner(target.name)
    const cleanUser = (userId || "default").trim()

    // 若不是当前用户创建的任务，拒绝操作
    if (owner !== cleanUser) {
      throw new Error(`权限不足：无权删除不属于当前用户 [${userId}] 的任务 (目标所有者: ${owner || "未知"})`)
    }

    await this.deleteScheduledTask(processDefinitionCode, scheduleId ?? target.scheduleId)
  }
}
