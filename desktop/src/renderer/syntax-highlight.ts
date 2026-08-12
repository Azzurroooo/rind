import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  cjs: "javascript",
  css: "css",
  htm: "xml",
  html: "xml",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  ps1: "bash",
  py: "python",
  pyw: "python",
  sh: "bash",
  svg: "xml",
  toml: "yaml",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
}

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("css", css)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("json", json)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("python", python)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("yaml", yaml)

export function highlightFile(name: string, content: string) {
  const language = languageForFile(name)
  if (!language) return { language: "text", html: escapeHtml(content) }
  try {
    return { language, html: hljs.highlight(content, { language, ignoreIllegals: true }).value }
  } catch {
    return { language: "text", html: escapeHtml(content) }
  }
}

function languageForFile(name: string) {
  const extension = name.split(".").at(-1)?.toLowerCase()
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character)
}
