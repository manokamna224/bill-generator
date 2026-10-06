# Download open-source handwriting fonts from the google/fonts GitHub repo for offline use.
# Licenses (verified against the google/fonts repo layout, which groups by license dir):
#   ofl/    -> SIL Open Font License 1.1
#   apache/ -> Apache License 2.0
# This script tolerates per-file failure: the web app falls back to a Google Fonts <link>
# (with a visible note) if a file is missing, so the app still runs.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File "d:\bill generator\assets\fonts\download-fonts.ps1"

$ErrorActionPreference = 'Continue'
$dest = $PSScriptRoot
$raw  = 'https://raw.githubusercontent.com/google/fonts/main'

# family, licenseDir, fileName, outFile (url-decoded), license
$fonts = @(
  @{ fam='Patrick Hand';       dir='ofl/patrickhand';        file='PatrickHand-Regular.ttf';  lic='OFL' },
  @{ fam='Caveat';              dir='ofl/caveat';             file='Caveat[wght].ttf';          outFile='Caveat-wght.ttf';          lic='OFL' },   # variable font; brackets break -OutFile, so save to outFile
  @{ fam='Kalam';              dir='ofl/kalam';              file='Kalam-Regular.ttf';         lic='OFL' },
  @{ fam='Indie Flower';       dir='ofl/indieflower';        file='IndieFlower-Regular.ttf';   lic='OFL' },
  @{ fam='Gaegu';              dir='ofl/gaegu';               file='Gaegu-Regular.ttf';         lic='OFL' },
  @{ fam='Shadows Into Light'; dir='ofl/shadowsintolight';   file='ShadowsIntoLight.ttf';      lic='OFL' },
  @{ fam='Homemade Apple';     dir='apache/homemadeapple';   file='HomemadeApple-Regular.ttf'; lic='Apache' },
  @{ fam='Just Another Hand';  dir='apache/justanotherhand'; file='JustAnotherHand-Regular.ttf'; lic='Apache' }
)

# URL-encode brackets for the raw URL (Caveat[wght].ttf -> Caveat%5Bwght%5D.ttf)
function EncName($name) { return $name -replace '\[','%5B' -replace '\]','%5D' }

$ok = 0; $fail = 0
foreach ($f in $fonts) {
  $url = "$raw/$($f.dir)/$(EncName($f.file))"
  $outName = $f.outFile    # if defined, use a bracket-free local name (brackets break -OutFile)
  if (-not $outName) { $outName = ($f.file -replace '%5B','[' -replace '%5D',']') }
  $out = Join-Path $dest $outName
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -ErrorAction Stop
    $sz = [Math]::Round((Get-Item -LiteralPath $out).Length / 1KB)
    Write-Host ("OK   {0,-28} ({1} KB) [{2}]" -f $outName, $sz, $f.lic)
    $ok++
  } catch {
    Write-Host ("FAIL {0,-28} :: {1}" -f $f.file, $_.Exception.Message)
    $fail++
  }
}

# Bundle one copy of each license text alongside the .ttf files.
try {
  Invoke-WebRequest -Uri "$raw/ofl/patrickhand/OFL.txt" -OutFile (Join-Path $dest 'OFL.txt') -UseBasicParsing -ErrorAction Stop
  Write-Host "OK   OFL.txt"
} catch { Write-Host "FAIL OFL.txt :: $($_.Exception.Message)" }
try {
  Invoke-WebRequest -Uri "$raw/apache/homemadeapple/LICENSE.txt" -OutFile (Join-Path $dest 'Apache-2.0.txt') -UseBasicParsing -ErrorAction Stop
  Write-Host "OK   Apache-2.0.txt"
} catch { Write-Host "FAIL Apache-2.0.txt :: $($_.Exception.Message)" }

Write-Host ""
Write-Host "Done. $ok font(s) downloaded, $fail failed."
Write-Host "Any FAIL lines => the app will use the Google Fonts <link> fallback at first load."
