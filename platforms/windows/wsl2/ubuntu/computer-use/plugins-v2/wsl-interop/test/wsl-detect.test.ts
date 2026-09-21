import assert from "node:assert/strict"
import test from "node:test"

import { assertWsl2Interop, detectWsl, parseWslConf, type WslProbes } from "../src/wsl-detect.ts"

const linuxProject = ["/", "home", "alice", "project"].join("")
const windowsProject = ["/mnt/c", "/Users", "alice", "project"].join("")

function probes(overrides: Partial<WslProbes> = {}): WslProbes {
  const files = new Map<string, string>([
    ["/proc/sys/kernel/osrelease", "6.6.87.2-microsoft-standard-WSL2"],
    ["/proc/version", "Linux version Microsoft WSL2"],
    ["/etc/wsl.conf", "[boot]\nsystemd=true\n[interop]\nenabled=true\nappendWindowsPath=true\n"],
    ["/proc/1/comm", "systemd\n"],
    ["/proc/sys/fs/binfmt_misc/WSLInterop", "enabled\ninterpreter /init\nflags: PF\n"],
  ])
  return {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0", WSLG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" },
    cwd: linuxProject,
    readText: async (path) => files.get(path),
    exists: async (path) => path === "/proc/sys/fs/binfmt_misc/WSLInterop" || path === "/run/systemd/system",
    systemdState: async () => "running",
    ...overrides,
  }
}

test("parses WSL configuration without treating comments as settings", () => {
  assert.deepEqual(parseWslConf("; note\n[boot]\nsystemd = true\n# skip\n[interop]\nenabled=false\n"), {
    boot: { systemd: "true" },
    interop: { enabled: "false" },
  })
})

test("detects effective WSL2 capabilities separately from configuration", async () => {
  const result = await detectWsl(probes())
  assert.equal(result.isWsl, true)
  assert.equal(result.version, 2)
  assert.equal(result.systemd.configured, true)
  assert.equal(result.systemd.running, true)
  assert.equal(result.interop.registered, true)
  assert.equal(result.wslg, true)
  assert.equal(result.workspace, "linux")
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/u)
  assert.doesNotThrow(() => assertWsl2Interop(result))
})

test("does not classify ordinary Linux as WSL", async () => {
  const result = await detectWsl(probes({
    env: {},
    readText: async (path) => path === "/proc/sys/kernel/osrelease" ? "6.8.0-generic" : undefined,
    exists: async () => false,
  }))
  assert.equal(result.isWsl, false)
  assert.equal(result.version, 0)
  assert.equal(result.systemd.running, false)
  assert.throws(() => assertWsl2Interop(result), /kernel-confirmed WSL2/u)
})

test("does not trust environment variables or an ineffective interop entry", async () => {
  const environmentOnly = await detectWsl(probes({
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    readText: async (path) => path === "/proc/sys/kernel/osrelease" ? "6.8.0-generic" : undefined,
    exists: async () => false,
  }))
  assert.equal(environmentOnly.isWsl, false)
  const ineffective = await detectWsl(probes({
    readText: async (path) => {
      if (path === "/proc/sys/kernel/osrelease") return "6.6.87.2-microsoft-standard-WSL2"
      if (path === "/proc/sys/fs/binfmt_misc/WSLInterop") return "disabled\ninterpreter /init\n"
      return undefined
    },
  }))
  assert.equal(ineffective.interop.registered, false)
  assert.throws(() => assertWsl2Interop(ineffective), /effective WSL interoperability/u)
})

test("reports Windows-mounted workspaces", async () => {
  const result = await detectWsl(probes({ cwd: windowsProject }))
  assert.equal(result.workspace, "windows-mount")
})
