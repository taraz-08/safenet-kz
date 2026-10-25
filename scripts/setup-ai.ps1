$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $runtimeDirectory = Join-Path $projectRoot 'data/runtime'
  $executable = Join-Path $runtimeDirectory 'ollama/ollama.exe'
  if (-not (Test-Path -LiteralPath $executable)) {
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    $archive = Join-Path $runtimeDirectory 'ollama-windows-amd64.zip'
    & curl.exe -L --fail --retry 2 --output $archive 'https://github.com/ollama/ollama/releases/download/v0.40.10/ollama-windows-amd64.zip'
    if ($LASTEXITCODE -ne 0) { throw 'Ollama download failed.' }
    $expectedHash = 'd52aea2d323bdd324bf66a4b1226844aa5fb665cc5974fbcceceda1ce3d934eb'
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Ollama checksum mismatch.' }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtimeDirectory 'ollama') -Force
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $executable
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Ollama Inc\.') { throw 'Ollama publisher signature is not valid.' }
  & node --input-type=module -e "import {ensureLocalAiRuntime} from './server/local-ai-runtime.mjs'; const status=await ensureLocalAiRuntime(); if(!status.available)process.exit(1); console.log(status)"
  if ($LASTEXITCODE -ne 0) { throw 'Local AI runtime did not start.' }
  $previousOllamaHost = $env:OLLAMA_HOST
  try {
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    & $executable pull qwen3-vl:2b-instruct
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Run again to resume.' }
  } finally { $env:OLLAMA_HOST = $previousOllamaHost }
  Write-Output 'Qwen3-VL 2B is installed locally. SafeNet starts Ollama automatically on the next launch.'
} finally { Pop-Location }
