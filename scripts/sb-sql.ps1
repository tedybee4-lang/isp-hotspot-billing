<#
.SYNOPSIS
  Runs one read/write SQL statement against the linked Supabase project.

.DESCRIPTION
  Thin wrapper around the Supabase Management API /database/query endpoint.
  Reads the access token saved by `supabase login`, so it works without
  exporting SB_PAT in every shell.

  This is additive by default: it never drops anything. It is a thin SQL
  runner, so treat the SQL you pass as exactly as dangerous as psql.

.EXAMPLE
  powershell -File scripts/sb-sql.ps1 -Sql "select count(*) from isps"
  powershell -File scripts/sb-sql.ps1 -File supabase/migrations/xxx.sql
#>
param(
  [Parameter(Mandatory = $true)][string]$ProjectRef,
  [string]$Sql,
  [string]$File
)

$ErrorActionPreference = 'Stop'

if (-not $Sql -and -not $File) { throw 'Pass -Sql or -File.' }
if ($Sql -and $File) { throw 'Pass only one of -Sql or -File.' }

$tokenFile = Join-Path $env:USERPROFILE '.supabase\access-token.json'
$pat = $env:SB_PAT
if (-not $pat -and (Test-Path $tokenFile)) {
  $parsed = Get-Content $tokenFile -Raw | ConvertFrom-Json
  $pat = $parsed.sb_token
  if (-not $pat) { $pat = $parsed.token }
}
if (-not $pat) { throw 'No Supabase access token. Run: supabase login' }

$query = if ($File) { Get-Content $File -Raw } else { $Sql }

$endpoint = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"
$payloadPath = Join-Path $env:TEMP 'sb-sql-query.json'
$utf8 = New-Object System.Text.UTF8Encoding $false
$escaped = ($query -replace "`r`n", "`n").
  Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`t", '\t')
[System.IO.File]::WriteAllText($payloadPath, '{"query":"' + $escaped + '"}', $utf8)

$out = curl.exe -s -m 300 -w "`n__HTTP__%{http_code}" -X POST `
  -H "Authorization: Bearer $pat" -H "Content-Type: application/json" `
  --data-binary "@$payloadPath" $endpoint 2>&1
$raw = ($out | Where-Object { $_ -notmatch '^__HTTP__' }) -join "`n"
$code = ($out | Select-String '__HTTP__(\d+)').Matches.Groups[1].Value

Write-Host "HTTP $code"
Write-Host $raw
if ($code -ne '201') { exit 1 }