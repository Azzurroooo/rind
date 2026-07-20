export function createSlashMenuState(commands) {
  let text = "";
  let selected = 0;
  let dismissed = false;
  return {
    input() {
      return text;
    },
    matches() {
      return dismissed ? [] : matchingCommands(commands, text);
    },
    selectedIndex() {
      return selected;
    },
    selectedCommand() {
      return this.matches()[selected] || null;
    },
    handleKey(chunk, key = {}) {
      if (key.name === "escape") {
        dismissed = true;
        selected = 0;
        return true;
      }
      const matches = this.matches();
      if (matches.length && key.name === "up") {
        selected = selected <= 0 ? matches.length - 1 : selected - 1;
        return true;
      }
      if (matches.length && key.name === "down") {
        selected = selected >= matches.length - 1 ? 0 : selected + 1;
        return true;
      }
      if (chunk && !key.ctrl && !key.meta && String(chunk) >= " ") {
        text += String(chunk);
        selected = 0;
        dismissed = false;
        return true;
      }
      return false;
    },
    setInput(value) {
      const nextText = String(value || "");
      if (nextText !== text) {
        selected = 0;
        dismissed = false;
      }
      text = nextText;
    },
  };
}

function matchingCommands(commands, line) {
  const text = String(line || "");
  if (!text.startsWith("/") || /\s/.test(text)) {
    return [];
  }
  const token = text.slice(1).toLowerCase();
  return commands.filter((command) => command.name.startsWith(token));
}
