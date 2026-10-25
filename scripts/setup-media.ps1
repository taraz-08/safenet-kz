$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$modelDirectory = Join-Path $projectRoot 'data/models/faster-whisper-small'
$pythonCommand = if ($env:SAFENET_PYTHON) { $env:SAFENET_PYTHON } else { 'python' }
& $pythonCommand -c "import faster_whisper, av, huggingface_hub"
if ($LASTEXITCODE -ne 0) { throw 'Install Python dependencies: python -m pip install faster-whisper==1.2.1' }
New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
& $pythonCommand -c "from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id='Systran/faster-whisper-small', revision='536b0662742c02347bc0e980a01041f333bce120', local_dir=sys.argv[1], allow_patterns=['model.bin','config.json','tokenizer.json','vocabulary.txt'])" $modelDirectory
if ($LASTEXITCODE -ne 0) { throw 'Speech model download failed. Run this script again to resume.' }
Write-Output 'Local multilingual speech model ready. Captured audio is processed locally and is not saved.'
