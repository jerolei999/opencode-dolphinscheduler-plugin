import { spawn } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

export interface DockerServiceConfig {
  endpoint: string
  containerName: string
  composeFile: string
  healthTimeoutMs: number
  pollIntervalMs: number
}

function resolveComposeFile(): string {
  const candidates = [
    path.resolve(__dirname, "../docker/dolphinscheduler.compose.yml"),
    path.resolve(__dirname, "../../docker/dolphinscheduler.compose.yml"),
    path.resolve(process.cwd(), ".opencode/docker/dolphinscheduler.compose.yml"),
    path.resolve(process.env.HOME || "", ".config/opencode/docker/dolphinscheduler.compose.yml"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

export const DEFAULT_DOCKER_CONFIG: DockerServiceConfig = {
  endpoint: process.env.DOLPHINSCHEDULER_URL || "http://127.0.0.1:12345/dolphinscheduler",
  containerName: "opencode-dolphinscheduler",
  composeFile: resolveComposeFile(),
  healthTimeoutMs: 120_000,
  pollIntervalMs: 2_000,
}

function runCommand(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d) => {
      stderr += d.toString()
    })

    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() })
    })

    child.on("error", (err) => {
      resolve({ code: -1, stdout: "", stderr: err.message })
    })
  })
}

/**
 * 检查系统 Docker 是否可用
 */
export async function checkDockerAvailable(): Promise<boolean> {
  const res = await runCommand("docker", ["--version"])
  return res.code === 0
}

/**
 * 检查 DolphinScheduler 容器当前状态
 */
export async function getContainerStatus(
  containerName: string = DEFAULT_DOCKER_CONFIG.containerName,
): Promise<"running" | "stopped" | "not_found"> {
  const res = await runCommand("docker", [
    "inspect",
    "--format",
    "{{.State.Status}}",
    containerName,
  ])
  if (res.code !== 0 || !res.stdout) {
    return "not_found"
  }
  return res.stdout.toLowerCase().includes("running") ? "running" : "stopped"
}

/**
 * 探活 DolphinScheduler HTTP 服务
 */
export async function isServiceHealthy(endpoint: string = DEFAULT_DOCKER_CONFIG.endpoint): Promise<boolean> {
  try {
    const healthUrl = `${endpoint.replace(/\/+$/, "")}/actuator/health`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch(healthUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (resp.status >= 200 && resp.status < 400) {
      return true
    }
  } catch {
    // try fallback ui check
    try {
      const uiUrl = `${endpoint.replace(/\/+$/, "")}/ui/`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const resp = await fetch(uiUrl, { signal: controller.signal })
      clearTimeout(timeout)
      return resp.status >= 200 && resp.status < 400
    } catch {
      return false
    }
  }
  return false
}

/**
 * 等待服务就绪
 */
export async function waitForHealthy(
  endpoint: string = DEFAULT_DOCKER_CONFIG.endpoint,
  timeoutMs: number = DEFAULT_DOCKER_CONFIG.healthTimeoutMs,
  pollIntervalMs: number = DEFAULT_DOCKER_CONFIG.pollIntervalMs,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const healthy = await isServiceHealthy(endpoint)
    if (healthy) return true
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  return false
}

/**
 * 启动 DolphinScheduler 容器
 */
export async function startDolphinScheduler(
  composeFile: string = DEFAULT_DOCKER_CONFIG.composeFile,
): Promise<{ ok: boolean; error?: string }> {
  if (!fs.existsSync(composeFile)) {
    return { ok: false, error: `Compose file not found at ${composeFile}` }
  }

  const res = await runCommand("docker", [
    "compose",
    "-f",
    composeFile,
    "-p",
    "opencode-dolphinscheduler",
    "up",
    "-d",
  ])

  if (res.code !== 0) {
    return { ok: false, error: res.stderr || res.stdout || "Failed to start docker container" }
  }

  return { ok: true }
}

/**
 * 确保 DolphinScheduler 容器及 HTTP 服务已启动且可用
 */
export async function ensureDolphinSchedulerReady(options?: {
  endpoint?: string
  composeFile?: string
  autoStart?: boolean
}): Promise<{ ok: boolean; started: boolean; message: string }> {
  const endpoint = options?.endpoint || DEFAULT_DOCKER_CONFIG.endpoint
  const composeFile = options?.composeFile || DEFAULT_DOCKER_CONFIG.composeFile
  const autoStart = options?.autoStart ?? true

  // 1. 先检查是否已运行且健康
  if (await isServiceHealthy(endpoint)) {
    return {
      ok: true,
      started: false,
      message: `DolphinScheduler is already healthy at ${endpoint}`,
    }
  }

  // 2. 检查 Docker 是否存在
  const hasDocker = await checkDockerAvailable()
  if (!hasDocker) {
    return {
      ok: false,
      started: false,
      message: "Docker CLI is not found or not running. Please install and start Docker first.",
    }
  }

  if (!autoStart) {
    return {
      ok: false,
      started: false,
      message: `DolphinScheduler service is not running at ${endpoint}, and autoStart is disabled.`,
    }
  }

  // 3. 尝试拉起
  const startResult = await startDolphinScheduler(composeFile)
  if (!startResult.ok) {
    return {
      ok: false,
      started: false,
      message: `Failed to launch DolphinScheduler container: ${startResult.error}`,
    }
  }

  // 4. 等待服务健康
  const ready = await waitForHealthy(endpoint, 120_000, 3_000)
  if (!ready) {
    return {
      ok: false,
      started: true,
      message: `DolphinScheduler container started, but service did not become healthy within timeout at ${endpoint}.`,
    }
  }

  return {
    ok: true,
    started: true,
    message: `DolphinScheduler service successfully started and ready at ${endpoint}`,
  }
}
