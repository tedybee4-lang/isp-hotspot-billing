<#
.SYNOPSIS
  Applies every migration in supabase/migrations, in filename order.

.DESCRIPTION
  Posts each file to the Supabase Management API /database/query endpoint and
  reports every failure rather than stopping at the first.

  -Reset drops and recreates the public schema first. Destructive. The default
  grants Supabase creates are restored at the end, otherwise PostgREST cannot
  reach any table.

.EXAMPLE
  $env:SB_PAT = "sbp_..."
  powershell -File scripts/apply-migrations.ps1 -ProjectRef abcdefghijklmnop
#>
param(
  [Parameter(Mandatory = $true)][string]$ProjectRef,
  [string]$Dir = 'supabase/migrations',
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$pat = $env:SB_PAT
if (-not $pat) { throw 'Set SB_PAT to a Supabase personal access token.' }

$endpoint = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"
$utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-Sql([string]$sql) {
  $payloadPath = Join-Path $env:TEMP 'sb-sql-payload.json'
  $escaped = ($sql -replace "`r`n", "`n").Replace('\','\\').Replace('"','\"').Replace("`n",'\n').Replace("`t",'\t')
  [System.IO.File]::WriteAllText($payloadPath, '{"query":"' + $escaped + '"}', $utf8)
  $out = curl.exe -s -m 300 -w "`n__HTTP__%{http_code}" -X POST `
    -H "Authorization: Bearer $pat" -H "Content-Type: application/json" `
    --data-binary "@$payloadPath" $endpoint 2>&1
  $code = ($out | Select-String '__HTTP__(\d+)').Matches.Groups[1].Value
  [pscustomobject]@{ Code = $code; Body = ($out -join "`n") }
}

if ($Reset) {
  Write-Host 'Resetting the public schema...' -ForegroundColor Yellow
  $r = Invoke-Sql 'drop schema if exists public cascade; create schema public;'
  if ($r.Code -ne '201') { Write-Host $r.Body -ForegroundColor Red; exit 1 }
  Write-Host '  schema reset' -ForegroundColor Green
}

$failed = $false
Get-ChildItem $Dir -Filter *.sql | Sort-Object Name | ForEach-Object {
  $result = Invoke-Sql (Get-Content $_.FullName -Raw)
  if ($result.Code -eq '201') {
    Write-Host "OK   $($_.Name)" -ForegroundColor Green
  } else {
    Write-Host "FAIL $($_.Name) (HTTP $($result.Code))" -ForegroundColor Red
    Write-Host $result.Body -ForegroundColor Red
    $failed = $true
  }
}

# Grants run last: `grant ... on all tables` only covers existing tables.
$grantLines = @(
  'grant usage on schema public to anon, authenticated, service_role;'
  'grant select, insert, update, delete on all tables in schema public to authenticated;'
  'grant all on all tables in schema public to service_role;'
  'grant usage, select on all sequences in schema public to authenticated, service_role;'
  'grant execute on all functions in schema public to authenticated, service_role;'
  'alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;'
  'alter default privileges in schema public grant all on tables to service_role;'
  'alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;'
  'alter default privileges in schema public grant execute on functions to authenticated, service_role;'
)
$g = Invoke-Sql ($grantLines -join "`n")
if ($g.Code -eq '201') {
  Write-Host 'OK   grants restored' -ForegroundColor Green
} else {
  Write-Host "FAIL grants (HTTP $($g.Code))" -ForegroundColor Red
  Write-Host $g.Body -ForegroundColor Red
  $failed = $true
}

if ($failed) { exit 1 }
Write-Host 'All migrations applied.' -ForegroundColor Green
