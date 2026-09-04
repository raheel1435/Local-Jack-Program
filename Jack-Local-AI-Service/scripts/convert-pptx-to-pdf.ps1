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
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [switch]$InteractiveWorker
)

$ErrorActionPreference = "Stop"

# Root-cause investigation finding: `Write-Error` (and an uncaught `throw`)
# under $ErrorActionPreference = "Stop" both make PowerShell append its own
# multi-line "At <script>:<line> char:<col> / + CategoryInfo... /
# + FullyQualifiedErrorId..." trailer to stderr, even when the message being
# thrown/written is already short and clean -- confirmed live, that trailer
# (not just the original raw COM exception) was itself part of what reached
# the presentation UI. Writing directly to the process's stderr stream
# bypasses PowerShell's error-record formatting entirely.
function Write-CleanError {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    Write-CleanError "STAGE:input_missing|Input file not found: $InputPath"
    exit 1
}

# PPTX visual-fallback fix: a raw COM/automation exception message can be an
# arbitrarily long, OS-localized, multi-line dump (HRESULT, CLSID, a whole
# paragraph of Windows-localized text) -- confirmed live, this was flowing
# UNCHANGED all the way to the presentation UI and rendering as if it were
# slide content. This maps the one HRESULT actually reproduced (0x80070520 --
# ERROR_NO_SUCH_LOGON_SESSION: PowerPoint COM automation requires a genuine
# interactive WinSta0\Default desktop session; nothing in this script can
# conjure one if the OS doesn't have one right now) to a short, actionable,
# English sentence, and otherwise falls back to just the exception's own
# first line, capped -- never the full multi-line/localized text.
function Get-FriendlyComErrorMessage {
    param([string]$RawMessage)

    if ($RawMessage -match "0x80070520" -or $RawMessage -match "\b2148074272\b") {
        return "PowerPoint automation needs an active interactive Windows desktop session, and this machine doesn't have one available right now (common after a Remote Desktop disconnect, a locked/switched session, or the Jack gateway process itself having been orphaned from the terminal that started it). Restart the Jack gateway from a fresh, directly-attached interactive session and try again."
    }
    $firstLine = ($RawMessage -split "`r?`n")[0].Trim()
    if ($firstLine.Length -gt 200) { $firstLine = $firstLine.Substring(0, 200) + "..." }
    if (-not $firstLine) { return "PowerPoint conversion failed for an unknown reason." }
    return $firstLine
}

# Root-cause investigation (PPTX conversion reliability pass): each COM step
# is wrapped in its own try/catch that records WHICH stage failed (via
# $script:LastFailedStage) before re-throwing the ORIGINAL exception
# unmodified (a bare `throw` inside a catch block preserves the exception's
# real .NET type) -- this is what lets the caller's `catch
# [System.Runtime.InteropServices.COMException]` type-matching below keep
# working exactly as before, while also giving Node a specific stage id
# (com_activation / presentation_open / pdf_save) instead of only a generic
# "pptx_conversion_failed", per the structured-error-reporting requirement.
function Export-PresentationPdf {
    param([string]$SourcePath, [string]$DestinationPath)

    $app = $null
    $pres = $null
    $script:LastFailedStage = $null
    try {
        try {
            $app = New-Object -ComObject PowerPoint.Application
        }
        catch {
            $script:LastFailedStage = "com_activation"
            throw
        }

        try {
            # ReadOnly:$true, Untitled:$false, WithWindow:$false
            $pres = $app.Presentations.Open($SourcePath, $true, $false, $false)
        }
        catch {
            $script:LastFailedStage = "presentation_open"
            throw
        }

        try {
            # ppSaveAsPDF = 32
            $pres.SaveAs($DestinationPath, 32)
        }
        catch {
            $script:LastFailedStage = "pdf_save"
            throw
        }
    }
    finally {
        if ($pres) {
            try { $pres.Close() } catch { }
        }
        if ($app) {
            try { $app.Quit() } catch { }
        }
        if ($pres) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null }
        if ($app) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    }
}

$workerErrorPath = "$OutputPath.error"
if ($InteractiveWorker) {
    try {
        Export-PresentationPdf -SourcePath $InputPath -DestinationPath $OutputPath
        if (Test-Path -LiteralPath $workerErrorPath) { Remove-Item -LiteralPath $workerErrorPath -Force }
        exit 0
    }
    catch {
        $stage = if ($script:LastFailedStage) { $script:LastFailedStage } else { "unknown" }
        Set-Content -LiteralPath $workerErrorPath -Value "STAGE:$stage|$($_.Exception.Message)" -Encoding UTF8
        exit 1
    }
}

try {
    Export-PresentationPdf -SourcePath $InputPath -DestinationPath $OutputPath
}
catch [System.Runtime.InteropServices.COMException] {
    # A background gateway can share the desktop session yet lack the
    # interactive logon token Office requires (HRESULT 0x80070520). Delegate
    # only the Office automation step to Explorer's interactive shell, then
    # wait for the same output file. No new window or document is shown.
    $shell = New-Object -ComObject Shell.Application
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InputPath `"$InputPath`" -OutputPath `"$OutputPath`" -InteractiveWorker"
    $shell.ShellExecute("powershell.exe", $arguments, (Split-Path -Parent $PSCommandPath), "open", 0)

    $deadline = (Get-Date).AddSeconds(50)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $OutputPath) -and -not (Test-Path -LiteralPath $workerErrorPath)) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Path -LiteralPath $workerErrorPath) {
        $workerError = Get-Content -LiteralPath $workerErrorPath -Raw
        Remove-Item -LiteralPath $workerErrorPath -Force
        $stage = "unknown"
        $rawMsg = $workerError
        if ($workerError -match "(?s)^STAGE:([a-z_]+)\|(.*)$") {
            $stage = $Matches[1]
            $rawMsg = $Matches[2]
        }
        Write-CleanError "STAGE:$stage|$(Get-FriendlyComErrorMessage -RawMessage $rawMsg)"
        exit 1
    }
    # else: the interactive worker produced the output file successfully --
    # fall through to the final Test-Path check below, same as the
    # non-delegated success path.
}
catch {
    # Any non-COM exception from the direct (non-delegated) attempt -- e.g.
    # a stage-tagged exception Export-PresentationPdf itself re-threw.
    # Written via Write-CleanError (never Write-Error/an uncaught throw) so
    # PowerShell's own verbose uncaught-exception trailer never reaches
    # stderr -- see Write-CleanError's doc comment above.
    $stage = if ($script:LastFailedStage) { $script:LastFailedStage } else { "unknown" }
    Write-CleanError "STAGE:$stage|$(Get-FriendlyComErrorMessage -RawMessage $_.Exception.Message)"
    exit 1
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
    Write-CleanError "STAGE:output_missing|Conversion did not produce an output file."
    exit 1
}
