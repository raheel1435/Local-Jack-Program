# Converts a .pptx file to a faithful .pdf using local PowerPoint COM
# automation -- real slide layout, fonts, and images, not the app's
# simplified text-extraction fallback. Requires PowerPoint installed on
# this machine. Invoked by Jack-Local-AI-Service's /jack/convert-pptx route,
# one call per conversion; the caller (Node) enforces the overall timeout
# and deletes the input/output temp files afterward.
#
# PowerPoint's automation model has no reliable fully-headless mode --
# WithWindow:=$false keeps the presentation window from opening, but a
# visible PowerPoint process can still flash briefly. This is a known,
# accepted limitation of COM automation, not a bug to chase here.
param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputPath)) {
    Write-Error "Input file not found: $InputPath"
    exit 1
}

$app = $null
$pres = $null
try {
    $app = New-Object -ComObject PowerPoint.Application

    # ReadOnly:$true, Untitled:$false, WithWindow:$false
    $pres = $app.Presentations.Open($InputPath, $true, $false, $false)

    # ppSaveAsPDF = 32
    $pres.SaveAs($OutputPath, 32)
}
finally {
    if ($pres) {
        try { $pres.Close() } catch { }
    }
    if ($app) {
        try { $app.Quit() } catch { }
    }
    # Release COM references explicitly -- PowerPoint can otherwise linger
    # as an orphaned background process after automation, especially on a
    # forced/timed-out exit.
    if ($pres) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null }
    if ($app) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
    Write-Error "Conversion did not produce an output file."
    exit 1
}
