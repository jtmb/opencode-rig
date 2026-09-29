import type { StructuredCommandInput } from "./types.ts"

export function structuredParams(input: StructuredCommandInput): Record<string, unknown> {
  validateStructuredInput(input)
  const params: Record<string, unknown> = { maxItems: input.maxItems ?? 50 }
  if (input.name !== undefined) params.name = input.name
  if (input.path !== undefined) params.path = input.path
  return params
}

export function validateStructuredInput(input: StructuredCommandInput): void {
  if (!( ["processes", "services", "path"] as const).includes(input.operation)) throw new Error("unsupported structured PowerShell operation")
  const maxItems = input.maxItems ?? 50
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 200) throw new Error("maxItems must be an integer from 1 through 200")
  if (input.name !== undefined) {
    if (!input.name || input.name.length > 128 || /[\0\r\n]/u.test(input.name)) throw new Error("name must be 1..128 characters without control separators")
  }
  if (input.operation === "path") {
    if (!input.path || input.path.length > 4096 || /[\0\r\n]/u.test(input.path)) throw new Error("path operation requires a bounded Windows path")
    if (!/^[A-Za-z]:\\/u.test(input.path)) throw new Error("path must be an absolute local-drive path; UNC paths are not accepted")
  } else if (input.path !== undefined) {
    throw new Error("path is valid only for operation=path")
  }
}
