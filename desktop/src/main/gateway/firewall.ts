import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { win32 } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

/** The main process supplies its own executable and the active gateway port. */
export function firewallScript(executable: string, port: number) {
  if (!win32.isAbsolute(executable) || !/\.exe$/i.test(executable) || /[\r\n\0]/.test(executable)) throw new Error("Invalid application path.")
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid gateway port.")
  const name = `Rind-Remote-${createHash("sha256").update(executable.toLowerCase()).digest("hex").slice(0, 16)}`
  return `$ErrorActionPreference = 'Stop'
try {
  $program = ${literal(executable)}
  $name = ${literal(name)}
  # Windows uses both legacy Query User names and GUIDs for prompt-generated
  # rules. Match this executable's plain, unrestricted TCP blocks only.
  $applicationName = [IO.Path]::GetFileNameWithoutExtension($program)
  $automaticBlocks = @(Get-NetFirewallApplicationFilter -PolicyStore PersistentStore -Program $program -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object {
    $rule = $_
    $promptName = $rule.Name -like 'TCP Query User*' -or ($rule.Name -match '^\\{[0-9a-f-]{36}\\}$' -and $rule.DisplayName -eq $applicationName -and $rule.Description -eq $applicationName -and -not $rule.Group)
    if (-not $promptName -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Block') { return $false }
    $ports = $rule | Get-NetFirewallPortFilter
    $addresses = $rule | Get-NetFirewallAddressFilter
    ($ports.Protocol -eq 'TCP' -or $ports.Protocol -eq '6') -and $ports.LocalPort -eq 'Any' -and $ports.RemotePort -eq 'Any' -and $addresses.LocalAddress -eq 'Any' -and $addresses.RemoteAddress -eq 'Any'
  })
  $existing = Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue
  if ($existing) { $existing | Remove-NetFirewallRule }
  New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName 'Rind Remote Access' -Group 'Rind Remote Access' -Direction Inbound -Action Allow -Enabled True -Profile Any -Program $program -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
  $automaticBlocks | Remove-NetFirewallRule
  # An explicit block wins over an allow. Do not report success while one
  # still covers the current port; custom/managed policy needs its owner.
  $blocks = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $program | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' })
  foreach ($rule in $blocks) {
    $ports = $rule | Get-NetFirewallPortFilter
    if ($ports.Protocol -ne 'TCP' -and $ports.Protocol -ne '6' -and $ports.Protocol -ne 'Any') { continue }
    foreach ($range in $ports.LocalPort) {
      if ($range -eq 'Any' -or $range -eq '${port}') { exit 3 }
      if ($range -match '^(\\d+)-(\\d+)$' -and ${port} -ge [int]$Matches[1] -and ${port} -le [int]$Matches[2]) { exit 3 }
    }
  }
  exit 0
} catch { exit 1 }
`
}

/** Explicit user action only. UAC owns elevation; no firewall changes at startup. */
export async function allowGatewayOnWindows(executable: string, port: number) {
  if (process.platform !== "win32") throw new Error("This action is available on Windows only.")
  const payload = Buffer.from(firewallScript(executable, port), "utf16le").toString("base64")
  const launcher = `$ErrorActionPreference = 'Stop'; try { $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${payload}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $child.ExitCode } catch { exit 1 }`
  try {
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")], { windowsHide: true, timeout: 120000 })
  } catch (error) {
    if ((error as { code?: number }).code === 3) throw new Error("A custom Windows firewall rule still blocks Rind. Ask your administrator to allow this app’s gateway port; Rind has left custom rules unchanged.")
    throw new Error("Windows did not apply the local-network rule. Approve the administrator prompt and try again, or ask your administrator if this computer is managed.")
  }
}
