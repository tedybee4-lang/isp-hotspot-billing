# Runs a read-only SQL query against the linked Supabase project.
#
# WHY THIS EXISTS
# ---------------
# `supabase db push` connects straight to Postgres and therefore demands the
# database password interactively, which cannot be answered from an automated
# session. The Management API runs the same SQL with the access token instead, so
# migrations and verification can complete non-interactively.
#
# It reads the access token from the environment and never echoes it, and the SQL
# comes from a file so no secret or quoting-sensitive string passes through a
# shell argument.
#
# Usage:  pwsh -File scripts/supabase-query.ps1 -File scripts/verify-payhero-schema.sql
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$ProjectRef = 'dcqcunmdhyonaewwuama'
)

$ErrorActionPreference = 'Stop'

$token = $env:SUPABASE_ACCESS_TOKEN
if (-not $token) {
  throw 'SUPABASE_ACCESS_TOKEN is not set in the environment.'
}

# Line breaks are normalised to \n but PRESERVED. They must never be flattened to
# spaces: a migration carrying SQL line comments turns
#
#     -- a comment about the statement below
#     create table foo ...
#
# into one long line where the `--` comments out everything after it. The whole
# file then runs as a single comment, the API still answers 201, and the migration
# looks applied while having changed nothing.
#
# That is not hypothetical. The PayHero portal routing migration was deployed this
# way, reported success, and left the production function untouched — which was
# only caught by calling the function afterwards and reading what it actually
# returned. Never trust this script's exit code alone; assert the effect.
$sql = (Get-Content $File -Raw) -replace "`r`n", "`n"

# Manual JSON assembly: ConvertTo-Json mangles multi-line SQL and embedded quotes.
# A literal newline is not valid inside a JSON string, so it must be escaped.
$escaped = $sql.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n')
$payload = '{' + '"query":"' + $escaped + '"' + '}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

$response = Invoke-WebRequest `
  -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body $bytes `
  -ContentType 'application/json; charset=utf-8' `
  -TimeoutSec 120

if ($response.StatusCode -ge 400) {
  throw "Query failed with HTTP $($response.StatusCode)"
}

# The API answers an array of row objects for a SELECT, and nothing for DDL.
$rows = $response.Content | ConvertFrom-Json
if ($rows) {
  $rows | Format-List | Out-String -Width 200 | Write-Output
} else {
  Write-Output 'OK (no rows returned)'
}