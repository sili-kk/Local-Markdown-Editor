param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '../docs/resources'),
  [int]$SampleMilliseconds = 500
)

$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverExecutable = Join-Path $projectDirectory 'md-editor.exe'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('go-editor-resource-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testDirectory) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$logicalProcessors = [Environment]::ProcessorCount
$results = New-Object 'Collections.Generic.List[object]'
$serverProcess = $null
$loadProcess = $null

function Save-Json($value, [string]$path) {
  [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $value -Depth 12), $utf8)
}

try {
  $loadExecutable = Join-Path $testDirectory 'loadcheck.exe'
  & go build -o $loadExecutable (Join-Path $projectDirectory 'tools/loadcheck')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot build load tool' }
  $documents = Join-Path $testDirectory 'documents'
  [IO.Directory]::CreateDirectory($documents) | Out-Null
  $paragraph = "A complete fixture paragraph with **bold** and a link for resource measurement.`n`n"
  foreach ($number in 0..127) {
    $text = '# Loadcheck ' + $number + "`n`n" + ($paragraph * 200)
    [IO.File]::WriteAllText((Join-Path $documents ('.loadcheck-{0:D3}.md' -f $number)), $text.Substring(0, 14 * 1024), $utf8)
  }
  [IO.File]::WriteAllText((Join-Path $documents '.loadcheck-large.md'), ($paragraph * 6000).Substring(0, 434 * 1024), $utf8)
  $scenarios = @(
    @{ Name = 'idle'; Seconds = 20; Args = @() },
    @{ Name = 'users-200-sse'; Seconds = 35; Args = @('-mode','users','-concurrency','200','-ramp','5s','-duration','30s','-distinct-ips','-same-document','-events','-remote') },
    @{ Name = 'users-1000-sse'; Seconds = 50; Args = @('-mode','users','-concurrency','1000','-ramp','10s','-duration','40s','-distinct-ips','-same-document','-events','-remote') },
    @{ Name = 'mixed-100'; Seconds = 20; Args = @('-mode','mixed','-concurrency','100','-duration','20s','-remote') }
  )
  foreach ($scenario in $scenarios) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    $configuration = @"
host: 127.0.0.1
port: $port
docs_dir: [./documents]
server_ips: []
file_operations: false
permissions:
  default: rw
  rules: []
memory:
  server_mb: 256
  document_mb: 128
log:
  dir: ./logs
  max_size_mb: 10
  max_backups: 5
  max_age_days: 7
  compress: true
"@
    [IO.File]::WriteAllText((Join-Path $testDirectory 'config.yaml'), $configuration, $utf8)
    $serverProcess = Start-Process -FilePath $serverExecutable -ArgumentList @('-config','config.yaml') -WorkingDirectory $testDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $testDirectory 'server-out.txt') -RedirectStandardError (Join-Path $testDirectory 'server-error.txt') -PassThru
    $baseUrl = 'http://127.0.0.1:' + $port
    $ready = $false
    foreach ($attempt in 1..100) {
      if ($serverProcess.HasExited) { throw 'Isolated server exited during startup' }
      try { $null = Invoke-RestMethod ($baseUrl + '/api/files') -TimeoutSec 1; $ready = $true; break } catch { Start-Sleep -Milliseconds 100 }
    }
    if (!$ready) { throw 'Isolated server did not become ready' }
    Start-Sleep -Milliseconds 1000
    $serverProcess.Refresh()
    $cpuStart = $serverProcess.TotalProcessorTime.TotalSeconds
    $cpuPrevious = $cpuStart
    $previousSeconds = 0.0
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $samples = New-Object 'Collections.Generic.List[object]'
    $loadResultPath = Join-Path $testDirectory ('load-' + $scenario.Name + '.json')
    if ($scenario.Args.Count -gt 0) {
      $arguments = @('-url',$baseUrl) + $scenario.Args + @('-out',$loadResultPath)
      $loadProcess = Start-Process -FilePath $loadExecutable -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $testDirectory 'load-out.txt') -RedirectStandardError (Join-Path $testDirectory 'load-error.txt') -PassThru
      $null = $loadProcess.Handle
    }
    Write-Output ('START ' + $scenario.Name)
    while ($true) {
      Start-Sleep -Milliseconds $SampleMilliseconds
      if ($serverProcess.HasExited) { throw 'Isolated server exited during measurement' }
      $serverProcess.Refresh()
      $seconds = $timer.Elapsed.TotalSeconds
      $cpu = $serverProcess.TotalProcessorTime.TotalSeconds
      $cpuSingleCorePercent = 100.0 * ($cpu - $cpuPrevious) / ($seconds - $previousSeconds)
      $samples.Add([pscustomobject]@{
        elapsed_seconds = [math]::Round($seconds, 4)
        working_set_mib = [math]::Round($serverProcess.WorkingSet64 / 1MB, 4)
        private_bytes_mib = [math]::Round($serverProcess.PrivateMemorySize64 / 1MB, 4)
        cpu_one_core_percent = [math]::Round($cpuSingleCorePercent, 4)
        cpu_machine_percent = [math]::Round($cpuSingleCorePercent / $logicalProcessors, 4)
      })
      $cpuPrevious = $cpu; $previousSeconds = $seconds
      if ($null -ne $loadProcess -and $loadProcess.HasExited) { break }
      if ($null -eq $loadProcess -and $seconds -ge $scenario.Seconds) { break }
      if ($seconds -gt $scenario.Seconds + 90) { throw 'Load tool exceeded scenario deadline' }
    }
    $timer.Stop()
    if ($null -ne $loadProcess) {
      $loadProcess.WaitForExit()
      if ($loadProcess.ExitCode -ne 0) {
        $loadError = [IO.File]::ReadAllText((Join-Path $testDirectory 'load-error.txt'))
        throw ('Load tool failed: ' + $loadProcess.ExitCode + ' ' + $loadError)
      }
    }
    $load = $null
    if (Test-Path -LiteralPath $loadResultPath) {
      $load = Get-Content -LiteralPath $loadResultPath -Raw | ConvertFrom-Json
      Save-Json $load (Join-Path $OutputDirectory ('load-' + $scenario.Name + '.json'))
    }
    $cpuAverage = 100.0 * ($cpuPrevious - $cpuStart) / $previousSeconds
    $result = [pscustomobject]@{
      scenario = $scenario.Name
      measured_seconds = [math]::Round($previousSeconds, 4)
      sample_interval_target_ms = $SampleMilliseconds
      samples = $samples.Count
      cpu_seconds = [math]::Round($cpuPrevious - $cpuStart, 5)
      cpu_one_core_percent_average = [math]::Round($cpuAverage, 4)
      cpu_machine_percent_average = [math]::Round($cpuAverage / $logicalProcessors, 4)
      cpu_machine_percent_peak_sample = [math]::Round(($samples | Measure-Object cpu_machine_percent -Maximum).Maximum, 4)
      cpu_one_core_percent_peak_sample = [math]::Round(($samples | Measure-Object cpu_one_core_percent -Maximum).Maximum, 4)
      working_set_mib_average = [math]::Round(($samples | Measure-Object working_set_mib -Average).Average, 4)
      working_set_mib_peak_sample = [math]::Round(($samples | Measure-Object working_set_mib -Maximum).Maximum, 4)
      private_bytes_mib_average = [math]::Round(($samples | Measure-Object private_bytes_mib -Average).Average, 4)
      private_bytes_mib_peak_sample = [math]::Round(($samples | Measure-Object private_bytes_mib -Maximum).Maximum, 4)
      load = $load
    }
    $results.Add($result)
    Save-Json $samples.ToArray() (Join-Path $OutputDirectory ('samples-' + $scenario.Name + '.json'))
    Write-Output ('DONE ' + $scenario.Name + ': CPU=' + $result.cpu_machine_percent_average + '%; WS peak=' + $result.working_set_mib_peak_sample + ' MiB')
    $serverProcess.Kill(); $serverProcess.WaitForExit(); $serverProcess = $null; $loadProcess = $null
    Save-Json ([pscustomobject]@{
      node = 'TEST-NODE-01'
      sampled_at_local = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      logical_processors = $logicalProcessors
      server_sha256 = (Get-FileHash -LiteralPath $serverExecutable -Algorithm SHA256).Hash
      process_scope = 'server only; excludes load client and sampler'
      memory = @{ server_mb = 256; document_mb = 128 }
      scenarios = $results.ToArray()
    }) (Join-Path $OutputDirectory 'summary.json')
  }
} finally {
  foreach ($taskProcess in @($loadProcess, $serverProcess)) {
    if ($null -ne $taskProcess -and !$taskProcess.HasExited) { $taskProcess.Kill(); $taskProcess.WaitForExit() }
  }
  $resolvedTestDirectory = [IO.Path]::GetFullPath($testDirectory)
  $resolvedTempDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (!$resolvedTestDirectory.StartsWith($resolvedTempDirectory, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path -Leaf $resolvedTestDirectory).StartsWith('go-editor-resource-')) { throw 'Refusing cleanup outside the task temporary directory' }
  Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
}
