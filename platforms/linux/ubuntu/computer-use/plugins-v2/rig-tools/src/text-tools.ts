const DEFAULT_WIDTH = 80
const MAX_WIDTH = 240
const MAX_INPUT_BYTES = 128 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024

export type TextFoldInput = {
  text: string
  width?: number
  mode?: "hard" | "word"
}

function boundedWidth(value: unknown): number {
  if (value === undefined) return DEFAULT_WIDTH
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_WIDTH) {
    throw new Error(`width must be an integer from 1 through ${MAX_WIDTH}`)
  }
  return value as number
}

function foldLine(line: string, width: number, mode: "hard" | "word"): string[] {
  const output: string[] = []
  const points = Array.from(line)
  let start = 0
  while (points.length - start > width) {
    const end = start + width
    if (mode === "word") {
      let boundary = end - 1
      while (boundary > start && points[boundary] !== " " && points[boundary] !== "\t") boundary -= 1
      if (boundary > start) {
        output.push(points.slice(start, boundary).join(""))
        start = boundary + 1
        while (points[start] === " " || points[start] === "\t") start += 1
        continue
      }
    }
    output.push(points.slice(start, end).join(""))
    start = end
  }
  output.push(points.slice(start).join(""))
  return output
}

/** Fold bounded text without spawning a process or reading files. */
export function foldText(input: TextFoldInput) {
  if (typeof input.text !== "string") throw new Error("text must be a string")
  const inputBytes = Buffer.byteLength(input.text, "utf8")
  if (inputBytes > MAX_INPUT_BYTES) throw new Error(`text exceeds the ${MAX_INPUT_BYTES}-byte input limit`)
  const width = boundedWidth(input.width)
  const mode = input.mode ?? "word"
  if (mode !== "hard" && mode !== "word") throw new Error("mode must be hard or word")

  const lines = input.text.split("\n").flatMap((line) => foldLine(line, width, mode))
  const text = lines.join("\n")
  const outputBytes = Buffer.byteLength(text, "utf8")
  if (outputBytes > MAX_OUTPUT_BYTES) throw new Error(`folded text exceeds the ${MAX_OUTPUT_BYTES}-byte output limit`)
  return {
    text,
    width,
    mode,
    inputBytes,
    outputBytes,
    lines: lines.length,
    measurement: "unicode-code-points",
  }
}
