// Runtime slash catalog merge (spec section 6 and 9): the composer and the
// palette list the runtime's `initialize.commands` catalog merged with the
// local commands. A local command wins when both define the same name, since
// it drives richer UI (model picker, goal panel, theme) than the text result
// of the server command; it still inherits the runtime description and
// aliases. Runtime-only commands run verbatim through rind/command/execute.

export const SERVER_CATEGORY = "Server commands";

// Runtime commands that only make sense in a terminal.
const TERMINAL_ONLY = new Set(["exit", "quit"]);

export function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  const seen = new Set();
  const out = [];
  for (const item of catalog) {
    const name = cleanName(item?.name);
    if (!name || seen.has(name) || TERMINAL_ONLY.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: String(item?.description || "").trim(),
      usage: String(item?.usage || "").trim(),
      aliases: (Array.isArray(item?.aliases) ? item.aliases : []).map(cleanName).filter((alias) => alias && alias !== name),
    });
  }
  return out;
}

export function mergeCommandCatalog(localCommands, catalog, runServerSlash) {
  const entries = normalizeCatalog(catalog);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const merged = localCommands.map((command) => {
    const runtime = command.slash ? byName.get(command.slash) : null;
    if (!runtime) return command;
    return {
      ...command,
      description: command.description || runtime.description,
      usage: command.usage || runtime.usage,
      aliases: unique([...(command.aliases || []), ...runtime.aliases]),
      runtime: true,
    };
  });
  const claimed = new Set(merged.flatMap((command) => [command.slash, ...(command.aliases || [])]).filter(Boolean));
  for (const entry of entries) {
    if (claimed.has(entry.name)) continue;
    merged.push({
      id: `server.${entry.name}`,
      title: titleFor(entry.name),
      category: SERVER_CATEGORY,
      keywords: `${entry.name} ${entry.aliases.join(" ")} ${entry.description}`.trim(),
      slash: entry.name,
      aliases: entry.aliases.filter((alias) => !claimed.has(alias)),
      description: entry.description,
      usage: entry.usage,
      runtime: true,
      run: (context, argument) => (context?.runServerSlash || runServerSlash)?.(entry.name, argument || ""),
    });
    claimed.add(entry.name);
  }
  return merged;
}

function cleanName(value) {
  return String(value || "").trim().replace(/^\//, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function titleFor(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
}
