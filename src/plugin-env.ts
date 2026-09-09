import { z } from "zod"

export type ToolContext = {
  sessionID?: string
  messageID?: string
  agent?: string
  directory?: string
  worktree?: string
  abort?: AbortSignal
  metadata?: (input: { title?: string; metadata?: Record<string, any> }) => void
  ask?: (input: any) => Promise<void>
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, any>
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type Plugin = (context: { directory: string; worktree: string }) => Promise<{
  tool?: Record<string, any>
}> | { tool?: Record<string, any> }
