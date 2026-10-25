# Downloads a portable Node.js into runtime\node for ShotCut.bat, checked against nodejs.org's SHA-256 list.
# Works on a clean Windows 10/11: uses curl.exe and tar.exe when they are there, else PowerShell's own commands.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Runtime
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "node-v$Version-win-$arch"
$base = "https://nodejs.org/dist/v$Version"
$zip = Join-Path $Runtime "$name.zip"
New-Item -ItemType Directory -Force $Runtime | Out-Null

function Get-Url([string]$Url, [string]$OutFile) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -fL --retry 3 --progress-bar -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
  }
}

Write-Host "Downloading Node.js $Version ($arch)..."
Get-Url "$base/$name.zip" $zip
$sums = Join-Path $Runtime 'SHASUMS256.txt'
Get-Url "$base/SHASUMS256.txt" $sums
$expected = (Select-String -Path $sums -Pattern "  $name.zip$" | Select-Object -First 1).Line.Split(' ')[0]
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
Remove-Item $sums
if (-not $expected -or $actual -ne $expected) {
  Remove-Item $zip
  throw "The Node.js download is damaged (checksum mismatch). Run ShotCut.bat again."
}

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) {
  & $tar -xf $zip -C $Runtime
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack $zip" }
} else {
  Expand-Archive -Path $zip -DestinationPath $Runtime -Force
}
Remove-Item $zip
$target = Join-Path $Runtime 'node'
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Rename-Item (Join-Path $Runtime $name) 'node'
