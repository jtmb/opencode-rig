import { registerHooks } from "node:module"

// Node resolves the bare "solid-js" specifier to the nonreactive server build.
// The OpenCode host (and the @opentui/solid renderer used by these tests) run the
// browser build at "solid-js/dist/solid.js", so redirect the bare specifier there
// for tests without changing runtime source. See test/solid-import.test.ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    return nextResolve(specifier, context)
  },
})
