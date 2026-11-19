param([int]$Port = 5194)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'codex-files'
$taskPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
$taskLibrary = Join-Path $runtimeRoot 'figures'
foreach ($folder in @('config','app-data','mplconfig','tmp','logs','figures','pycache')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot $folder) | Out-Null
}
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "Port $Port is already in use; no second process was started."
    exit 1
}
$env:TAVOTTO_CONFIG_DIR = Join-Path $runtimeRoot 'config'
$env:TAVOTTO_DATA_DIR = Join-Path $runtimeRoot 'app-data'
$env:MPLCONFIGDIR = Join-Path $runtimeRoot 'mplconfig'
$env:TEMP = Join-Path $runtimeRoot 'tmp'
$env:TMP = $env:TEMP
$env:PYTHONPYCACHEPREFIX = Join-Path $runtimeRoot 'pycache'
$env:PYTHONUTF8 = '1'
$env:TAVOTTO_NO_TELEMETRY = '1'
$env:TAVOTTO_NO_UPDATE_CHECK = '1'
& $taskPython -m tavotto open $taskLibrary --no-launch --json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'logs\registration.json') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Figure registration failed.' }
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-m','tavotto','--figures',('"'+$taskLibrary+'"'),'--port',"$Port",'--no-browser') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'logs\server.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'logs\server.stderr.log')
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'logs\server.pid')
Write-Output "BatFig development process $($taskProcess.Id): http://127.0.0.1:$Port/"
$taskStartupLog = Join-Path $runtimeRoot 'logs\server.stdout.log'
for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if ($taskProcess.HasExited) { throw 'BatFig exited during startup; inspect codex-files/logs/server.stderr.log.' }
    if (Test-Path -LiteralPath $taskStartupLog) {
        $taskStartupContent = [string](Get-Content -LiteralPath $taskStartupLog -Raw -ErrorAction SilentlyContinue)
        $taskMatch = [regex]::Match($taskStartupContent, ('http://127\.0\.0\.1:'+$Port+'/#dnonce=[^\s]+'))
        if ($taskMatch.Success) {
            Write-Output ('Open this local session link: '+$taskMatch.Value)
            break
        }
    }
    Start-Sleep -Milliseconds 200
}
