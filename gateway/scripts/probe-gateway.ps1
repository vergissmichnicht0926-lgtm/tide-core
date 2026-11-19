# TideGatewayProbe：网关探活兜底。
# 由计划任务每 5 分钟跑一次；TideGateway 自身循环之外的最后一层。
#
# 判定顺序（任何一步通过就算活着，直接退出）：
#   1) 7800 端口在监听
#   2) GET /health 3 秒内 200
# 都没过才算挂了，此时先 Stop 再 Start（任务可能停在 Running 的僵死态，
# 直接 Start 是空操作——2026-11-14 16:47 那次掉线就是这么漏掉的）。
#
# 每次执行都写：
#   - data\probe.log          一行人类可读日志
#   - data\probe-status.json  机器可读状态（原子写，供控制台读取）

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # <repo>/gateway/scripts -> <repo>
$log = Join-Path $root 'data\probe.log'
$statusPath = Join-Path $root 'data\probe-status.json'
$started = Get-Date
$startedUtc = $started.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

function Write-Probe([string]$msg) {
  $line = '{0} {1}' -f $started.ToString('yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

function Get-TargetPid {
  try {
    $c = Get-NetTCPConnection -LocalPort 7800 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  return $null
}

function Write-Status {
  param(
    [string]$result,
    [string]$reason,
    $restartAt = $null,
    $restartMs = $null,
    $err = $null
  )
  $payload = [ordered]@{
    lastCheckAt = $startedUtc
    lastResult = $result
    lastRestartAt = $restartAt
    restartMs = $restartMs
    targetPid = (Get-TargetPid)
    reason = $reason
    error = $err
  }
  $tmp = $statusPath + '.tmp'
  try {
    $json = $payload | ConvertTo-Json -Compress
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($tmp, $json, $utf8)
    Move-Item -LiteralPath $tmp -Destination $statusPath -Force
  } catch {
    try { [IO.File]::Delete($tmp) } catch { }
  }
}

function Test-Port {
  try {
    return [bool](Get-NetTCPConnection -LocalPort 7800 -State Listen -ErrorAction SilentlyContinue)
  } catch { return $false }
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

try {
  if (Test-Port) {
    Write-Probe 'ok port'
    Write-Status -result 'ok' -reason 'port listening'
    exit 0
  }
  if (Test-Health) {
    Write-Probe 'ok health (port check missed)'
    Write-Status -result 'ok' -reason 'health ok (port check missed)'
    exit 0
  }

  $task = Get-ScheduledTask -TaskName 'TideGateway' -ErrorAction SilentlyContinue
  $state = if ($task) { [string]$task.State } else { 'Unknown' }
  $stuck = $task -and $state -eq 'Running'

  if ($stuck) {
    # 僵死态：任务显示在跑，但没有任何进程在服务 7800。
    Write-Probe "down (task state=$state); stopping stuck task"
    Stop-ScheduledTask -TaskName 'TideGateway' -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 300
      $s = (Get-ScheduledTask -TaskName 'TideGateway' -ErrorAction SilentlyContinue).State
      if ([string]$s -ne 'Running') { break }
    }
  }

  Write-Probe "down (task state=$state); starting TideGateway"
  Start-ScheduledTask -TaskName 'TideGateway' -ErrorAction Stop

  # 给启动留出时间并确认真的起来了
  $up = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Test-Port) -and (Test-Health)) { $up = $true; break }
  }
  if ($up) {
    $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
    $restartAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Write-Probe ('recovered in {0:N1}s' -f ($elapsed / 1000.0))
    $reason = if ($stuck) { 'task stuck; restarted' } else { 'recovered' }
    Write-Status -result 'restarted' -reason $reason -restartAt $restartAt -restartMs $elapsed
    exit 0
  }

  Write-Probe 'FAILED to recover within 10s'
  Write-Status -result 'failed' -reason 'failed to recover'
  exit 1
} catch {
  $msg = ($_.Exception.Message -replace '[\r\n]+', ' ')
  if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
  Write-Probe ('error: ' + $msg)
  Write-Status -result 'failed' -reason 'error' -err $msg
  exit 1
}
