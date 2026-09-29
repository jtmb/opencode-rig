import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { historySummary, visibleTodosForDisplay } from "../src/store.ts"

const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
const rowSource = source.slice(source.indexOf("function TodoRow"), source.indexOf("function TodoPanel"))

test("every displayed status keeps its complete content in the same row data", () => {
  const items = [
    { content: "in progress work with enough words to wrap in the sidebar", status: "in_progress" as const },
    { content: "pending work with enough words to wrap in the sidebar", status: "pending" as const },
    { content: "completed work with enough words to wrap in the sidebar", status: "completed" as const },
    { content: "cancelled work with enough words to wrap in the sidebar", status: "cancelled" as const },
  ]

  const display = visibleTodosForDisplay(items)

  assert.deepEqual(display.items.map((item) => [item.status, item.content]), items.slice(0, 2).map((item) => [item.status, item.content]))
  assert.equal(display.hiddenHistory, 2)
})

test("all statuses use one auto-height word-wrapped TodoRow path", () => {
  assert.ok(rowSource.length > 0)
  assert.doesNotMatch(source, /\btruncate\b|wrapMode="none"/)
  assert.doesNotMatch(rowSource, /<Show|fallback|isCurrentTodo/)
  assert.doesNotMatch(rowSource, /truncate|wrapMode="none"|height=|minHeight=|overflow=/)
  assert.equal((rowSource.match(/<box flexDirection="row"/g) ?? []).length, 1)
  assert.equal((rowSource.match(/wrapMode="word"/g) ?? []).length, 2)
  assert.match(rowSource, /paddingLeft=\{2\}/)
  assert.match(rowSource, /props\.contentColor\(props\.item\.status\)/)
  assert.match(rowSource, /\{props\.item\.content\}/)
})

test("Todo heading spans the panel and separates its accent count with flexible space", () => {
  const headingSource = source.slice(source.indexOf("const activateHeader"), source.indexOf("<Show when={!collapsed()}"))
  assert.match(headingSource, /width=\"100%\"/)
  assert.match(headingSource, /<box flexGrow=\{1\} \/>/)
  assert.match(headingSource, /fg=\{palette\(\)\.sectionCount\}[\s\S]+\{`\$\{done\(\)\}\/\$\{items\(\)\.length\}`\}/)
  assert.match(headingSource, /fg=\{palette\(\)\.primary\} attributes=\{TextAttributes\.BOLD\}/)
  assert.match(headingSource, /\{collapsed\(\) \? "\+ Todo" : "- Todo"\}/)
})

test("history summary reports exactly the omitted history rows", () => {
  assert.equal(historySummary(0), undefined)
  assert.equal(historySummary(2), "+2 history items hidden")
  assert.equal(historySummary(-1), undefined)
})

test("archived history rows reuse the readable word-wrapped row contract without ellipsis", () => {
  const archivedSource = source.slice(source.indexOf("function ArchivedTodoRow"))
  assert.ok(archivedSource.length > 0)
  assert.doesNotMatch(archivedSource, /truncate|wrapMode="none"/)
  assert.equal((archivedSource.match(/<box flexDirection="row"/g) ?? []).length, 1)
  assert.equal((archivedSource.match(/wrapMode="word"/g) ?? []).length, 2)
  assert.match(archivedSource, /paddingLeft=\{2\}/)
  assert.match(archivedSource, /\{props\.item\.content\}/)
  assert.match(archivedSource, /marker\(props\.item\.status\)/)
})

test("history view is opt-in, paged, and keeps the current-work panel unchanged by default", () => {
  assert.match(source, /historyOpen\(\) \? "hide history" : "history"/)
  assert.match(source, /`history page \$\{historyPage\(\) \+ 1\}`/)
  assert.match(source, /historyHasMore\(\) \? "older ›" : ""/)
  assert.match(source, /historyPage\(\) > 0 \? "‹ newer" : ""/)
  assert.match(source, /queryArchivedTodos\(todoArchiveRoot\(\), \{/)
  assert.doesNotMatch(source, /\btruncate\b|wrapMode="none"/)
})

test("fullscreen tasks registration is additive to the retained-history sidebar", () => {
  assert.match(source, /after: "sidebar\.content"/)
  assert.match(source, /append: "session\.panel"/)
  assert.match(source, /registerTasksCommand\(context\)/)
  assert.match(source, /overlayRunningChildTodos/)
  assert.match(source, /historyOpen/)
  assert.match(source, /todoPalette/)
})
