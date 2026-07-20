# Tangerine Rind Naming Contract

This document is the shared naming contract for Python, Node.js, PowerShell,
Inno Setup, documentation, and tests. New code must use these names exactly.

| Surface | Required name |
| --- | --- |
| Display name | `Tangerine Rind` |
| Repository and project directory | `tangerine-rind` |
| CLI command and Node.js bin | `tangerine` |
| CLI executable | `tangerine.exe` |
| Python identifier prefix | `tangerine_` |
| Environment variable prefix | `TANGERINE_` |
| Default user directory | `~/.tangerine` |
| Project skill directory | `.tangerine/skills` |
| `/init` context file | `TANGERINE.md` |
| Node.js package | `tangerine-rind-frontend-cli` |
| Windows installer | `TangerineRindSetup-{version}.exe` |

Supported runtime environment variables include:

- `TANGERINE_HOME`
- `TANGERINE_SETTINGS_PATH`
- `TANGERINE_BASH_PATH`
- `TANGERINE_PYTHON`
- `TANGERINE_HEADER_NAME`
- `TANGERINE_HEADER_VERSION`
- `TANGERINE_HEADER_MARK`
- `TANGERINE_HEADER_TAGLINE`
- `TANGERINE_HEADER_ACCENT`
- `TANGERINE_HEADER_COMMAND_HINT`
- `TANGERINE_VERSION`
- `TANGERINE_GIT_INSTALLER_URL`

No previous project name, command, environment variable, data directory, or
context filename is supported as a compatibility alias.
