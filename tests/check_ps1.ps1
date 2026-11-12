# Parse-check every .ps1 in the repo with the Windows PowerShell AST parser.
# ASCII only on purpose: this file may be executed by PowerShell 5.1,
# which decodes BOM-less files as ANSI and would mangle non-ASCII text.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\check_ps1.ps1
#   pwsh -File tests/check_ps1.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$files = Get-ChildItem -Path $root -Filter *.ps1 -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' }

$failed = 0
foreach ($f in $files) {
    $errors = $null
    $tokens = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $failed++
        Write-Host ("[x] " + $f.Name) -ForegroundColor Red
        $errors | Select-Object -First 3 | ForEach-Object {
            Write-Host ("    line " + $_.Extent.StartLineNumber + ": " + $_.Message)
        }
    }
    else {
        Write-Host ("[ok] " + $f.Name)
    }
}

if ($failed -gt 0) {
    Write-Host "$failed file(s) failed to parse" -ForegroundColor Red
    exit 1
}
Write-Host "all ps1 parse ok"
exit 0
