import assert from "node:assert/strict"
import test from "node:test"

import {
  activeSessionDirectoryBasename,
  directoryBasename,
  FILE_NAVIGATOR_ICON,
  SESSION_COPY_ICON,
} from "../src/identity.ts"

const context = (sessionDirectory: string | undefined, locationDirectory?: string) => ({
  location: locationDirectory ? { directory: locationDirectory } : undefined,
  data: {
    session: {
      get: () => sessionDirectory === undefined ? undefined : { location: { directory: sessionDirectory } },
    },
  },
}) as unknown as Parameters<typeof activeSessionDirectoryBasename>[0]

test("navigator identity uses the active session directory basename", () => {
  assert.equal(activeSessionDirectoryBasename(context("/work/opencode-rig/"), "ses_1"), "opencode-rig")
  assert.equal(activeSessionDirectoryBasename(context(undefined, "/work/fallback"), "ses_2"), "fallback")
})

test("navigator identity has no basename when the active directory is unavailable", () => {
  assert.equal(directoryBasename(undefined), undefined)
  assert.equal(directoryBasename("/"), undefined)
  assert.equal(activeSessionDirectoryBasename(context(undefined), "ses_3"), undefined)
})

test("navigator icon is one portable terminal cell", () => {
  assert.equal(FILE_NAVIGATOR_ICON, ">")
  assert.equal(SESSION_COPY_ICON, "#")
  assert.equal([...FILE_NAVIGATOR_ICON].length, 1)
  assert.equal([...SESSION_COPY_ICON].length, 1)
  assert.match(`${FILE_NAVIGATOR_ICON}${SESSION_COPY_ICON}`, /^[\x20-\x7e]{2}$/)
})
