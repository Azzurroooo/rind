#define MyAppName "Rind"
#define MyAppExeName "rind.exe"
#define MyAppPublisher "Rind"
#define MyAppVersion GetEnv("RIND_VERSION")
#if MyAppVersion == ""
  #define MyAppVersion "0.2.0"
#endif
#define GitInstallerUrl GetEnv("RIND_GIT_INSTALLER_URL")

[Setup]
AppId={{6A8C6D27-1B13-4D2F-9A70-2EE7C91F4B45}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Rind
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\release
OutputBaseFilename=RindSetup-{#MyAppVersion}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\..\dist\rind\rind.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: core
Source: "..\..\dist\rind\_internal\*"; DestDir: "{app}\_internal"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: core
Source: "..\..\dist\rind\templates\*"; DestDir: "{app}\templates"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: core

[Types]
Name: "full"; Description: "Full installation"
Name: "compact"; Description: "Compact installation"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "core"; Description: "Rind CLI"; Types: full compact custom; Flags: fixed

[Tasks]
Name: "add_rind_path"; Description: "Add Rind to user PATH"; Flags: checkedonce

[Icons]
Name: "{group}\Rind"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall Rind"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{code:AddPaths|{app}}"; Check: AnyPathTaskSelected()

[Code]
const
  WM_SETTINGCHANGE = $001A;
  GitInstallerFileName = 'GitForWindowsSetup.exe';
  GitInstallerUrl = '{#GitInstallerUrl}';

var
  GitOptionPage: TInputOptionWizardPage;
  DownloadPage: TDownloadWizardPage;
  ExistingGitPath: String;
  ShouldInstallGit: Boolean;

function SendMessageTimeout(hWnd: LongWord; Msg: LongWord; wParam: LongWord; lParam: String;
  fuFlags: LongWord; uTimeout: LongWord; var lpdwResult: LongWord): LongWord;
  external 'SendMessageTimeoutW@user32.dll stdcall';

function CurrentUserPath(): String;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Result) then
    Result := '';
end;

function PathContains(Dir, PathValue: String): Boolean;
var
  Parts: TArrayOfString;
  I: Integer;
  CleanDir: String;
  CleanPart: String;
begin
  Result := False;
  CleanDir := RemoveBackslashUnlessRoot(Dir);
  StringChangeEx(CleanDir, '/', '\', True);
  Parts := StringSplit(PathValue, [';'], stExcludeEmpty);
  for I := 0 to GetArrayLength(Parts) - 1 do
  begin
    CleanPart := RemoveBackslashUnlessRoot(ExpandConstant(Parts[I]));
    StringChangeEx(CleanPart, '/', '\', True);
    if CompareText(CleanPart, CleanDir) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function AddPath(PathValue, Dir: String): String;
begin
  if PathValue = '' then
    Result := Dir
  else if PathContains(Dir, PathValue) then
    Result := PathValue
  else
    Result := PathValue + ';' + Dir;
end;

function AddPaths(Param: String): String;
var
  PathValue: String;
begin
  PathValue := CurrentUserPath();
  if WizardIsTaskSelected('add_rind_path') then
    PathValue := AddPath(PathValue, ExpandConstant('{app}'));
  Result := PathValue;
end;

function AnyPathTaskSelected(): Boolean;
begin
  Result := WizardIsTaskSelected('add_rind_path');
end;

function RemovePath(PathValue, Dir: String): String;
var
  Parts: TArrayOfString;
  I: Integer;
  NewPath: String;
  CleanDir: String;
  CleanPart: String;
begin
  Parts := StringSplit(PathValue, [';'], stExcludeEmpty);
  NewPath := '';
  CleanDir := RemoveBackslashUnlessRoot(Dir);
  StringChangeEx(CleanDir, '/', '\', True);
  for I := 0 to GetArrayLength(Parts) - 1 do
  begin
    CleanPart := RemoveBackslashUnlessRoot(ExpandConstant(Parts[I]));
    StringChangeEx(CleanPart, '/', '\', True);
    if CompareText(CleanPart, CleanDir) <> 0 then
    begin
      if NewPath <> '' then
        NewPath := NewPath + ';';
      NewPath := NewPath + Parts[I];
    end;
  end;
  Result := NewPath;
end;

procedure RemoveInstallPaths();
var
  PathValue: String;
begin
  PathValue := CurrentUserPath();
  PathValue := RemovePath(PathValue, ExpandConstant('{app}'));
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', PathValue);
end;

procedure BroadcastEnvironmentChange();
var
  ResultCode: LongWord;
begin
  SendMessageTimeout($FFFF, WM_SETTINGCHANGE, 0, 'Environment', 2, 5000, ResultCode);
end;

function TryGitCandidate(Path: String; var GitPath: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if not FileExists(Path) then
    Exit;
  if Exec(Path, '--version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    GitPath := Path;
    Result := True;
  end;
end;

function DetectGit(var GitPath: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  GitPath := '';

  if Exec('git.exe', '--version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    GitPath := 'git.exe';
    Result := True;
    Exit;
  end;

  if TryGitCandidate(ExpandConstant('{autopf}\Git\cmd\git.exe'), GitPath) then
  begin
    Result := True;
    Exit;
  end;
  if TryGitCandidate(ExpandConstant('{pf}\Git\cmd\git.exe'), GitPath) then
  begin
    Result := True;
    Exit;
  end;
  if TryGitCandidate(ExpandConstant('{pf32}\Git\cmd\git.exe'), GitPath) then
  begin
    Result := True;
    Exit;
  end;
  if TryGitCandidate(ExpandConstant('{localappdata}\Programs\Git\cmd\git.exe'), GitPath) then
  begin
    Result := True;
    Exit;
  end;
end;

function GitInstallerRequested(): Boolean;
begin
  Result := ShouldInstallGit and (GitInstallerUrl <> '');
end;

function GitInstallInfPath(): String;
begin
  Result := ExpandConstant('{tmp}\rind-git-install-options.inf');
end;

procedure WriteGitInstallInf();
var
  Lines: String;
begin
  Lines :=
    '[Setup]' + #13#10 +
    'Lang=default' + #13#10 +
    'Dir=' + #13#10 +
    'Group=Git' + #13#10 +
    'NoIcons=0' + #13#10 +
    'SetupType=default' + #13#10 +
    'Components=gitlfs,assoc,assoc_sh' + #13#10 +
    'Tasks=' + #13#10 +
    'EditorOption=VIM' + #13#10 +
    'CustomEditorPath=' + #13#10 +
    'DefaultBranchOption=' + #13#10 +
    'PathOption=Cmd' + #13#10 +
    'SSHOption=OpenSSH' + #13#10 +
    'TortoiseOption=false' + #13#10 +
    'CURLOption=OpenSSL' + #13#10 +
    'CRLFOption=CRLFAlways' + #13#10 +
    'BashTerminalOption=MinTTY' + #13#10 +
    'GitPullBehaviorOption=Merge' + #13#10 +
    'UseCredentialManager=Enabled' + #13#10 +
    'PerformanceTweaksFSCache=Enabled' + #13#10 +
    'EnableSymlinks=Disabled' + #13#10 +
    'EnablePseudoConsoleSupport=Disabled' + #13#10 +
    'EnableFSMonitor=Disabled' + #13#10;
  SaveStringToFile(GitInstallInfPath(), Lines, False);
end;

function InstallGitForWindows(): Boolean;
var
  ResultCode: Integer;
  InstallerPath: String;
  Error: String;
begin
  Result := True;
  if not GitInstallerRequested() then
    Exit;

  DownloadPage.Clear;
  DownloadPage.Add(GitInstallerUrl, GitInstallerFileName, '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        Error := 'Git for Windows download was canceled.'
      else
        Error := Format('Could not download Git for Windows from %s. %s', [GitInstallerUrl, GetExceptionMessage]);
      Log(Error);
      SuppressibleMsgBox(Error + #13#10#13#10 + 'Rind will continue installing and can fall back to PowerShell.', mbInformation, MB_OK, IDOK);
      Result := True;
      Exit;
    end;
  finally
    DownloadPage.Hide;
  end;

  InstallerPath := ExpandConstant('{tmp}\' + GitInstallerFileName);
  if not FileExists(InstallerPath) then
  begin
    Log('Git installer was not found after download: ' + InstallerPath);
    SuppressibleMsgBox('The Git installer was not found after download. Rind will continue installing.', mbInformation, MB_OK, IDOK);
    Result := True;
    Exit;
  end;

  WriteGitInstallInf();
  if not Exec(InstallerPath, '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOADINF="' + GitInstallInfPath() + '"',
    '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
  begin
    SuppressibleMsgBox('Git for Windows could not be started. Rind will continue installing.', mbInformation, MB_OK, IDOK);
    Result := True;
    Exit;
  end;

  if ResultCode <> 0 then
  begin
    SuppressibleMsgBox(Format('Git for Windows installer exited with code %d. Rind will continue installing.', [ResultCode]),
      mbInformation, MB_OK, IDOK);
    Result := True;
    Exit;
  end;

  BroadcastEnvironmentChange();
end;

function UserSettingsDir(): String;
var
  ProfileDir: String;
begin
  ProfileDir := ExpandConstant('{%USERPROFILE}');
  if ProfileDir = '' then
    ProfileDir := ExpandConstant('{userprofile}');
  Result := AddBackslash(ProfileDir) + '.rind';
end;

function UserSettingsPath(): String;
begin
  Result := UserSettingsDir() + '\settings.json';
end;

procedure EnsureUserSettings();
var
  TemplatePath: String;
begin
  if not DirExists(UserSettingsDir()) then
    ForceDirectories(UserSettingsDir());

  if FileExists(UserSettingsPath()) then
  begin
    Log('User settings already exist: ' + UserSettingsPath());
    Exit;
  end;

  TemplatePath := ExpandConstant('{app}\templates\settings.json');
  if FileExists(TemplatePath) then
  begin
    if not CopyFile(TemplatePath, UserSettingsPath(), True) then
      Log('Failed to copy settings template to ' + UserSettingsPath());
  end
  else
  begin
    SaveStringToFile(
      UserSettingsPath(),
      '{' + #13#10 +
      '  "model": "gpt-5.5",' + #13#10 +
      '  "apiKey": "",' + #13#10 +
      '  "baseUrl": "",' + #13#10 +
      '  "reasoningEffort": "xhigh"' + #13#10 +
      '}' + #13#10,
      False);
  end;
end;

procedure InitializeWizard();
begin
  ShouldInstallGit := False;
  DetectGit(ExistingGitPath);

  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;

  if (ExistingGitPath = '') and (GitInstallerUrl <> '') then
  begin
    GitOptionPage := CreateInputOptionPage(
      wpSelectTasks,
      'Git for Windows',
      'Install Git for a richer Rind programming experience',
      'Git was not detected on this computer. Installing the full official Git for Windows is recommended because it provides Git plus a richer command-line toolchain for coding tasks.',
      True,
      False);
    GitOptionPage.Add('Download and install Git for Windows now');
    GitOptionPage.Values[0] := True;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (GitOptionPage <> nil) and (CurPageID = GitOptionPage.ID) then
    ShouldInstallGit := GitOptionPage.Values[0];

  if CurPageID = wpReady then
    Result := InstallGitForWindows();
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    EnsureUserSettings();
    BroadcastEnvironmentChange();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveInstallPaths();
    BroadcastEnvironmentChange();
  end;
end;
