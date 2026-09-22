$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $ProjectDir "packaging\opencode.json"
$Manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
$Version = [string]$Manifest.version
$Asset = $Manifest.assets.windows_x64
$AssetName = [string]$Asset.name
$ExpectedHash = ([string]$Asset.sha256).ToLowerInvariant()
$DownloadUrl = [string]$Asset.url

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($Architecture -ne "X64") {
    throw "Bundled OpenCode currently supports Windows x64 only; detected $Architecture"
}

$CacheDir = Join-Path $ProjectDir "build\opencode\$Version"
$ArchivePath = Join-Path $CacheDir $AssetName
$ExtractDir = Join-Path $CacheDir "extracted"
$BinaryDir = Join-Path $ProjectDir "src-tauri\binaries"
$Destination = Join-Path $BinaryDir "opencode-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path $CacheDir, $BinaryDir | Out-Null

$Download = $true
if (Test-Path $ArchivePath) {
    $CachedHash = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
    $Download = $CachedHash -ne $ExpectedHash
}
if ($Download) {
    Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $ArchivePath
}

$ActualHash = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedHash) {
    throw "OpenCode checksum mismatch: expected $ExpectedHash, got $ActualHash"
}

if (Test-Path $ExtractDir) {
    Remove-Item -Recurse -Force $ExtractDir
}
Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force
$Candidates = @(Get-ChildItem -Path $ExtractDir -Recurse -File -Filter "opencode.exe")
if ($Candidates.Count -ne 1) {
    throw "Expected exactly one opencode.exe in $AssetName, found $($Candidates.Count)"
}
Copy-Item -Force -Path $Candidates[0].FullName -Destination $Destination

$VersionOutput = (& $Destination --version 2>&1 | Out-String).Trim()
$ExpectedVersionPattern = "(^|\D)v?" + [regex]::Escape($Version) + "(\D|$)"
if ($LASTEXITCODE -ne 0 -or $VersionOutput -notmatch $ExpectedVersionPattern) {
    throw "OpenCode smoke test failed; expected $Version, got '$VersionOutput'"
}
Write-Host "opencode: $Destination ($VersionOutput)"
