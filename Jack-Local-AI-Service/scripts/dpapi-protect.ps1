<#
.SYNOPSIS
  Encrypts a secret read from stdin using Windows DPAPI (CurrentUser scope)
  and writes the ciphertext bytes to -OutFile.

.DESCRIPTION
  Part of the BYOK credential store (Jack multi-provider milestone). The
  plaintext key is read from stdin only -- it is never accepted as a
  command-line argument (which would appear in process listings) and never
  written to an intermediate temp file. DataProtectionScope.CurrentUser ties
  the ciphertext to the logged-in Windows account: the resulting .dat file
  is unreadable even if copied to another machine or read by another user
  account on this one.

.PARAMETER OutFile
  Path to write the encrypted ciphertext bytes to.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$OutFile
)

$ErrorActionPreference = "Stop"

try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $plaintext = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($plaintext)) {
        throw "No plaintext was provided on stdin."
    }

    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plaintext)
    $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    $outDir = Split-Path -Parent $OutFile
    if (-not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($OutFile, $cipherBytes)
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}