$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.12+ from https://nodejs.org first.' }
    $ready = $false
    try { $ready = (Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 2).ok -eq $true } catch {}
    if (-not $ready) {
        if (-not (Test-Path -LiteralPath 'node_modules')) {
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies.' }
        }
        if (-not (Test-Path -LiteralPath 'public/ocr/kaz.traineddata.gz')) {
            & npm.cmd run setup:ocr
            if ($LASTEXITCODE -ne 0) { throw 'Could not prepare OCR models.' }
        }
        & npm.cmd run evaluate
        if ($LASTEXITCODE -ne 0) { throw 'Could not evaluate rules.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
        $taskNode = (Get-Command node).Source
        Start-Process -FilePath $taskNode -ArgumentList 'server/index.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'safenet-server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'safenet-error.log')
        for ($attempt=0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            try { if ((Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 1).ok) { $ready=$true; break } } catch {}
        }
        if (-not $ready) { throw 'Server did not start. See safenet-error.log.' }
    }
    Start-Process 'http://127.0.0.1:4310'
    Write-Host 'SafeNet KZ: http://127.0.0.1:4310' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
