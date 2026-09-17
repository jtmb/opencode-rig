import { formatSnapshot } from "../src/format.ts"
import { fetchCodexUsage, readOpenAICredential } from "../src/usage.ts"

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 10_000)

try {
  const credential = await readOpenAICredential()
  const snapshot = await fetchCodexUsage(credential, {
    signal: controller.signal,
    supportsLunaReserve: true,
  })
  console.log(formatSnapshot(snapshot))
} catch (error) {
  console.error(error instanceof Error ? error.message : "Codex usage check failed.")
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
}
