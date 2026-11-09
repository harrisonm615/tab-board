# Installs Tabs & Progress on Windows: the VS Code side bar, and the tab-board plugin each Claude chat uses to report to it.
# Paste this into PowerShell:   irm https://raw.githubusercontent.com/harrisonm615/tab-board/main/install.ps1 | iex
# Run it again any time to bring both up to date. It needs no administrator rights. It changes nothing outside VS Code and
# Claude Code, except that if your PC has no Python it puts python.org's own copy in your own Programs folder, just for you.
# Everything runs from the last line, so a download cut short runs nothing.

function Install-TabsAndProgress {
  # Not 'Stop': Windows PowerShell 5 turns a program's ordinary stderr into a fatal error under it. Each step that can fail says -ErrorAction Stop instead.
  $ErrorActionPreference = 'Continue'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar makes downloads many times slower
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $base = if ($env:TAB_BOARD_BASE) { $env:TAB_BOARD_BASE } else { 'https://raw.githubusercontent.com/harrisonm615/tab-board/main' }
  $marketplace = if ($env:TAB_BOARD_MARKETPLACE) { $env:TAB_BOARD_MARKETPLACE } else { 'harrisonm615/tab-board' }
  $zip = if ($env:TAB_BOARD_ZIP) { $env:TAB_BOARD_ZIP } else { 'https://codeload.github.com/harrisonm615/tab-board/zip/refs/heads/main' }
  $pythonVersion = '3.12.10'

  function Stop-Install([string]$message) {
    throw [System.InvalidOperationException]::new($message)
  }

  function Find-Code {
    $places = @(
      $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd' }),
      $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd' }),
      $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd' })
    )
    foreach ($place in $places) { if ($place -and (Test-Path -LiteralPath $place)) { return $place } }
    $onPath = Get-Command code.cmd -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
  }

  # The VS Code extension's own copy first, since most people have no claude command.
  function Find-Claude {
    $root = Join-Path $env:USERPROFILE '.vscode\extensions'
    $copies = @(Get-ChildItem -LiteralPath $root -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending)
    if ($copies.Count -gt 0) { return $copies[0] }
    $onPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
  }

  # The same places, in the same order, as the side bar looks: python.org's copy in your own Programs folder, one for everyone, then the py launcher.
  # A bare "python" isn't trusted: on Windows that's often a stand-in that opens the Microsoft Store.
  function Find-Python {
    $roots = @($(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Python' }), $env:ProgramFiles)
    foreach ($root in $roots) {
      if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
      $found = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^Python3(\d+)' } |
        Sort-Object { [int]([regex]::Match($_.Name, '^Python3(\d+)').Groups[1].Value) } -Descending |
        ForEach-Object { Join-Path $_.FullName 'python.exe' } |
        Where-Object { Test-Path -LiteralPath $_ })
      if ($found.Count -gt 0) { return , @($found[0]) }
    }
    $launcher = Join-Path $env:SystemRoot 'py.exe'
    if (Test-Path -LiteralPath $launcher) { return , @($launcher, '-3') }
    return $null
  }

  function Test-Python($python) {
    if (-not $python) { return $false }
    $rest = @($python | Select-Object -Skip 1)
    try {
      $answer = & $python[0] @rest -I -c 'import sqlite3, sys; print(sys.version_info >= (3, 9))' 2>$null
      return ("$answer".Trim() -eq 'True')
    } catch {
      return $false
    }
  }

  # python.org's installer, checked to be signed by the Python Software Foundation before it runs. Just for this user, so no admin box.
  function Install-Python {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $name = "python-$pythonVersion-$arch.exe"
    $file = Join-Path $env:TEMP $name
    Write-Host "Your PC has no Python, which the side bar needs. Getting python.org's $pythonVersion, just for you (about 25 MB)..."
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$pythonVersion/$name" -OutFile $file -UseBasicParsing -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or "$($signature.SignerCertificate.Subject)" -notmatch 'Python Software Foundation') {
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      Stop-Install "The Python download wasn't signed by the Python Software Foundation, so it wasn't run. Nothing else was changed."
    }
    $options = @('/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Shortcuts=0', 'AssociateFiles=0')
    $run = Start-Process -FilePath $file -ArgumentList $options -Wait -PassThru -ErrorAction Stop
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if ($run.ExitCode -ne 0) { Stop-Install "Python didn't install (code $($run.ExitCode)). Run this again, or send this message to whoever shared it." }
  }

  # Claude Code fetches a plugin with git. Without git, a copy of the same files from GitHub stands in; running this again refreshes it.
  function Install-Plugin($claude) {
    $listed = (& $claude plugin list 2>$null | Out-String)
    if ($listed -match 'tab-board') {
      & $claude plugin marketplace update tab-board *> $null
      & $claude plugin update tab-board@tab-board *> $null
      return ($LASTEXITCODE -eq 0)
    }
    $hasGit = (Get-Command git -ErrorAction SilentlyContinue) -and -not $env:TAB_BOARD_TEST_NO_GIT
    $source = $marketplace
    if (-not $hasGit -and $source -notmatch '^[A-Za-z]:\\') {
      $folder = Join-Path $env:USERPROFILE '.claude\tab-board-plugin'
      $download = Join-Path $env:TEMP 'tab-board.zip'
      $unpacked = Join-Path $env:TEMP 'tab-board-unpacked'
      Invoke-WebRequest -Uri $zip -OutFile $download -UseBasicParsing -ErrorAction Stop
      Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction SilentlyContinue
      Expand-Archive -LiteralPath $download -DestinationPath $unpacked -Force -ErrorAction Stop
      $inner = @(Get-ChildItem -LiteralPath $unpacked -Directory)[0].FullName
      Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $inner -Destination $folder -ErrorAction Stop
      Remove-Item -LiteralPath $download, $unpacked -Recurse -Force -ErrorAction SilentlyContinue
      $source = $folder
    }
    & $claude plugin marketplace add $source *> $null
    & $claude plugin install tab-board@tab-board *> $null
    return ($LASTEXITCODE -eq 0)
  }

  function Install-SideBar($code) {
    $file = Join-Path $env:TEMP 'progress-sidebar.vsix'
    Invoke-WebRequest -Uri "$base/sidebar/progress-sidebar.vsix" -OutFile $file -UseBasicParsing -ErrorAction Stop
    & $code --install-extension $file --force *> $null
    $ok = ($LASTEXITCODE -eq 0)
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    return $ok
  }

  $code = Find-Code
  if (-not $code) { Stop-Install "VS Code isn't installed. Install it from code.visualstudio.com, then run this again. Nothing was installed." }
  $claude = Find-Claude
  if (-not $claude) { Stop-Install "Claude Code isn't installed. Add the Claude Code extension in VS Code, then run this again. Nothing was installed." }
  Set-Location -LiteralPath $env:USERPROFILE -ErrorAction Stop

  if (-not (Test-Python (Find-Python)) -or $env:TAB_BOARD_TEST_NO_PYTHON) {
    Install-Python
    if (-not (Test-Python (Find-Python))) { Stop-Install "Python installed but doesn't run. Send this message to whoever shared it. Nothing else was changed." }
  }

  Write-Host 'Installing the tab-board plugin...'
  if (-not (Install-Plugin $claude)) { Stop-Install "The plugin didn't install, so the side bar wasn't installed either. Run this again, or send this message to whoever shared it." }

  Write-Host 'Installing the side bar...'
  if (-not (Install-SideBar $code)) { Stop-Install "The plugin installed, but the side bar didn't. Run this again, or send this message to whoever shared it." }

  Write-Host ''
  Write-Host 'Done. In VS Code, press Ctrl+Shift+P and run Developer: Reload Window.'
  Write-Host 'A reload stops whatever your chats are running, so wait for a quiet moment.'
  Write-Host 'Tabs & Progress then shows up as an icon on the left edge of the window.'
}

try {
  Install-TabsAndProgress
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
}
