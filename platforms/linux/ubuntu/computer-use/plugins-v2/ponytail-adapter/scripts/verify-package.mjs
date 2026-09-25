#!/usr/bin/env node
import assert from "node:assert/strict"

import {
  loadPonytailPackage,
  PONYTAIL_COMMAND_NAMES,
  PONYTAIL_PACKAGE_NAME,
  PONYTAIL_PACKAGE_VERSION,
  PONYTAIL_SKILL_NAMES,
  resolvePonytailPackageRoot,
} from "../src/index.ts"

const root = await resolvePonytailPackageRoot()
const loaded = await loadPonytailPackage(root)
assert.equal(loaded.version, PONYTAIL_PACKAGE_VERSION)
assert.deepEqual(loaded.commands.map(({ name }) => name).toSorted(), [...PONYTAIL_COMMAND_NAMES].toSorted())
assert.deepEqual(loaded.skills.map(({ id }) => id).toSorted(), [...PONYTAIL_SKILL_NAMES].toSorted())
console.log(`OK: ${PONYTAIL_PACKAGE_NAME}@${loaded.version} resolved from ${root}; six commands, six skills, and hooks verified`)
