param([string]$Python = (Join-Path $PSScriptRoot '..\engine\.venv\Scripts\python.exe'))
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath $Python)) {
    throw 'Specifica -Python con un interprete CPython che abbia le dipendenze di engine/requirements.txt e PyInstaller.'
}
$env:PYTHONDONTWRITEBYTECODE = '1'
Push-Location $projectRoot
try {
    & $Python -B -m PyInstaller --noconfirm --distpath engine-dist --workpath engine-build engine/worker.spec
    if ($LASTEXITCODE -ne 0) { throw 'Creazione del motore DuckyMovie non riuscita.' }
} finally {
    Pop-Location
}
