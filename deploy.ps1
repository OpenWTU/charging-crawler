# 一键部署：构建前端 -> 测试 -> 构建 APK -> 打包 -> 上传 -> 远端部署 -> 自检
#
# 与旧版的区别（重构后必须这样）：
#   后端已从单文件 app.py 拆成 cloud/*.py + cloud/http/*.py 共 26 个模块，
#   只 scp app.py 会让服务起不来；这里改为打包整体同步，并先备份数据库与代码。
#
# 用法：
#   pwsh -File deploy.ps1              # 全量（含 APK）
#   pwsh -File deploy.ps1 -SkipApk     # 只发服务端（不动 APK/版本）
#   pwsh -File deploy.ps1 -SkipBuild   # 跳过构建，直接部署当前产物
param(
    [switch]$SkipApk,
    [switch]$SkipBuild,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 本机配置（不入仓库）----
# 优先级：deploy.local.ps1 > 环境变量 > 默认值（工具走 PATH）
$localCfg = Join-Path $root 'deploy.local.ps1'
if (Test-Path $localCfg) { . $localCfg }

$node = if ($cfgNode) { $cfgNode } elseif ($env:CHARGE_DEPLOY_NODE) { $env:CHARGE_DEPLOY_NODE } else { 'node' }
$pnpm = if ($cfgPnpm) { $cfgPnpm } elseif ($env:CHARGE_DEPLOY_PNPM) { $env:CHARGE_DEPLOY_PNPM } else { 'pnpm' }
$py = if ($cfgPy) { $cfgPy } elseif ($env:CHARGE_DEPLOY_PY) { $env:CHARGE_DEPLOY_PY } else { 'python' }
$sshKey = if ($cfgSshKey) { $cfgSshKey } elseif ($env:CHARGE_DEPLOY_KEY) { $env:CHARGE_DEPLOY_KEY } else { Join-Path $env:USERPROFILE '.ssh\id_rsa' }
$hostName = if ($cfgHost) { $cfgHost } elseif ($env:CHARGE_DEPLOY_HOST) { $env:CHARGE_DEPLOY_HOST } else { '' }

$publicUrl = if ($cfgPublicUrl) { $cfgPublicUrl } elseif ($env:CHARGE_DEPLOY_URL) { $env:CHARGE_DEPLOY_URL } else { '' }

if (-not $hostName) {
    throw '未配置部署目标：请复制 deploy.local.ps1.example 为 deploy.local.ps1 并填写 $cfgHost / $cfgSshKey，或设置环境变量 CHARGE_DEPLOY_HOST / CHARGE_DEPLOY_KEY。'
}
if ($node -eq 'node') { $nodeBin = $null } else { $nodeBin = Split-Path $node -Parent }

function Assert-Exit([string]$step) {
    if ($LASTEXITCODE -ne 0) { throw "$step 失败，退出码 $LASTEXITCODE" }
}

$stage = Join-Path $env:TEMP 'charge-deploy-stage'
$tarball = Join-Path $env:TEMP 'charge-deploy.tgz'

if (-not $SkipBuild) {
    Write-Host '[1/7] 构建前端'
    if ($nodeBin) { $env:Path = "$nodeBin;$env:Path" }
    $env:CI = 'true'
    Push-Location "$root\webui"
    & $node $pnpm --config.verify-deps-before-run=false run build
    Assert-Exit 'webui build'
    Pop-Location
} else { Write-Host '[1/7] 跳过构建前端' }

if (-not $SkipTests) {
    Write-Host '[2/7] 服务端测试'
    Push-Location $root
    & $py -X utf8 -m unittest discover -s tests
    Assert-Exit 'server tests'
    Pop-Location
} else { Write-Host '[2/7] 跳过测试' }

if (-not $SkipApk) {
    Write-Host '[3/7] 构建 APK（版本号见 android/build.py）'
    Push-Location $root
    & $py android\build.py
    Assert-Exit 'android build'
    Pop-Location
} else { Write-Host '[3/7] 跳过 APK' }

Write-Host '[4/7] 组装 staging'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\cloud\http", "$stage\crawler", "$stage\web" | Out-Null
Copy-Item "$root\cloud\*.py" "$stage\cloud\"
Copy-Item "$root\cloud\http\*.py" "$stage\cloud\http\"
Get-ChildItem "$root\crawler" -Recurse -File | Where-Object { $_.FullName -notmatch '__pycache__' } | ForEach-Object {
    $rel = $_.FullName.Substring("$root\crawler".Length).TrimStart('\')
    $dst = Join-Path "$stage\crawler" $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
    Copy-Item $_.FullName $dst -Force
}
Copy-Item "$root\cloud\web\dist\*" "$stage\web\" -Recurse
$n = (Get-ChildItem $stage -Recurse -File).Count
Write-Host "      staging 文件数: $n"

Write-Host '[5/7] 打包并上传'
Push-Location $stage
& tar.exe -czf $tarball .
Assert-Exit 'tar'
Pop-Location
& scp -i $sshKey -o BatchMode=yes $tarball "${hostName}:/tmp/charge-deploy.tgz"
Assert-Exit 'scp tarball'
& scp -i $sshKey -o BatchMode=yes "$root\cloud\deploy\deploy-remote.sh" "${hostName}:/tmp/deploy-remote.sh"
Assert-Exit 'scp remote script'
if (-not $SkipApk) {
    # PS 5.1 默认按 GBK 读无 BOM 文件，JSON 里的中文会读坏，必须显式 UTF8
    $ver = Get-Content "$root\cloud\data\version_clean.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $apkName = "app-v$($ver.versionName).apk"
    & scp -i $sshKey -o BatchMode=yes "$root\android\build\app-debug.apk" "${hostName}:/var/lib/charge-cloud/download/$apkName"
    Assert-Exit 'scp apk'
    & scp -i $sshKey -o BatchMode=yes "$root\cloud\data\version_clean.json" "${hostName}:/var/lib/charge-cloud/version_clean.json.tmp"
    Assert-Exit 'scp version.json'
    # 远端再落到最终位置，避免 scp 覆盖正在被读取的 version.json 时读到半个文件
    & ssh -i $sshKey -o BatchMode=yes $hostName "install -o www-data -g www-data -m 644 /var/lib/charge-cloud/version_clean.json.tmp /var/lib/charge-cloud/version.json && rm -f /var/lib/charge-cloud/version_clean.json.tmp"
    Assert-Exit 'install version.json'
    Write-Host "      APK: $apkName"
}

Write-Host '[6/7] 远端部署（备份 -> 同步 -> 重启 -> 自检）'
& ssh -i $sshKey -o BatchMode=yes $hostName "bash /tmp/deploy-remote.sh /tmp/charge-deploy.tgz"
Assert-Exit 'remote deploy'

Write-Host '[7/7] 完成'
if ($publicUrl) {
    & ssh -i $sshKey -o BatchMode=yes $hostName "curl -s $publicUrl/api/version"
} else {
    & ssh -i $sshKey -o BatchMode=yes $hostName "curl -s http://127.0.0.1:8788/api/version"
}
Write-Host ''
Write-Host '如需回滚：见上一步输出的第 10 段命令（代码 tgz + 部署前数据库备份）。'
