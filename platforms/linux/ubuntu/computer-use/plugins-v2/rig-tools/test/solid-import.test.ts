import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// The installed OpenCode binary transpiles TUI plugins with its own Solid runtime
// and maps only the bare "solid-js" specifier to it. Any solid-js subpath
// (e.g. "solid-js/dist/solid.js") resolves to a second Solid copy whose signals
// never run inside the host reactive root, so source must import the bare specifier.
const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url))
const SUBPATH_SPECIFIER = /["'`]solid-js\//

test("rig-tools source imports only the bare solid-js specifier", async () => {
  const offenders: string[] = []
  const files = await readdir(SOURCE_ROOT, { recursive: true, withFileTypes: true })
  for (const entry of files) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
    const fullPath = path.join(entry.parentPath, entry.name)
    for (const [index, line] of (await readFile(fullPath, "utf8")).split("\n").entries()) {
      if (SUBPATH_SPECIFIER.test(line)) {
        offenders.push(`${path.relative(SOURCE_ROOT, fullPath)}:${index + 1} ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `solid-js subpath imports must stay bare so the OpenCode host can map them to its own runtime:\n${offenders.join("\n")}`,
  )
})
