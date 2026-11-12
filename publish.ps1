<#
.SYNOPSIS
    在自己的 GitHub 账号下创建公开仓库并推送当前目录。

.DESCRIPTION
    需要一枚有 repo 权限的 Personal Access Token（classic: 勾 repo；fine-grained: 勾
    Administration: Read and write + Contents: Read and write）。

    获取： https://github.com/settings/tokens

.EXAMPLE
    .\publish.ps1 -Token ghp_xxxxxxxxxxxxxxxxxxxx

.EXAMPLE
    $env:GITHUB_TOKEN = "ghp_xxx"; .\publish.ps1
#>

param(
  [string]$Token = $env:GITHUB_TOKEN,
  # 注意：GitHub 仓库名只接受 ASCII（字母/数字/-/_/.），中文名会 422。
  # 所以 slug 用拼音，中文全名放进 Description。
  [string]$RepoName = "SZTU-xingshi-yu-zhengce-autowatch",
  [string]$Description = "SZTU 形势与政策 · 自动观看视频并总结脚本 —— 对分易网课自动观看（倍速伪装 + 进度打点）、视频转写、课程笔记总结。Tampermonkey 用户脚本 + faster-whisper 本地管线。",
  [string]$Owner = "",
  [switch]$Private
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ── git 定位：优先 PATH，其次本机 MinGit 便携包 ────────────────────────
function Resolve-Git {
  $c = Get-Command git -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:USERPROFILE "tools\mingit\cmd\git.exe"
  if (Test-Path $p) { return $p }
  throw "找不到 git。装一个（https://git-scm.com/download/win）或用本机 MinGit：$p"
}
$git = Resolve-Git
Write-Host "git: $git" -ForegroundColor DarkGray

if (-not $Token) {
  Write-Host "`n缺少 GitHub Token。" -ForegroundColor Yellow
  Write-Host "1) 打开 https://github.com/settings/tokens → Generate new token (classic) → 勾 repo"
  Write-Host "2) 然后重新运行：  .\publish.ps1 -Token ghp_你的token`n"
  Write-Host "或者手动两步搞定：" -ForegroundColor Cyan
  Write-Host "  1. 网页上 https://github.com/new 建一个空仓库，名字写：$RepoName （不要勾 README/.gitignore）"
  Write-Host "  2. 在本目录执行："
  Write-Host "     & '$git' remote add origin https://github.com/<你的用户名>/$RepoName.git"
  Write-Host "     & '$git' push -u origin main"
  exit 1
}

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "publish-script"
}

# ── 1. 验证 token ────────────────────────────────────────────────────
Write-Host "`n[1/5] 验证 token …" -ForegroundColor Cyan
$me = Invoke-RestMethod "https://api.github.com/user" -Headers $headers
$login = if ($Owner) { $Owner } else { $me.login }
Write-Host "      登录为 $($me.login)"

# ── 2. 建仓库（已存在则复用） ────────────────────────────────────────
Write-Host "[2/5] 创建仓库 $login/$RepoName …" -ForegroundColor Cyan
$body = @{
  name        = $RepoName
  description = $Description
  private     = [bool]$Private
  has_issues  = $true
  has_wiki    = $false
  auto_init   = $false
} | ConvertTo-Json

$existing = $null
try {
  $existing = Invoke-RestMethod "https://api.github.com/repos/$login/$RepoName" -Headers $headers
} catch { }

if ($existing) {
  Write-Host "      仓库已存在，直接推送" -ForegroundColor Yellow
} else {
  # 中文必须显式转成 UTF-8 字节，否则 Invoke-RestMethod 会按 ANSI 编码把中文变成问号
  $null = Invoke-RestMethod "https://api.github.com/user/repos" -Method Post -Headers $headers `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8"
  Write-Host "      已创建" -ForegroundColor Green
}

# ── 3. git init / commit（如果还没做） ───────────────────────────────
Write-Host "[3/5] 本地提交 …" -ForegroundColor Cyan
if (-not (Test-Path ".git")) {
  & $git init -q
  & $git config user.name  "YG"
  & $git config user.email "yg@users.noreply.github.com"
}
& $git add -A
$st = & $git status --porcelain
if ($st) {
  & $git commit -q -m "feat: 自动观看 + 转写总结 初始版本"
  Write-Host "      已提交 $(($st | Measure-Object).Count) 个文件"
} else {
  Write-Host "      没有新改动，跳过提交"
}

# ── 4. 推送（token 只在这一条命令里出现，不写进 .git/config） ────────
Write-Host "[4/5] 推送到 GitHub …" -ForegroundColor Cyan
$clean = "https://github.com/$login/$RepoName.git"
try { & $git remote remove origin *> $null } catch {}
& $git remote add origin $clean
$pushUrl = "https://x-access-token:$Token@github.com/$login/$RepoName.git"
& $git -c http.extraheader="" push -q $pushUrl "HEAD:refs/heads/main"
if ($LASTEXITCODE -ne 0) { throw "推送失败，看上面的 git 报错" }
Write-Host "      推送完成" -ForegroundColor Green

# ── 5. 打 topics + 确认 ──────────────────────────────────────────────
Write-Host "[5/5] 设置仓库标签 …" -ForegroundColor Cyan
$topics = @(
  "tampermonkey", "userscript", "duifene", "faster-whisper", "whisper",
  "speech-to-text", "yt-dlp", "python", "subtitles", "course-notes", "automation"
)
try {
  Invoke-RestMethod "https://api.github.com/repos/$login/$RepoName/topics" -Method Put -Headers $headers `
    -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ names = $topics } | ConvertTo-Json))) `
    -ContentType "application/json; charset=utf-8" | Out-Null
  Write-Host "      标签：$($topics -join ', ')"
} catch {
  Write-Host "      标签设置失败（不影响仓库）：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n完成 → $clean" -ForegroundColor Green
Write-Host "仓库主页：https://github.com/$login/$RepoName"
Write-Host "`n提示：token 已经不在 .git/config 里了，remote 是干净的 https 地址。"
