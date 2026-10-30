$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is missing. Install Node.js LTS with npm, reopen the terminal, and run setup again. See README.md.'
}
Write-Information 'Installing CNCjs, the pendant widget, and the EL400 DRO.' -InformationAction Continue
& node (Join-Path $PSScriptRoot 'scripts/setup.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "Setup failed with exit code $LASTEXITCODE."
}
