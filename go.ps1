# 一条命令：视频直链 → 下载 → 转写 → 总结
# 用法：
#   .\go.ps1 "https://cdn.xxx.com/lesson.m3u8"
#   .\go.ps1 "https://cdn.xxx.com/lesson.m3u8" -Name 第3讲 -Model medium
#   .\go.ps1 "out\第3讲.mp4" -SkipDownload

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Url,
  [string]$Referer = "https://www.duifene.com/",
  [string]$Model = "small",
  [string]$Name = "",
  [string]$Cookies = "",
  [switch]$SkipDownload,
  [switch]$Fast
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$pyArgs = @("pipeline\run_all.py", $Url, "--referer", $Referer, "--model", $Model)
if ($Name) { $pyArgs += @("--name", $Name) }
if ($Cookies) { $pyArgs += @("--cookies", $Cookies) }
if ($SkipDownload) { $pyArgs += "--skip-download" }
if ($Fast) { $pyArgs += "--fast" }

Write-Host "== 开始：$Url" -ForegroundColor Cyan
python @pyArgs
if ($LASTEXITCODE -ne 0) { Write-Host "!! 中途失败，看上面的提示" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "`n== 产物在 $root\out" -ForegroundColor Green
Get-ChildItem "$root\out" -File | Sort-Object LastWriteTime -Descending |
  Select-Object -First 8 Name, @{n = "大小KB"; e = { [int]($_.Length / 1KB) } } | Format-Table -AutoSize
