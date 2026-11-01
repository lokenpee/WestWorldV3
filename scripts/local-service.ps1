param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [ValidateRange(1, 65535)]
    [int]$Port = 5173,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
$serviceUrl = "http://127.0.0.1:$Port/"

function Get-ProjectService {
    Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {
        $command = $_.CommandLine
        if (!$command -or $command -notmatch "--port(?:=|\s+)$Port(?:\s|$)") { return $false }
        $match = [regex]::Match($command, '(?:"([^"]+vite[\\/]bin[\\/]vite\.js)"|(\S+vite[\\/]bin[\\/]vite\.js))')
        if (!$match.Success) { return $false }
        $scriptPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        [IO.Path]::GetFullPath($scriptPath) -eq $vitePath
    }
}

function Test-ServiceReady {
    try {
        $response = Invoke-WebRequest -Uri ($serviceUrl + '@vite/client') -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = [Threading.Mutex]::new($false, "Local\WestWorldV3-$key-$Port")
$held = $false
try {
    try { $held = $mutex.WaitOne(45000) }
    catch [Threading.AbandonedMutexException] { $held = $true }
    if (!$held) { throw 'Another launch or shutdown is still running. Please try again.' }
    $services = @(Get-ProjectService)
    if ($Action -eq 'stop') {
        foreach ($service in $services) {
            # Recheck identity before stopping a process whose id could have been reused.
            $current = @(Get-ProjectService | Where-Object { $_.ProcessId -eq $service.ProcessId -and $_.CreationDate -eq $service.CreationDate })
            if ($current.Count) { Stop-Process -Id $service.ProcessId -ErrorAction Stop }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (@(Get-ProjectService).Count -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if (@(Get-ProjectService).Count) { throw 'The local service has not stopped. Please try again.' }
        Write-Host 'WestWorldV3 local service is stopped.'
        exit 0
    }
    if ($Action -eq 'status') {
        if ($services.Count -and (Test-ServiceReady)) { Write-Host "Running: $serviceUrl" }
        else { Write-Host 'WestWorldV3 local service is not ready.' }
        exit 0
    }
    $started = $null
    if (!$services.Count) {
        $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        if ($listeners.Port -contains $Port) { throw "Port $Port is occupied by another service. Close that service before starting WestWorldV3." }
        if (!(Test-Path -LiteralPath $vitePath)) { throw 'Dependencies are missing. Run npm install in the project folder first.' }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $logFolder = Join-Path $projectRoot '.vite'
        New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
        $stdout = Join-Path $logFolder "local-service-$Port.stdout.log"
        $stderr = Join-Path $logFolder "local-service-$Port.stderr.log"
        $started = Start-Process -FilePath $node -ArgumentList ('"{0}" --host 127.0.0.1 --port {1} --strictPort' -f $vitePath, $Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $ready = $false
    do {
        if (Test-ServiceReady) { $ready = $true; break }
        if ($started -and $started.HasExited) { break }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$ready -or !@(Get-ProjectService).Count) { throw "Startup did not complete. See .vite/local-service-$Port.stderr.log in the project folder." }
    Write-Host "Running: $serviceUrl"
    if (!$NoBrowser) { Start-Process $serviceUrl }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
