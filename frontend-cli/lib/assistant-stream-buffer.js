export function createAssistantStreamBuffer() {
  let pending = "";

  return {
    push(text, holdPartialLine = false) {
      const output = pending + String(text || "");
      if (!holdPartialLine || output.endsWith("\n")) {
        pending = "";
        return output;
      }
      const splitAt = output.lastIndexOf("\n");
      if (splitAt === -1) {
        pending = output;
        return "";
      }
      pending = output.slice(splitAt + 1);
      return output.slice(0, splitAt + 1);
    },
    flush() {
      const output = pending;
      pending = "";
      return output;
    },
  };
}
