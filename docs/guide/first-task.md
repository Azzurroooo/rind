# Get your first task done

English | [简体中文](first-task.zh-CN.md)

Goal: from scratch, watch Rind actually finish a task - read files, change code, run commands.

## Install and start

```bash
npm install -g @rind-ai/cli     # Node.js 18+
cd your-project
rind
```

If you have no npm environment, use the standalone installers from Releases (Windows x64 / macOS / Linux x64); to run from source, see [Running the CLI from source](../internals/07-surfaces/interactive-cli.md#running-from-source).

The startup banner tells you three things: **the current model, the session, and the working directory**. Note that there is no session yet - the session is created only when the first message is sent.

## Connect a model

The first run requires connecting a model provider first:

```text
/login
```

Just follow the menu (ChatGPT subscription sign-in, API Key, or a custom OpenAI-compatible endpoint). For multiple providers and more involved model selection strategies, see [Get Rind to use the model you specify](models.md); for now, keep going with the defaults.

`/model` shows or switches the current model; `/status` shows the current connection state.

## Assign the first task

Describe the task in natural language in the input box, then press Enter to send:

```text
Read src/parser/tokenizer.js, summarize how it handles unicode, and add the corresponding tests
```

During the turn you will see tool calls appear one by one (`read_file`, `bash`, ...); they are collapsed by default, showing only a one-line summary. To see the full output, press **Ctrl+O** to expand/collapse.

Rich text in assistant replies - tables, code blocks - is laid out directly by the Markdown renderer. Streaming text arrives as incremental events, but the persisted message is what counts in the end, so a refresh or a disconnect never loses content.

## Two kinds of mid-task interaction

- **It may ask you questions**: when a tool needs your call, the input box gives way to an option menu - up/down to select, Enter to confirm, Esc to cancel. Non-interactive `rind run` does not support such questions and fails outright.
- **You want to change direction**: you can type and send right now. For the full semantics of steering / queuing / interrupting, see [Steer the work back on track](steer-the-work.md).

## Finishing and exiting

- `/exit` (or `/quit`) exits; Ctrl+C interrupts while a turn is running (press once more for a hard stop), exits when pressed twice in a row while idle (within 2 seconds), and first clears unsent text when the input box has any.
- Sessions are saved automatically. To pick up where you left off: `rind --session <id>` resumes one directly, or `/sessions` lists recent sessions - see [Come back and keep working](resume.md).
- If you only want to see what it looks like, no API key needed: `rind tour` plays a simulated demo, or use `/tour` inside a session.

[Back to the scenario index](README.md)
