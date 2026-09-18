import type { LineNumberRenderable } from "@opentui/core"
import type { ExtendedComponentProps } from "@opentui/solid"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    line_number: typeof LineNumberRenderable
  }
}

declare module "@opentui/solid/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      line_number: ExtendedComponentProps<typeof LineNumberRenderable>
    }
  }
}
