const EXT_TO_LANG = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  pyw: "python",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "bash",
  css: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "yaml",
};

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "del", "delete", "do", "elif", "else", "enum", "except",
  "export", "extends", "false", "finally", "fn", "for", "from", "func",
  "function", "global", "go", "if", "impl", "import", "in", "interface",
  "is", "lambda", "let", "match", "mod", "mut", "new", "nil", "none",
  "nonlocal", "not", "null", "of", "or", "package", "pass", "pub", "raise",
  " return", "return", "self", "static", "struct", "super", "switch", "then",
  "this", "throw", "trait", "true", "try", "type", "typeof", "undefined",
  "use", "var", "void", "while", "with", "yield", "True", "False", "None",
]);

const TOKEN_REGEX = new RegExp(
  [
    "(?<comment>//[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->)",
    "(?<string>\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)",
    "(?<number>\\b(?:0x[0-9a-fA-F]+|0b[01]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)",
    "(?<property>\\b[A-Za-z_][\\w-]*\\s*(?=:))",
    "(?<ident>\\b[A-Za-z_$][\\w$]*\\b)",
  ].join("|"),
  "g",
);

export function inferLanguageFromPath(filePath = "") {
  const clean = String(filePath || "").trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return EXT_TO_LANG[clean.slice(dot + 1)] || "";
}

export function normalizeLanguage(langOrPath = "") {
  const raw = String(langOrPath || "").trim().toLowerCase();
  if (!raw) return "";
  if (EXT_TO_LANG[raw]) return EXT_TO_LANG[raw];
  if (raw.includes(".") || raw.includes("/")) return inferLanguageFromPath(raw);
  return raw;
}

export function tokenizeCode(code, langOrPath = "") {
  const source = String(code ?? "");
  if (!source) return [];
  const lang = normalizeLanguage(langOrPath);
  if (lang === "text" || lang === "plain" || lang === "plaintext") {
    return [{ type: "plain", value: source }];
  }

  const tokens = [];
  let lastIndex = 0;
  for (const match of source.matchAll(TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: "plain", value: source.slice(lastIndex, index) });
    }
    const groups = match.groups || {};
    const value = match[0];
    if (groups.comment !== undefined) {
      tokens.push({ type: "comment", value });
    } else if (groups.string !== undefined) {
      tokens.push({ type: "string", value });
    } else if (groups.number !== undefined) {
      tokens.push({ type: "number", value });
    } else if (groups.property !== undefined) {
      tokens.push({ type: "property", value });
    } else if (groups.ident !== undefined) {
      tokens.push({
        type: KEYWORDS.has(value) ? "keyword" : "plain",
        value,
      });
    } else {
      tokens.push({ type: "plain", value });
    }
    lastIndex = index + value.length;
  }
  if (lastIndex < source.length) {
    tokens.push({ type: "plain", value: source.slice(lastIndex) });
  }
  return tokens;
}
