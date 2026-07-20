param(
    [switch]$SkipGitInstaller,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DistDir = Join-Path $Root "dist\tangerine"
$ReleaseDir = Join-Path $Root "release"
$BuildVenvDir = Join-Path $Root ".venv-build"
$BuildPython = Join-Path $BuildVenvDir "Scripts\python.exe"
$GitFallbackVersion = "2.54.0"
$GitFallbackUrl = "https://github.com/git-for-windows/git/releases/download/v$GitFallbackVersion.windows.1/Git-$GitFallbackVersion-64-bit.exe"

function Write-Step($Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-TangerineVersion() {
    Push-Location $Root
    try {
        return (python -c "from agent.version import __version__; print(__version__)").Trim()
    }
    finally {
        Pop-Location
    }
}

function Get-GitInstallerUrl() {
    if ($SkipGitInstaller) {
        return ""
    }

    Write-Step "Resolving latest Git for Windows installer"
    try {
        $Release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" `
            -Headers @{ "User-Agent" = "tangerine-rind-build-script" }
        $Asset = $Release.assets |
            Where-Object { $_.name -match '^Git-[0-9].*-64-bit\.exe$' } |
            Select-Object -First 1
        if ($Asset -and $Asset.browser_download_url) {
            return [string]$Asset.browser_download_url
        }
    }
    catch {
        Write-Warning "Could not resolve latest Git for Windows URL: $($_.Exception.Message)"
    }

    Write-Warning "Falling back to $GitFallbackUrl"
    return $GitFallbackUrl
}

function Find-Iscc() {
    $Command = Get-Command "iscc.exe" -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }

    $Candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path $Candidate)) {
            return $Candidate
        }
    }
    return $null
}

function Ensure-BuildVenv() {
    if (-not (Test-Path $BuildPython)) {
        Write-Step "Creating isolated build venv"
        python -m venv $BuildVenvDir
    }

    Write-Step "Installing runtime build dependencies"
    & $BuildPython -m pip install --upgrade pip
    & $BuildPython -m pip install -r (Join-Path $Root "requirements-runtime.txt") pyinstaller
}

function Copy-Templates() {
    $TemplateSource = Join-Path $Root "packaging\templates"
    if (-not (Test-Path $TemplateSource)) {
        return
    }

    Write-Step "Copying templates into dist"
    $TemplateTarget = Join-Path $DistDir "templates"
    if (Test-Path $TemplateTarget) {
        Remove-Item -LiteralPath $TemplateTarget -Recurse -Force
    }
    Copy-Item -Path $TemplateSource -Destination $TemplateTarget -Recurse -Force
}

Write-Step "Preparing build"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

$Version = Get-TangerineVersion
Write-Host "Version: $Version"

Ensure-BuildVenv

Write-Step "Building PyInstaller one-folder"
Push-Location $Root
try {
    & $BuildPython -m PyInstaller packaging\pyinstaller\tangerine.spec --clean --noconfirm
}
finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $DistDir "tangerine.exe"))) {
    throw "PyInstaller did not produce dist\tangerine\tangerine.exe"
}

Copy-Templates

Write-Step "Smoke testing executable"
& (Join-Path $DistDir "tangerine.exe") --version
& (Join-Path $DistDir "tangerine.exe") --help | Out-Null

if ($SkipInstaller) {
    Write-Host "Skipping installer build."
    Write-Host "One-folder output: $DistDir"
    exit 0
}

$Iscc = Find-Iscc
if (-not $Iscc) {
    Write-Warning "Inno Setup ISCC.exe was not found. Install Inno Setup 6 or rerun with -SkipInstaller."
    Write-Host "One-folder output: $DistDir"
    exit 0
}

$GitInstallerUrl = Get-GitInstallerUrl

Write-Step "Building Inno Setup installer"
$env:TANGERINE_VERSION = $Version
$env:TANGERINE_GIT_INSTALLER_URL = $GitInstallerUrl
Push-Location $Root
try {
    & $Iscc packaging\inno\TangerineRindSetup.iss
}
finally {
    Pop-Location
    Remove-Item Env:TANGERINE_VERSION -ErrorAction SilentlyContinue
    Remove-Item Env:TANGERINE_GIT_INSTALLER_URL -ErrorAction SilentlyContinue
}

$Installer = Join-Path $ReleaseDir "TangerineRindSetup-$Version.exe"
if (Test-Path $Installer) {
    Write-Host ""
    Write-Host "Built installer: $Installer" -ForegroundColor Green
} else {
    throw "Installer was not produced at $Installer"
}
