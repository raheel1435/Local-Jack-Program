<#
.SYNOPSIS
  Decrypts a Windows-DPAPI-encrypted secret (written by dpapi-protect.ps1)
  and writes the plaintext to stdout.

.DESCRIPTION
  Part of the BYOK credential store (Jack multi-provider milestone). Only
  usable under the same Windows user account that encrypted the file --
  DataProtectionScope.CurrentUser ciphertext is not portable across
  accounts or machines, so decryption failing there is expected, not a bug.
  The plaintext is written directly to stdout with no trailing newline (via
  [Console]::Out.Write, bypassing PowerShell's normal output formatting) so
  the caller reads back exactly the original key bytes.

.PARAMETER InFile
  Path to the DPAPI ciphertext file to decrypt.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$InFile
)

$ErrorActionPreference = "Stop"

try {
    if (-not (Test-Path -LiteralPath $InFile)) {
        throw "Ciphertext file not found: $InFile"
    }

    $cipherBytes = [System.IO.File]::ReadAllBytes($InFile)
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $cipherBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $plaintext = [System.Text.Encoding]::UTF8.GetString($plainBytes)

    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::Out.Write($plaintext)
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}