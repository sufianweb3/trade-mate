# Starts the OI Sniper agent in this console window.
# Optional: allow an extra panel origin (e.g. a Vercel preview URL):  .\scripts\start-agent.ps1 -PanelOrigin https://xyz.vercel.app
param([string]$PanelOrigin = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\apps\agent")
$env:OISNIPER_NO_OPEN = "1"
$origins = @("https://oisniper.vercel.app")
if ($PanelOrigin) { $origins = @($PanelOrigin) + $origins }
$env:OISNIPER_PANEL_ORIGIN = $origins -join ","
node dist/main.js
