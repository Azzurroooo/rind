import assert from "node:assert/strict"
import test from "node:test"

import { renderMarkdown } from "../src/renderer/markdown.ts"

test("markdown renderer formats common assistant response blocks", () => {
  const html = renderMarkdown("# Summary\n\n- first\n- second\n\n> quoted\n\n1. one\n2. two")
  assert.match(html, /<h1>Summary<\/h1>/)
  assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/)
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/)
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/)
})

test("markdown renderer escapes model-provided html and keeps safe links", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n\n[Docs](https://example.com/docs) and `code`")
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /href=\"https:\/\/example\.com\/docs\"/)
  assert.match(html, /<code>code<\/code>/)
})
