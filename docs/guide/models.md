# Get Rind to use the model you specify

English | [简体中文](models.zh-CN.md)

Goal: connect a provider, select a model, pin defaults per project, and know where to check the current state.

## First connection

```text
/login
```

The menu covers three kinds of sources:

| Source | Best for | Notes |
| --- | --- | --- |
| Provider list + API Key | OpenAI, Anthropic, Google, DeepSeek, etc. | Keys are kept in the local credentials store and never written into the repo |
| ChatGPT subscription sign-in | You already have a ChatGPT subscription | Browser authorization; reuses the subscription quota |
| Named endpoint | Self-hosted or third-party OpenAI-compatible services | Give it a name, then select by name later; keys and addresses are managed together |

`/logout [provider]` removes a stored credential.

## Choosing a model and reasoning effort

- `/model` (bare command) opens the selection menu; `/model set <model>` sets it directly.
- `/effort` shows or sets the reasoning effort: `low | medium | high | xhigh | max`; **Ctrl+T** cycles it within a session.
- `/status` shows it all on one screen: session ID, name, the settings file in use, the connection and its endpoint/model, the reasoning effort with where each value came from, and the latest sampling usage.

Model capabilities (context window, whether images are supported) are decided by the built-in catalog, falling back to a cache when a remote refresh fails. When a model explicitly does not support images, the session warns instead of forcing them through; when capabilities are unknown, it warns and then tries, but never records unknown as supported.

## Let the project remember defaults

A model chosen in a session only affects that session. To make new sessions in a directory default to a certain model:

```bash
rind config set model <model> --folder [dir] [--connection <id>]
rind config set effort <level> --folder [dir]
rind config unset model|effort --folder [dir]
```

Priority: **session > the folder itself (`RIND_HOME/workspaces.json`, keyed by folder) > user defaults (`~/.rind/settings.json`)**. When a Git worktree has no settings of its own, it inherits the values of its main repo.

## How images get into the context

Just write the path relative to the workspace `uploads/` directory in the prompt, for example:

```text
uploads/screenshot.png what does this error mean
```

The system snapshots the image into the session (for format, size, and count limits, see [Images into context](../internals/02-context/image-input.md)); later requests read from the snapshot and no longer open the original file.

[Back to the scenario index](README.md)
