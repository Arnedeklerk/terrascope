# Link the Terranova source tree into the QGIS plugins folder.
#
# Replaces the make-deploy `cp -r` step with a Windows directory junction
# so `git pull` is enough to update the running plugin — no copy step.
#
# Usage (PowerShell, with QGIS closed):
#     .\scripts\link_plugin.ps1
#
# Optional:
#     .\scripts\link_plugin.ps1 -RepoRoot "D:\code\terranova"
#     .\scripts\link_plugin.ps1 -QgisMajor 3        # for QGIS 3.x profiles

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [int]$QgisMajor   = 0   # 0 = auto-detect
)

$ErrorActionPreference = "Stop"

function Write-Step($msg)    { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg)   { Write-Host "    $msg" -ForegroundColor Yellow }
function Die($msg)           { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- locate source ---------------------------------------------------------
$srcPackage = Join-Path $RepoRoot "src\terranova"
# metadata.txt now lives inside the package (standard QGIS layout), so it
# rides along with the junction automatically — no separate copy needed.
$metadata   = Join-Path $srcPackage "metadata.txt"
if (-not (Test-Path $srcPackage)) { Die "Source not found: $srcPackage" }
if (-not (Test-Path $metadata))   { Die "metadata.txt not found: $metadata" }

Write-Step "Source"
Write-Ok "package:  $srcPackage"
Write-Ok "metadata: $metadata"

# --- locate QGIS profile ---------------------------------------------------
$qgisRoot = Join-Path $env:APPDATA "QGIS"
if (-not (Test-Path $qgisRoot)) {
    Die "QGIS profile folder not found: $qgisRoot. Launch QGIS once first."
}

if ($QgisMajor -eq 0) {
    $candidates = @()
    foreach ($n in 4, 3) {
        $p = Join-Path $qgisRoot "QGIS$n"
        if (Test-Path $p) { $candidates += [pscustomobject]@{ Major = $n; Path = $p } }
    }
    if ($candidates.Count -eq 0) { Die "No QGIS3/QGIS4 profile dir under $qgisRoot." }
    if ($candidates.Count -gt 1) {
        $picked = $candidates | Sort-Object Major -Descending | Select-Object -First 1
        Write-Warn2 "Multiple QGIS profile dirs found; using QGIS$($picked.Major). Override with -QgisMajor."
    } else {
        $picked = $candidates[0]
    }
    $QgisMajor = $picked.Major
}

$profileDir = Join-Path $qgisRoot "QGIS$QgisMajor\profiles\default"
$pluginsDir = Join-Path $profileDir "python\plugins"
$dest       = Join-Path $pluginsDir "terranova"

Write-Step "Target (QGIS$QgisMajor default profile)"
Write-Ok "plugins dir: $pluginsDir"
Write-Ok "destination: $dest"

if (-not (Test-Path $pluginsDir)) {
    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
    Write-Ok "Created plugins dir."
}

# --- check QGIS isn't holding the folder open ------------------------------
$qgisProc = Get-Process -Name "qgis-bin", "qgis" -ErrorAction SilentlyContinue
if ($qgisProc) {
    Die "QGIS is running (PID $($qgisProc.Id -join ', ')). Close it first."
}

# --- remove any existing entry (copy or junction) --------------------------
if (Test-Path $dest) {
    $item = Get-Item $dest -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
        Write-Step "Removing existing junction/symlink"
        # Remove-Item on a junction can be finicky; use cmd's rmdir which
        # always treats reparse points as links, never recurses into target.
        & cmd /c rmdir """$dest""" | Out-Null
        if (Test-Path $dest) { Die "Failed to remove existing link at $dest." }
    } else {
        Write-Step "Removing existing copy"
        Remove-Item -Recurse -Force $dest
    }
    Write-Ok "Removed."
}

# --- create junction -------------------------------------------------------
Write-Step "Creating junction"
New-Item -ItemType Junction -Path $dest -Target $srcPackage | Out-Null
Write-Ok "$dest -> $srcPackage"
Write-Ok "metadata.txt rides along inside the package (no copy needed)."

# --- check the web bundle exists; warn if not ------------------------------
$distIndex = Join-Path $srcPackage "ui_web\dist\index.html"
if (-not (Test-Path $distIndex)) {
    Write-Step "Web bundle"
    Write-Warn2 "ui_web\dist not built yet. The dock will show a 'bundle not found' hint."
    Write-Warn2 "Build it with:"
    Write-Warn2 "  cd `"$srcPackage\ui_web`"; npm install; npm run build"
} else {
    Write-Step "Web bundle"
    Write-Ok "Built bundle present at $distIndex"
}

Write-Host ""
Write-Host "Done. Start QGIS — Terranova should appear under Plugins -> Installed." -ForegroundColor Green
Write-Host "From now on:" -ForegroundColor Green
Write-Host "  cd $RepoRoot; git pull            # for Python changes" -ForegroundColor Green
Write-Host "  cd src\terranova\ui_web; npm run build   # only if ui_web/ changed" -ForegroundColor Green
Write-Host "Then restart QGIS." -ForegroundColor Green
