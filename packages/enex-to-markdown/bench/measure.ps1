# Runs one command and reports its exit code, wall time and peak memory (peak working set) as JSON.
# Windows, PowerShell 7. Used by run.mjs.
#   pwsh -File measure.ps1 -Exe <program> -WorkDir <folder> -Log <file> -TimeoutSec <n> -ArgsB64 <base64 JSON array>
# The arguments travel as base64 JSON, so PowerShell can't take a "-o" or "-q" among them for its own parameter.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$TimeoutSec = 1800,
  [string]$ArgsB64 = ""
)
$argv = @()
if ($ArgsB64) { $argv = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json }
$psi = [System.Diagnostics.ProcessStartInfo]::new($Exe)
foreach ($a in $argv) { $psi.ArgumentList.Add([string]$a) }
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
$peak = 0
$timedOut = $false
while (-not $p.HasExited) {
  try { $p.Refresh(); if ($p.PeakWorkingSet64 -gt $peak) { $peak = $p.PeakWorkingSet64 } } catch {}
  if ($sw.Elapsed.TotalSeconds -gt $TimeoutSec) { $timedOut = $true; $p.Kill($true); break }
  Start-Sleep -Milliseconds 100
}
$p.WaitForExit()
$sw.Stop()
Set-Content -LiteralPath $Log -Value ($out.Result + "`n--- stderr ---`n" + $err.Result) -Encoding utf8
[pscustomobject]@{
  exitCode = $(if ($timedOut) { $null } else { $p.ExitCode })
  seconds  = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  peakMB   = [math]::Round($peak / 1MB)
  timedOut = $timedOut
} | ConvertTo-Json -Compress
