param([switch]$Install, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$backendRoot = Join-Path $projectRoot 'services\intelligence'
$frontendRoot = Join-Path $projectRoot 'apps\console'
$runtimeRoot = Join-Path $backendRoot 'runtime'
$pythonExe = Join-Path $backendRoot '.venv\Scripts\python.exe'
$pidFile = Join-Path $runtimeRoot 'local-processes.json'
$env:SAFENET_API_URL = 'http://127.0.0.1:8100'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
function Stop-OwnedProcess($record) {
    $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
    if (-not $process -or $process.StartTime.ToUniversalTime().Ticks -ne $record.StartTicks) { return }
    # Windows venv python.exe launches a child interpreter that owns the port.
    # Capture only descendants of this verified process, then stop leaves first.
    $snapshot = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
    $owned = [System.Collections.Generic.List[object]]::new()
    $owned.Add(@{Id=$process.Id; StartTicks=$record.StartTicks})
    for ($index=0; $index -lt $owned.Count; $index++) {
        $parent = $owned[$index]
        foreach ($child in $snapshot | Where-Object {$_.ParentProcessId -eq $parent.Id}) {
            $ticks = $child.CreationDate.ToUniversalTime().Ticks
            if ($ticks -ge $parent.StartTicks -and $child.ProcessId -notin $owned.Id) {
                $owned.Add(@{Id=[int]$child.ProcessId; StartTicks=$ticks})
            }
        }
    }
    for ($index=$owned.Count-1; $index -ge 0; $index--) {
        $entry = $owned[$index]
        $current = Get-Process -Id $entry.Id -ErrorAction SilentlyContinue
        # CIM CreationDate has microsecond precision; allow sub-microsecond loss.
        if ($current -and [Math]::Abs($current.StartTime.ToUniversalTime().Ticks - $entry.StartTicks) -lt 10) {
            Stop-Process -Id $entry.Id -ErrorAction SilentlyContinue
        }
    }
}
if ($Stop) {
    if (Test-Path -LiteralPath $pidFile) {
        $records = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
        foreach ($record in $records) {
            Stop-OwnedProcess $record
        }
        Remove-Item -LiteralPath $pidFile
    }
    Write-Host 'SafeNet AI processes stopped.'
    exit
}
if ($Install -or -not (Test-Path -LiteralPath $pythonExe)) {
    python -m venv (Join-Path $backendRoot '.venv')
    & $pythonExe -m pip install -r (Join-Path $backendRoot 'requirements.lock.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
    & $pythonExe -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed' }
}
if ($Install -or -not (Test-Path -LiteralPath (Join-Path $frontendRoot 'node_modules'))) {
    Push-Location $frontendRoot
    try {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed' }
    } finally { Pop-Location }
}
if ($Install -or -not (Test-Path -LiteralPath (Join-Path $frontendRoot '.next\BUILD_ID'))) {
    Push-Location $frontendRoot
    try {
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    } finally { Pop-Location }
}
foreach ($port in @(3000, 8100)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Stop the existing process or use the running app."
    }
}
$env:SAFENET_QUEUE = 'local'
$env:SAFENET_LOCAL_ADMIN = 'true'
$env:SAFENET_DATABASE_URL = 'sqlite:///./runtime/safenet.db'
$env:SAFENET_DATABASE_HOST = ''
if (-not $env:SAFENET_LLM_MODEL) {
    try {
        $localModels = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
        if ($localModels.models.name -contains 'qwen3-vl:2b-instruct') {
            $env:SAFENET_LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
            $env:SAFENET_LLM_API_KEY = 'ollama' # Local compatibility token; not a cloud credential.
            $env:SAFENET_LLM_MODEL = 'qwen3-vl:2b-instruct'
            $env:SAFENET_LLM_PROVIDER = 'Local Ollama'
            $env:SAFENET_LLM_TIMEOUT_SECONDS = '30'
            Write-Host 'Using the existing local Ollama model for grounded explanations.'
        }
    } catch { Write-Host 'Local LLM unavailable; deterministic analysis remains enabled.' }
}
$backend = $null
$frontend = $null
try {
$backend = Start-Process -FilePath $pythonExe -ArgumentList @('-m', 'uvicorn', 'safenet.app:app', '--host', '127.0.0.1', '--port', '8100') -WorkingDirectory $backendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'api.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'api.err.log') -PassThru
$nextCli = Join-Path $frontendRoot 'node_modules\next\dist\bin\next'
$frontend = Start-Process -FilePath 'node.exe' -ArgumentList @('"' + $nextCli + '"', 'start', '--hostname', '127.0.0.1', '--port', '3000') -WorkingDirectory $frontendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'web.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'web.err.log') -PassThru
@($backend, $frontend) | ForEach-Object { @{Id=$_.Id; StartTicks=$_.StartTime.ToUniversalTime().Ticks} } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
    foreach ($endpoint in @('http://127.0.0.1:8100/api/v1/health', 'http://127.0.0.1:3000/overview')) {
        $serviceReady = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            try {
                $healthResponse = Invoke-WebRequest -Uri $endpoint -TimeoutSec 2 -UseBasicParsing
                if ($healthResponse.StatusCode -eq 200) { $serviceReady = $true; break }
            } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $serviceReady) { throw "Service did not become ready: $endpoint. Read logs in $runtimeRoot." }
    }
} catch {
    foreach ($ownedProcess in @($backend, $frontend)) {
        if ($ownedProcess -and -not $ownedProcess.HasExited) { Stop-OwnedProcess @{Id=$ownedProcess.Id; StartTicks=$ownedProcess.StartTime.ToUniversalTime().Ticks} }
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    throw
}
Write-Host 'SafeNet AI: http://127.0.0.1:3000 (local administrator, loopback only)'
Write-Host 'API docs: http://127.0.0.1:8100/docs'
Write-Host 'Stop: .\Start-SafeNet-AI.ps1 -Stop'
