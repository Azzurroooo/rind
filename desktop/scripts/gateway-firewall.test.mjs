import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { firewallScript } from "../src/main/gateway/firewall.ts"

test("firewall repair scopes access to this executable, TCP port and local subnet", () => {
  const script = firewallScript("C:\\Apps\\Rind's desktop\\rind.exe", 8766)
  assert.ok(script.includes("$program = 'C:\\Apps\\Rind''s desktop\\rind.exe'"))
  assert.match(script, /-Program \$program -Protocol TCP -LocalPort 8766 -RemoteAddress LocalSubnet/)
  assert.match(script, /-EdgeTraversalPolicy Block/)
  assert.match(script, /-Program \$program -ErrorAction SilentlyContinue \| Get-NetFirewallRule/)
  assert.match(script, /Name -like 'TCP Query User\*'/)
  assert.ok(script.includes("$rule.DisplayName -eq $applicationName -and $rule.Description -eq $applicationName"))
  assert.match(script, /LocalPort -eq 'Any'/)
  assert.match(script, /PolicyStore ActiveStore/)
  assert.match(script, /exit 3/)
  assert.doesNotMatch(script, /Set-NetFirewallProfile|Set-NetConnectionProfile|ExecutionPolicy/)
  assert.equal(firewallScript("C:\\Apps\\rind.exe", 8766).match(/Rind-Remote-[a-f0-9]+/)[0], firewallScript("C:\\Apps\\rind.exe", 8767).match(/Rind-Remote-[a-f0-9]+/)[0])
})

test("firewall repair rejects untrusted ports and non-executable paths", () => {
  for (const port of [0, 80, 65536, 8766.5, "8766; exit 0"]) assert.throws(() => firewallScript("C:\\Apps\\rind.exe", port))
  for (const path of ["relative.exe", "C:\\Apps\\rind.ps1", "C:\\Apps\\rind\n.exe"]) assert.throws(() => firewallScript(path, 8766))
})

// Execute the generated PowerShell with in-memory cmdlet doubles. These tests
// never read or modify Windows Firewall and do not request administrator access.
function runWithRules(rules) {
  const json = Buffer.from(JSON.stringify(rules)).toString("base64")
  const stubs = `
$script:rules = [Collections.Generic.List[object]]::new()
foreach ($r in ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}')) | ConvertFrom-Json)) { $script:rules.Add($r) }
function Get-NetFirewallApplicationFilter { [CmdletBinding()] param($PolicyStore, $Program) [pscustomobject]@{ Store=$PolicyStore; Program=$Program } }
function Get-NetFirewallRule { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, $PolicyStore, $Name) process {
  if (-not $Name) { $script:rules | Where-Object { $_.Program -eq $InputObject.Program -and ($InputObject.Store -eq 'ActiveStore' -or $_.Source -eq 'Local') } }
} }
function Get-NetFirewallPortFilter { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject) process { $InputObject } }
function Get-NetFirewallAddressFilter { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject) process { $InputObject } }
function Remove-NetFirewallRule { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject) process { 'removed:' + $InputObject.Name; [void]$script:rules.Remove($InputObject) } }
function New-NetFirewallRule { param($PolicyStore,$Name,$DisplayName,$Group,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$LocalPort,$RemoteAddress,$EdgeTraversalPolicy) }
`
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(stubs + firewallScript("C:\\Apps\\electron.exe", 8766), "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15000 })
}
const rule = (Name, extra = {}) => ({ Name, Program: "C:\\Apps\\electron.exe", DisplayName: "Electron", Description: "Electron", Group: "", Direction: "Inbound", Action: "Block", Enabled: "True", Protocol: "TCP", LocalPort: "Any", RemotePort: "Any", LocalAddress: "Any", RemoteAddress: "Any", Source: "Local", ...extra })

test("repair handles both Windows prompt naming schemes and leaves unrelated rules", { skip: process.platform !== "win32" }, () => {
  const guid = "{1E2AF4EE-CDAB-438A-A205-432DBEED3F22}"
  const result = runWithRules([
    rule("TCP Query User{old}"), rule(guid),
    rule("{2E2AF4EE-CDAB-438A-A205-432DBEED3F22}", { Protocol: "UDP" }),
    rule("{3E2AF4EE-CDAB-438A-A205-432DBEED3F22}", { LocalPort: "443" }),
    rule("different-app", { Program: "C:\\Other\\electron.exe" }),
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["removed:TCP Query User{old}", `removed:${guid}`])
})

test("repair reports remaining custom or managed TCP blocks instead of false success", { skip: process.platform !== "win32" }, () => {
  for (const block of [rule("company-policy", { Source: "Managed" }), rule("custom-rule", { LocalPort: "8700-8800" })]) {
    const result = runWithRules([block])
    assert.equal(result.status, 3, result.stderr)
    assert.equal(result.stdout.trim(), "")
  }
})
