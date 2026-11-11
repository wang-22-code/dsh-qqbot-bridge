param(
  [string]$Package = 'dsh-qqbot-bridge',
  [string]$Version = '',
  [string]$Profile = 'qqbot',
  [string]$Registry = ''
)

$ErrorActionPreference = 'Stop'
$spec = if ($Version) { "$Package@$Version" } else { $Package }
$dsh = Get-Command dsh -ErrorAction SilentlyContinue

if ($dsh) {
  $arguments = @('plugin', '--profile', $Profile, 'add', $spec)
  if ($Registry) { $arguments += @('--registry', $Registry) }
  & $dsh.Source @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "安装完成。首次启动会显示腾讯官方绑定二维码："
  Write-Host "  dsh --profile $Profile"
  exit 0
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$bin = Join-Path $dshHome 'profiles\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $bin)) {
  throw "未找到 dsh CLI。请安装 @deepseek-ai/dsh，或设置 DSH_HOME。"
}

$arguments = @($bin, 'plugin', '--profile', $Profile, 'add', $spec)
if ($Registry) { $arguments += @('--registry', $Registry) }
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "安装完成。首次启动会显示腾讯官方绑定二维码："
Write-Host "  node `"$bin`" --profile $Profile"
exit 0
