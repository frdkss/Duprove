# The real helper with synthetic executables: tests transaction/rollback, not NSIS.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('duprove-update-' + [guid]::NewGuid())
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$directory = Join-Path $fixture 'profile\updates'
$target = Join-Path $fixture 'app with spaces $ and %'
New-Item -ItemType Directory -Path $directory,$target -Force | Out-Null
$escaped = $directory.Replace('\','\\').Replace('"','\"')
try {
    $source = @"
using System;
using System.IO;
class FixtureApp {
  static int Main(string[] args) {
    var directory = "$escaped";
    if (args.Length > 0 && args[0] == "--duprove-updated") {
      if (File.ReadAllText(Path.Combine(directory, "mode")) == "fail") return 7;
      File.WriteAllText(Path.Combine(directory, "ready"), new string('a',48));
    } else File.WriteAllText(Path.Combine(directory, "old-restarted"), "old");
    return 0;
  }
}
"@
    Add-Type -TypeDefinition $source -OutputAssembly (Join-Path $directory 'new.exe') -OutputType ConsoleApplication
    $installerSource = @"
using System;
using System.IO;
class FixtureInstaller {
  static int Main(string[] args) {
    var index = Array.FindIndex(args, s => s.StartsWith("/D="));
    if (index < 0) return 2;
    var target = string.Join(" ", args, index, args.Length-index).Substring(3);
    File.Copy(Path.Combine("$escaped", "new.exe"), Path.Combine(target,"Duprove.exe"), true);
    File.WriteAllText(Path.Combine(target,"version"), "new");
    return 0;
  }
}
"@
    Add-Type -TypeDefinition $installerSource -OutputAssembly (Join-Path $directory 'package.exe') -OutputType ConsoleApplication
    foreach ($mode in @('success', 'fail')) {
        Copy-Item -LiteralPath (Join-Path $directory 'new.exe') -Destination (Join-Path $target 'Duprove.exe') -Force
        [IO.File]::WriteAllText((Join-Path $target '.duprove-managed'), 'Duprove NSIS per-user v1')
        [IO.File]::WriteAllText((Join-Path $target 'version'), 'old')
        [IO.File]::WriteAllText((Join-Path $directory 'mode'), $mode)
        [IO.File]::WriteAllText((Join-Path $fixture 'profile\statistics-consent.json'), '{"decision":"declined"}')
        $ready = Join-Path $directory 'ready'
        if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
        $job = @{ schema=1; version='1.1.0'; token=('a'*48); parentPid=99999999; target=$target; executable='Duprove.exe'; package=(Join-Path $directory 'package.exe'); sha512=(Get-FileHash -LiteralPath (Join-Path $directory 'package.exe') -Algorithm SHA512).Hash.ToLowerInvariant() }
        $transaction = Join-Path $directory 'transaction.json'
        $job | ConvertTo-Json | Set-Content -LiteralPath $transaction -Encoding UTF8
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'installer\update-windows.ps1') -Transaction $transaction
        $result = Get-Content -LiteralPath (Join-Path $directory 'result.json') -Raw | ConvertFrom-Json
        $expected = if ($mode -eq 'success') { 'installed' } else { 'rolled-back' }
        if ($result.status -ne $expected) { throw "WRONG_RESULT_$mode" }
        $version = Get-Content -LiteralPath (Join-Path $target 'version') -Raw
        if ($version -ne $(if ($mode -eq 'success') { 'new' } else { 'old' })) { throw 'WRONG_VERSION' }
        if ((Get-Content -LiteralPath (Join-Path $fixture 'profile\statistics-consent.json') -Raw) -ne '{"decision":"declined"}') { throw 'PROFILE_CHANGED' }
        Start-Sleep -Milliseconds 300
    }
    Write-Output 'WINDOWS_UPDATE_HELPER_OK: synthetic upgrade, health failure rollback, profile unchanged'
} finally {
    # Resolve and verify this test's unique temporary directory before deletion.
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('duprove-update-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
# The expected rollback invokes the helper with exit code 1. GitHub Actions
# otherwise forwards that stale LASTEXITCODE despite all assertions succeeding.
exit 0
