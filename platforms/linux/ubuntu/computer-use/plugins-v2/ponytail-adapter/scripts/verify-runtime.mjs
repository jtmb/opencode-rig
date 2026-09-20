#!/usr/bin/env node
import assert from "node:assert/strict"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const adapter = resolve(process.argv[2] || new URL("..", import.meta.url).pathname)
const packageRoot = process.argv[3] ? resolve(process.argv[3]) : undefined
const binary = process.env.OPENCODE_V2_BIN || resolve(process.env.HOME, ".local/opt/opencode-v2/opencode")
assert.ok(packageRoot, "usage: verify-runtime.mjs ADAPTER_DIRECTORY PONYTAIL_PACKAGE_DIRECTORY")

const root = await mkdtemp(`${tmpdir()}/opencode-ponytail-v2-`)
const requests = []
const provider = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const completion = {
    id: "probe",
    object: "chat.completion",
    created: 1,
    model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  if (!input.stream) {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(completion))
    return
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  for (const [delta, finishReason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
})
provider.listen(0, "127.0.0.1")
await once(provider, "listening")

const env = { ...process.env, HOME: root, PONYTAIL_DEFAULT_MODE: "full" }
for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key]
for (const name of ["CONFIG", "DATA", "CACHE", "STATE"]) env[`XDG_${name}_HOME`] = `${root}/${name.toLowerCase()}`
const configDirectory = `${env.XDG_CONFIG_HOME}/opencode`
await mkdir(configDirectory, { recursive: true })
await writeFile(`${configDirectory}/opencode.json`, JSON.stringify({
  plugins: [{ package: adapter, options: { packageRoot } }],
  model: "test/probe",
  update: "disable",
  default_agent: "probe",
  agents: { probe: { mode: "primary", system: "PONYTAIL_V2_VERIFICATION. Reply OK only." } },
  providers: {
    test: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "test" },
      models: {
        probe: {
          name: "Probe",
          limit: { context: 32_000, output: 1_000 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}))

let server
let url
let authorization

async function api(endpoint, body) {
  const response = await fetch(url + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

async function start() {
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env })
  let output = ""
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30_000)
    const fail = (error) => { clearTimeout(timer); reject(error) }
    server.once("error", fail)
    server.once("exit", (code) => fail(new Error(`server exited ${code}: ${output}`)))
    const read = (chunk) => {
      output += chunk
      const address = output.match(/server listening on (http:\/\/\S+)/)
      const password = output.match(/server password (\S+)/)
      if (!address || !password) return
      url = address[1]
      authorization = `Basic ${Buffer.from(`opencode:${password[1]}`).toString("base64")}`
      clearTimeout(timer)
      resolvePromise()
    }
    server.stdout.on("data", read)
    server.stderr.on("data", read)
  })
  let active
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const plugins = await api("/api/plugin")
    active = plugins.data.find((candidate) => candidate.id === "ponytail")
    if (active?.state.status === "active") break
    if (active?.state.status === "failed") assert.fail(JSON.stringify(active))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  assert.equal(active?.state.status, "active", JSON.stringify(active))
}

async function stop() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return
  const exited = once(server, "exit")
  server.kill("SIGTERM")
  await exited
}

async function turn(sessionID, command, expected) {
  const before = requests.length
  if (command === null) await api(`/api/session/${sessionID}/prompt`, { text: "Reply OK." })
  else await api(`/api/session/${sessionID}/command`, { name: "ponytail", text: command })
  await api(`/api/experimental/session/${sessionID}/wait`, {})
  const outgoing = requests.slice(before).find((request) => request.messages?.some((message) =>
    ["system", "developer"].includes(message.role) && JSON.stringify(message.content).includes("PONYTAIL_V2_VERIFICATION")))
  assert.ok(outgoing, `no model request for ${command ?? "prompt"}`)
  const system = JSON.stringify(outgoing.messages.filter((message) => ["system", "developer"].includes(message.role)))
  if (expected === "off") assert.doesNotMatch(system, /PONYTAIL MODE ACTIVE/)
  else assert.match(system, new RegExp(`PONYTAIL MODE ACTIVE[^\\n]*level: ${expected}`))
}

try {
  await start()
  const commands = await api("/api/command")
  assert.equal(commands.data.filter((command) => command.name.startsWith("ponytail")).length, 6)
  const skills = await api("/api/skill")
  assert.equal(skills.data.filter((skill) => skill.id.startsWith("ponytail")).length, 6)
  const sessionID = (await api("/api/session", { model: { providerID: "test", id: "probe" } })).data.id
  await turn(sessionID, "ultra", "ultra")
  await turn(sessionID, null, "ultra")
  await turn(sessionID, "off", "off")
  await stop()
  await start()
  await turn(sessionID, null, "off")
  console.log("PASS: Ponytail v2 plugin, six commands, six skills, mode injection, isolation, and restart persistence")
} catch (error) {
  console.error(`Ponytail runtime verification artifacts: ${root}`)
  throw error
} finally {
  await stop()
  provider.close()
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true })
}
