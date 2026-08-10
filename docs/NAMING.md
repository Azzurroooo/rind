# Rind Naming Contract

This document is the shared naming contract for Python, Node.js, PowerShell,
Inno Setup, documentation, and tests. New code must use these names exactly.

| Surface | Required name |
| --- | --- |
| Display name | `Rind` |
| Repository and project directory | `rind` |
| CLI command and Node.js bin | `rind` |
| CLI executable | `rind.exe` |
| Python identifier prefix | `rind_` |
| Environment variable prefix | `RIND_` |
| Default user directory | `~/.rind` |
| Project skill directory | `.rind/skills` |
| `/init` context file | `RIND.md` |
| Node.js package | `rind-frontend-cli` |
| Windows installer | `RindSetup-{version}.exe` |

`~/.rind/settings.json` is the only API configuration source. Supported runtime environment variables include:

- `RIND_HOME`
- `RIND_BASH_PATH`
- `RIND_PYTHON`
- `RIND_HEADER_NAME`
- `RIND_HEADER_VERSION`
- `RIND_HEADER_MARK`
- `RIND_HEADER_TAGLINE`
- `RIND_HEADER_ACCENT`
- `RIND_HEADER_COMMAND_HINT`
- `RIND_VERSION`
- `RIND_GIT_INSTALLER_URL`

No previous project name, command, environment variable, data directory, or
context filename is supported as a compatibility alias.
