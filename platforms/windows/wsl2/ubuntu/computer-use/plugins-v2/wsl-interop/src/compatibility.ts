import { readFile } from "node:fs/promises"

export interface Compatibility {
  supported: boolean
  reason: string
}

export interface CompatibilityPolicy {
  minimumOpenCode: string
  maximumTestedOpenCode: string
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(?:opencode\s+v?)?(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

export function runtimeCompatibility(version: string, policy: CompatibilityPolicy): Compatibility {
  const minimum = policy.minimumOpenCode
  const maximum = policy.maximumTestedOpenCode
  const current = parseVersion(version)
  const low = parseVersion(minimum)
  const high = parseVersion(maximum)
  if (!current || !low || !high) return { supported: false, reason: `Unrecognized OpenCode version: ${version}` }
  if (compare(current, low) < 0) return { supported: false, reason: `OpenCode ${version} is older than ${minimum}` }
  if (compare(current, high) > 0) return { supported: false, reason: `OpenCode ${version} has not passed the WSL plugin canary (maximum ${maximum})` }
  return { supported: true, reason: `OpenCode ${version} is within the tested WSL plugin range` }
}

export async function loadCompatibilityPolicy(): Promise<CompatibilityPolicy> {
  const path = new URL("../../../config/compatibility.json", import.meta.url)
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  if (value.schemaVersion !== 1 || typeof value.minimumOpenCode !== "string" || typeof value.maximumTestedOpenCode !== "string") {
    throw new Error("invalid WSL compatibility policy")
  }
  return {
    minimumOpenCode: value.minimumOpenCode,
    maximumTestedOpenCode: value.maximumTestedOpenCode,
  }
}
