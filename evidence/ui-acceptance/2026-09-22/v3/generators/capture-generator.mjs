import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { deflateSync } from "node:zlib"

const VERSION = 3
const VIEWPORT = { columns: 140, rows: 60 }
const CELL = { width: 6, height: 8 }
const IMAGE = { width: VIEWPORT.columns * CELL.width, height: VIEWPORT.rows * CELL.height }
const NATIVE_CAPTURE_TEST = "platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/test/native-capture-fixture.ts"

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function relative(root, value) {
  return path.relative(root, value).split(path.sep).join("/")
}

function captureEvidenceRoot(root, plan, spec) {
  if (typeof spec.artifact !== "string" || !spec.artifact) throw new Error(`capture ${spec.id} must provide an artifact path`)
  const artifactPath = path.resolve(root, spec.artifact)
  const artifactRelative = relative(root, artifactPath)
  const capturesDirectory = path.posix.dirname(artifactRelative)
  const evidenceRoot = path.posix.dirname(capturesDirectory)
  if (artifactRelative.startsWith("../") || path.isAbsolute(artifactRelative) || path.posix.basename(capturesDirectory) !== "captures" || evidenceRoot === ".") {
    throw new Error(`capture artifact must be beneath an evidence captures directory: ${spec.artifact}`)
  }
  if (plan.evidence_root && plan.evidence_root !== evidenceRoot) throw new Error(`capture artifact root does not match plan evidence root: ${spec.artifact}`)
  return evidenceRoot
}

async function readBytes(root, relativePath) {
  return await readFile(path.join(root, ...relativePath.split("/")))
}

async function writeBytes(root, relativePath, bytes) {
  const target = path.join(root, ...relativePath.split("/"))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

async function writeJson(root, relativePath, value) {
  const bytes = jsonBytes(value)
  await writeBytes(root, relativePath, bytes)
  return sha256(bytes)
}

function sourceSetDigest(sources) {
  const payload = sources
    .map(({ path: sourcePath, sha256: digest }) => ({ path: sourcePath, sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return sha256(Buffer.from(canonicalJson(payload), "utf8"))
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, checksum])
}

function fillPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= IMAGE.height) return
  const offset = y * (width * 4 + 1) + 1 + x * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = color[3]
}

function dimColor(color) {
  return [Math.round(color[0] * 0.65), Math.round(color[1] * 0.65), Math.round(color[2] * 0.65), color[3]]
}

function visualizeNativeSpans(spans) {
  const width = IMAGE.width
  const height = IMAGE.height
  const stride = width * 4 + 1
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < VIEWPORT.rows; row += 1) {
    for (let column = 0; column < VIEWPORT.columns; column += 1) {
      for (let y = row * CELL.height; y < (row + 1) * CELL.height; y += 1) {
        for (let x = column * CELL.width; x < (column + 1) * CELL.width; x += 1) fillPixel(pixels, width, x, y, [0, 0, 0, 0])
      }
    }
  }
  for (const line of spans.lines) {
    for (const span of line.spans) {
      const attributes = span.attributes
      let foreground = [...span.fg]
      let background = [...span.bg]
      if (attributes & 32) [foreground, background] = [background, foreground]
      if (attributes & 2) foreground = dimColor(foreground)
      for (let column = span.x; column < span.x + span.width; column += 1) {
        for (let y = line.y * CELL.height; y < (line.y + 1) * CELL.height; y += 1) {
          for (let x = column * CELL.width; x < (column + 1) * CELL.width; x += 1) fillPixel(pixels, width, x, y, background)
        }
        if (!span.text.trim() || attributes & 64) continue
        const glyphWidth = attributes & 1 ? CELL.width - 1 : CELL.width - 2
        const character = span.text.codePointAt(Math.min(column - span.x, Math.max(0, span.text.length - 1))) ?? 32
        for (let y = line.y * CELL.height + 1; y < (line.y + 1) * CELL.height - 1; y += 1) {
          for (let x = column * CELL.width + 1; x < column * CELL.width + 1 + glyphWidth; x += 1) {
            const stripe = (character + x - column * CELL.width + (y - line.y * CELL.height) * 3) % 5
            fillPixel(pixels, width, x, y, stripe === 0 ? background : foreground)
          }
        }
        if (attributes & 8) for (let x = column * CELL.width; x < (column + 1) * CELL.width; x += 1) fillPixel(pixels, width, x, (line.y + 1) * CELL.height - 1, foreground)
        if (attributes & 128) for (let x = column * CELL.width; x < (column + 1) * CELL.width; x += 1) fillPixel(pixels, width, x, line.y * CELL.height + Math.floor(CELL.height / 2), foreground)
      }
    }
  }
  const signature = Buffer.from("\x89PNG\r\n\x1a\n", "binary")
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))])
}

async function sourceInfo(root, sourcePath) {
  return { path: sourcePath, sha256: sha256(await readBytes(root, sourcePath)) }
}

async function makeExecution(root, spec) {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`execution ${spec.test} must provide exact argv as a string array`)
  }
  const workingDirectory = path.resolve(root, spec.cwd ?? ".")
  const relativeWorkingDirectory = path.relative(root, workingDirectory)
  if (relativeWorkingDirectory.startsWith("..") || path.isAbsolute(relativeWorkingDirectory)) {
    throw new Error(`execution working directory escapes the project root: ${spec.cwd}`)
  }
  const testBytesBefore = await readBytes(root, spec.test)
  const sourceBytesBefore = await readBytes(root, spec.source)
  const runID = randomUUID()
  const startedAt = new Date().toISOString()
  const startedMonotonicNS = process.hrtime.bigint().toString()
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    cwd: workingDirectory,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  })
  const finishedMonotonicNS = process.hrtime.bigint().toString()
  const finishedAt = new Date().toISOString()
  if (result.error) throw result.error
  const exitCode = result.status ?? 1
  const sourceBytesAfter = await readBytes(root, spec.source)
  const testBytesAfter = await readBytes(root, spec.test)
  if (sha256(sourceBytesBefore) !== sha256(sourceBytesAfter) || sha256(testBytesBefore) !== sha256(testBytesAfter)) {
    throw new Error(`focused source or test changed during execution: ${spec.test}`)
  }
  if (exitCode !== 0) {
    throw new Error(`focused command failed (${exitCode}): ${JSON.stringify(spec.argv)}\n${result.stdout?.toString("utf8") ?? ""}${result.stderr?.toString("utf8") ?? ""}`)
  }
  const outputBytes = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])
  if (!outputBytes.length) throw new Error(`focused command produced no captured output: ${spec.test}`)
  await writeBytes(root, spec.output, outputBytes)
  await writeJson(root, spec.report, {
    version: 2,
    kind: spec.kind,
    test: spec.test,
    test_sha256: sha256(testBytesBefore),
    source_sha256: sha256(sourceBytesBefore),
    result: "passed",
    exit_code: exitCode,
    runner: "capture-generator.mjs",
    command: JSON.stringify(spec.argv),
    observed_at: finishedAt,
    max_age_days: 1,
    output: spec.output,
    output_sha256: sha256(outputBytes),
    invocation: {
      run_id: runID,
      argv: spec.argv,
      cwd: relativeWorkingDirectory || ".",
      started_at: startedAt,
      finished_at: finishedAt,
      started_monotonic_ns: startedMonotonicNS,
      finished_monotonic_ns: finishedMonotonicNS,
      exit_code: exitCode,
      source_sha256_before: sha256(sourceBytesBefore),
      source_sha256_after: sha256(sourceBytesAfter),
      test_sha256_before: sha256(testBytesBefore),
      test_sha256_after: sha256(testBytesAfter),
    },
  })
}

function eventOutput(nativeEvent, spec, nativeOutputDigest) {
  return {
    version: VERSION,
    capture_id: spec.id,
    phase: nativeEvent.phase,
    event_id: nativeEvent.event_id,
    action: nativeEvent.action,
    dispatch: nativeEvent.dispatch,
    provenance: nativeEvent.provenance,
    before: nativeEvent.before,
    after: nativeEvent.after,
    result: nativeEvent.result,
    native_capture_output_sha256: nativeOutputDigest,
    native_event_sha256: nativeEvent.native_event_sha256,
  }
}

async function makeCapture(root, plan, spec, observedAt, generatorPath, generatorDigest, nativeCapture, nativeFixtureDigest, nativeCaptureRun) {
  const evidenceRoot = captureEvidenceRoot(root, plan, spec)
  const sources = []
  for (const sourcePath of spec.sources) sources.push(await sourceInfo(root, sourcePath))
  const native = nativeCapture.captures[spec.id]
  if (!native) throw new Error(`native capture fixture did not emit ${spec.id}`)
  if (native.run_id !== nativeCaptureRun.run_id) throw new Error(`native fixture run ID mismatch for ${spec.id}`)
  const phases = new Set(native.events.map((event) => event.phase))
  if (phases.size !== 3 || !["test-setup", "test-dispatch", "test-teardown"].every((phase) => phases.has(phase))) {
    throw new Error(`native fixture ${spec.id} must emit test setup, dispatch, and teardown phases`)
  }
  for (const event of native.events) {
    if (event.provenance?.scope !== "native-test-renderer" || event.provenance.run_id !== nativeCaptureRun.run_id) {
      throw new Error(`native fixture ${spec.id} event lacks its test-renderer run/dispatch receipt`)
    }
  }
  if (native.viewport.columns !== VIEWPORT.columns || native.viewport.rows !== VIEWPORT.rows) throw new Error(`native viewport mismatch for ${spec.id}`)
  const nativeOutputBytes = Buffer.from(JSON.stringify(native, null, 2) + "\n", "utf8")
  const nativeOutputDigest = await (async () => {
    await writeBytes(root, spec.nativeOutput, nativeOutputBytes)
    return sha256(nativeOutputBytes)
  })()
  const snapshots = []
  for (const [snapshotID, value] of Object.entries(native.snapshots)) {
    const framePath = path.posix.join(evidenceRoot, "snapshots", spec.id, `${snapshotID}.txt`)
    const spansPath = path.posix.join(evidenceRoot, "snapshots", spec.id, `${snapshotID}.spans.json`)
    const statePath = path.posix.join(evidenceRoot, "snapshots", spec.id, `${snapshotID}.state.json`)
    const frameBytes = Buffer.from(value.frame, "utf8")
    const spansBytes = jsonBytes(value.spans)
    const stateBytes = jsonBytes(value.state)
    const frameDigest = sha256(frameBytes)
    const spansDigest = sha256(spansBytes)
    const stateDigest = sha256(stateBytes)
    if (frameDigest !== value.frame_sha256) throw new Error(`native frame digest mismatch for ${snapshotID}`)
    if (sha256(Buffer.from(canonicalJson(value.spans), "utf8")) !== value.spans_sha256) throw new Error(`native semantic-span digest mismatch for ${snapshotID}`)
    if (sha256(Buffer.from(canonicalJson(value.state), "utf8")) !== value.state_sha256) throw new Error(`native state digest mismatch for ${snapshotID}`)
    await writeBytes(root, framePath, frameBytes)
    await writeBytes(root, spansPath, spansBytes)
    await writeBytes(root, statePath, stateBytes)
    snapshots.push({
      id: snapshotID,
      frame: { path: framePath, sha256: frameDigest, encoding: "utf-8" },
      semantic_spans: { path: spansPath, sha256: spansDigest, semantic_sha256: value.spans_sha256, encoding: "utf-8", format: "opentui-captureSpans-v1" },
      state: { path: statePath, sha256: stateDigest, semantic_sha256: value.state_sha256, encoding: "utf-8", format: "native-state-v1" },
    })
  }
  const finalID = native.final_snapshot_id
  const final = native.snapshots[finalID]
  const finalBinding = snapshots.find((entry) => entry.id === finalID)
  if (!final || !finalBinding) throw new Error(`native final snapshot missing for ${spec.id}`)
  const characterPath = path.posix.join(evidenceRoot, "characters", `${spec.id}.txt`)
  const imagePath = path.posix.join(evidenceRoot, "images", `${spec.id}.png`)
  const characterBytes = Buffer.from(final.frame, "utf8")
  const imageBytes = visualizeNativeSpans(final.spans)
  await writeBytes(root, characterPath, characterBytes)
  await writeBytes(root, imagePath, imageBytes)
  const sourceDigest = sources.length === 1 ? sources[0].sha256 : sourceSetDigest(sources)
  const renderTestDigest = sha256(await readBytes(root, spec.renderTest))
  const nativeEvents = []
  for (const nativeEvent of native.events) {
    const outputPath = path.posix.join(evidenceRoot, "event-output", `${spec.id}-${nativeEvent.phase}.json`)
    const recordPath = path.posix.join(evidenceRoot, "events", `${spec.id}-${nativeEvent.phase}.json`)
    const output = eventOutput(nativeEvent, spec, nativeOutputDigest)
    const outputBytes = jsonBytes(output)
    await writeBytes(root, outputPath, outputBytes)
    const record = {
      version: VERSION,
      phase: nativeEvent.phase,
      event_id: nativeEvent.event_id,
      capture_id: spec.id,
      source_sha256: sourceDigest,
      capture_generator_sha256: generatorDigest,
      render_test_sha256: renderTestDigest,
      native_capture_test_sha256: nativeFixtureDigest,
      native_capture_output_sha256: nativeOutputDigest,
      runtime_id: plan.runtime.id,
      renderer_id: plan.renderer.id,
      viewport: VIEWPORT,
      action: output.action,
      dispatch: output.dispatch,
      provenance: output.provenance,
      before: output.before,
      after: output.after,
      result: output.result,
      native_event_sha256: output.native_event_sha256,
      output: outputPath,
      output_sha256: sha256(outputBytes),
      observed_at: observedAt,
    }
    const recordDigest = await writeJson(root, recordPath, record)
    nativeEvents.push({ phase: nativeEvent.phase, event_id: nativeEvent.event_id, record: recordPath, record_sha256: recordDigest })
  }
  const artifact = {
    version: VERSION,
    source_sha256: sourceDigest,
    capture_generator: { path: relative(root, generatorPath), sha256: generatorDigest },
    render_test: { path: spec.renderTest, sha256: renderTestDigest },
    native_capture_test: { path: NATIVE_CAPTURE_TEST, sha256: nativeFixtureDigest },
    native_capture_run: nativeCaptureRun,
    native_capture_output: { path: spec.nativeOutput, sha256: nativeOutputDigest, encoding: "utf-8", format: "native-opentui-capture-v1" },
    runtime: plan.runtime,
    renderer: plan.renderer,
    observed_at: observedAt,
    max_age_days: 1,
    viewport: VIEWPORT,
    native_snapshots: snapshots,
    native_frame: {
      snapshot_id: finalID,
      character_output: { path: characterPath, sha256: sha256(characterBytes), encoding: "utf-8" },
      semantic_spans: { path: finalBinding.semantic_spans.path, sha256: finalBinding.semantic_spans.sha256, semantic_sha256: finalBinding.semantic_spans.semantic_sha256, encoding: "utf-8", format: "opentui-captureSpans-v1" },
      frame_sha256: finalBinding.frame.sha256,
      spans_sha256: finalBinding.semantic_spans.semantic_sha256,
    },
    character_output: { path: characterPath, sha256: sha256(characterBytes), encoding: "utf-8" },
    span_visualization: { path: imagePath, sha256: sha256(imageBytes), mime: "image/png", width: IMAGE.width, height: IMAGE.height, derived_from: { snapshot_id: finalID, frame_sha256: finalBinding.frame.sha256, spans_sha256: finalBinding.semantic_spans.semantic_sha256, renderer: "opentui-semantic-span-diagnostic-v1", cell_width: CELL.width, cell_height: CELL.height } },
    layout_assertions: [
      { id: "visible_rows", operator: "<=", limit: VIEWPORT.rows },
      { id: "max_line_columns", operator: "<=", limit: VIEWPORT.columns },
      { id: "reachable_sections", operator: "==", limit: native.reachable_targets.length, targets: native.reachable_targets },
    ],
    events: nativeEvents,
  }
  await writeJson(root, spec.artifact, artifact)
}

async function runNativeFixture(root, plan, captureIDs, captureSpecs, generatorPath) {
  const fixturePath = path.join(root, ...NATIVE_CAPTURE_TEST.split("/"))
  const pluginRoot = path.join(root, "platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools")
  const temporary = await mkdtemp(path.join(tmpdir(), "opencode-rig-native-capture-"))
  const outputPath = path.join(temporary, "captures.json")
  const bounded = path.join(root, "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh")
  const runID = randomUUID()
  const inputPaths = new Set([relative(root, generatorPath), NATIVE_CAPTURE_TEST])
  for (const spec of captureSpecs) {
    inputPaths.add(spec.renderTest)
    for (const source of spec.sources) inputPaths.add(source)
  }
  const inputsBefore = await Promise.all([...inputPaths].sort().map(async (inputPath) => ({ path: inputPath, sha256: sha256(await readBytes(root, inputPath)) })))
  const environment = { ...process.env, PATH: `${path.dirname(plan.runtime.executable)}:${process.env.PATH ?? ""}`, RIG_NATIVE_CAPTURE_IDS: JSON.stringify(captureIDs), RIG_NATIVE_CAPTURE_FILE: outputPath, RIG_NATIVE_CAPTURE_RUN_ID: runID }
  const argv = ["/bin/bash", bounded, "--", plan.runtime.executable, "--experimental-ffi", "--experimental-strip-types", "--test", "test/native-capture-fixture.ts"]
  const startedAt = new Date().toISOString()
  const startedMonotonicNS = process.hrtime.bigint().toString()
  const result = spawnSync(argv[0], argv.slice(1), { cwd: pluginRoot, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
  const finishedMonotonicNS = process.hrtime.bigint().toString()
  const finishedAt = new Date().toISOString()
  try {
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`native OpenTUI capture fixture failed (status ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const output = JSON.parse(await readFile(outputPath, "utf8"))
    if (output.version !== 1 || output.renderer_api !== "OpenTUI.testRender.captureCharFrame+captureSpans") throw new Error("native fixture output is not an OpenTUI frame/span capture")
    if (output.run_id !== runID) throw new Error("native fixture output does not retain its invocation run ID")
    for (const id of captureIDs) if (!output.captures?.[id]) throw new Error(`native fixture output is missing ${id}`)
    const inputsAfter = await Promise.all([...inputPaths].sort().map(async (inputPath) => ({ path: inputPath, sha256: sha256(await readBytes(root, inputPath)) })))
    if (JSON.stringify(inputsBefore) !== JSON.stringify(inputsAfter)) throw new Error("native capture sources or tests changed during the fixture run")
    const fixtureDigest = sha256(await readFile(fixturePath))
    return {
      output,
      fixtureDigest,
      run: {
        scope: "native-test-renderer",
        run_id: runID,
        argv,
        cwd: relative(root, pluginRoot),
        started_at: startedAt,
        finished_at: finishedAt,
        started_monotonic_ns: startedMonotonicNS,
        finished_monotonic_ns: finishedMonotonicNS,
        exit_code: result.status,
        inputs: inputsAfter,
      },
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const planPath = process.argv[2]
  if (!planPath) throw new Error("usage: capture-generator.mjs PLAN.json")
  const plan = JSON.parse(await readFile(planPath, "utf8"))
  if (!plan || typeof plan !== "object") throw new Error("capture plan must be an object")
  const root = path.resolve(plan.root)
  const generatorPath = fileURLToPath(import.meta.url)
  const generatorDigest = sha256(await readFile(generatorPath))
  const observedAt = new Date().toISOString()
  for (const spec of plan.executions ?? []) await makeExecution(root, spec)
  const captureIDs = (plan.captures ?? []).map((spec) => spec.id)
  const native = await runNativeFixture(root, plan, captureIDs, plan.captures ?? [], generatorPath)
  for (const spec of plan.captures ?? []) {
    const nativeOutput = Buffer.from(JSON.stringify(native.output.captures[spec.id], null, 2) + "\n", "utf8")
    spec.nativeOutput = path.posix.join(captureEvidenceRoot(root, plan, spec), "native-output", `${spec.id}.json`)
    await writeBytes(root, spec.nativeOutput, nativeOutput)
    await makeCapture(root, plan, spec, observedAt, generatorPath, generatorDigest, native.output, native.fixtureDigest, native.run)
  }
  process.stdout.write(`generated ${plan.executions?.length ?? 0} execution reports and ${captureIDs.length} native OpenTUI capture artifacts at ${observedAt}\n`)
}

await main()
