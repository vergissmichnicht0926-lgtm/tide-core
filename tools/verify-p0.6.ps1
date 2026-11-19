[CmdletBinding()]
param(
    [string]$ApkPath = '',
    [string]$GatewayRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$AndroidRepo = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\tide-android'),
    [string]$Adb = '',
    [string]$Aapt2 = '',
    [string]$Node = 'node',
    [string]$Serial = '',
    [string]$UserId = 'usr_DHGr7Jln3aaw9xCX',
    [int]$WaitSeconds = 20,
    [switch]$SkipDevice
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date
$stampText = $stamp.ToString('yyyyMMdd-HHmmss')
$dataDir = Join-Path $GatewayRoot 'data'
$reportDir = Join-Path $dataDir 'verify'
$reportPath = Join-Path $reportDir "p0.6-$stampText.md"
$realtimeEnv = Join-Path $dataDir 'realtime.env'
$mintScript = Join-Path $GatewayRoot 'gateway\scripts\mint-access-token.mjs'
$checks = [System.Collections.Generic.List[object]]::new()
$evidence = [System.Collections.Generic.List[string]]::new()
$device = $null
$token = $null

New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    Write-Host "[$mark] $Name - $Detail"
}

function Add-Evidence {
    param([string]$Name, [string]$Text)
    $evidence.Add("### $Name`n`n``````text`n$Text`n``````")
}

function Get-GatewayPid {
    $row = Get-NetTCPConnection -State Listen -LocalPort 7800 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($row) { return [int]$row.OwningProcess }
    return 0
}

function Wait-Gateway {
    param([int]$PreviousPid = 0, [int]$Seconds = 20)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $pidNow = Get-GatewayPid
        if ($pidNow -gt 0 -and $pidNow -ne $PreviousPid) {
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 3
                if ($health.ok) { return $pidNow }
            } catch {}
        }
        Start-Sleep -Milliseconds 500
    }
    throw "网关在 $Seconds 秒内没有恢复"
}

function Restart-Gateway {
    $oldPid = Get-GatewayPid
    if ($oldPid -gt 0) {
        Stop-Process -Id $oldPid -Force
    }
    try {
        $newPid = Wait-Gateway -PreviousPid $oldPid -Seconds $WaitSeconds
    } catch {
        Start-ScheduledTask -TaskName 'TideGateway'
        $newPid = Wait-Gateway -PreviousPid $oldPid -Seconds $WaitSeconds
    }
    return [pscustomobject]@{ OldPid = $oldPid; NewPid = $newPid }
}

function Get-VerifyToken {
    $env:TIDE_DB_PATH = Join-Path $dataDir 'gateway.db'
    $env:TIDE_JWT_SECRET_FILE = Join-Path $dataDir 'jwt-secret.txt'
    $env:TIDE_VERIFY_USER_ID = $UserId
    Remove-Item Env:TIDE_JWT_SECRET -ErrorAction SilentlyContinue
    $value = (& $Node $mintScript).Trim()
    if (-not $value) { throw '生成本地验收 token 失败' }
    return $value
}

function Invoke-TideJson {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )
    $headers = @{ authorization = "Bearer $token" }
    $requestArgs = @{
        Uri = "http://127.0.0.1:7800$Path"
        Method = $Method
        Headers = $headers
        TimeoutSec = 15
        SkipHttpErrorCheck = $true
    }
    if ($null -ne $Body) {
        $requestArgs.ContentType = 'application/json'
        $requestArgs.Body = ($Body | ConvertTo-Json -Compress)
    }
    $res = Invoke-WebRequest @requestArgs
    $json = if ($res.Content) {
        try { $res.Content | ConvertFrom-Json } catch { $null }
    } else { $null }
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Body = $json; Raw = $res.Content }
}

function Resolve-Device {
    & $Adb start-server | Out-Null
    $lines = & $Adb devices
    $devices = @($lines | Select-Object -Skip 1 | Where-Object {
        $_ -match '^\S+\s+device$'
    } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($Serial) {
        if ($devices -notcontains $Serial) { throw "adb 找不到设备 $Serial" }
        return $Serial
    }
    if ($devices.Count -eq 0) { throw 'adb 没有设备；请先连接手机或传 -SkipDevice' }
    if ($devices.Count -gt 1) { throw "检测到多台设备，请传 -Serial：$($devices -join ', ')" }
    return $devices[0]
}

function Get-InstalledVersionCode {
    $dump = & $Adb -s $device shell dumpsys package com.whaleeye.tide
    $match = [regex]::Match(($dump -join "`n"), 'versionCode=(\d+)')
    if (-not $match.Success) { throw '无法读取手机上的 versionCode' }
    return [int]$match.Groups[1].Value
}

function Open-App {
    & $Adb -s $device shell monkey -p com.whaleeye.tide 1 | Out-Null
}

function Get-TideLog {
    (& $Adb -s $device logcat -d -s TideSSE:I) -join "`n"
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$Seconds = 15,
        [string]$Failure = '等待超时'
    )
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Condition
        if ($value) { return $value }
        Start-Sleep -Milliseconds 500
    }
    throw $Failure
}

try {
    if (-not (Test-Path -LiteralPath $ApkPath)) { throw "APK 不存在: $ApkPath" }
    $badging = & $Aapt2 dump badging $ApkPath
    $apkLine = $badging | Select-Object -First 1
    $apkCode = [regex]::Match($apkLine, "versionCode='(\d+)'").Groups[1].Value
    $apkName = [regex]::Match($apkLine, "versionName='([^']+)'").Groups[1].Value
    Add-Check 'APK 版本' ($apkCode -eq '905' -and $apkName -eq '0.9.5') "$apkName / $apkCode"
    Add-Evidence 'APK badging' (($badging | Select-Object -First 3) -join "`n")

    if (-not $SkipDevice) {
        $device = Resolve-Device
        Add-Check 'adb 设备' $true $device
        $install = & $Adb -s $device install -r $ApkPath 2>&1
        Add-Check '安装 APK' (($install -join "`n") -match 'Success') ($install -join ' ')
        Add-Evidence 'adb install' ($install -join "`n")
        $installed = Get-InstalledVersionCode
        Add-Check '手机版本号' ($installed -eq 905) "versionCode=$installed"
        & $Adb -s $device shell pm grant com.whaleeye.tide android.permission.POST_NOTIFICATIONS 2>$null | Out-Null
        & $Adb -s $device shell am force-stop com.whaleeye.tide | Out-Null
        & $Adb -s $device logcat -c
        Open-App
    } else {
        Add-Check 'adb 设备' $true 'SKIP：-SkipDevice'
    }

    $realtimeLines = @(
        'TIDE_REALTIME=user'
        'TIDE_REALTIME_STREAM_ENABLED=1'
        "TIDE_REALTIME_USER_IDS=$UserId"
    )
    [System.IO.File]::WriteAllLines(
        $realtimeEnv,
        $realtimeLines,
        [System.Text.UTF8Encoding]::new($false)
    )
    $restart = Restart-Gateway
    Add-Check '重启到 user 模式' ($restart.NewPid -gt 0) "pid $($restart.OldPid) -> $($restart.NewPid)"

    $token = Get-VerifyToken
    $config = Invoke-TideJson GET '/realtime/config'
    Add-Check 'realtime config' (
        $config.Status -eq 200 -and
        $config.Body.mode -eq 'user' -and
        $config.Body.streamPath -eq '/stream'
    ) ($config.Raw)

    if (-not $SkipDevice) {
        Start-Sleep -Seconds 3
        $logText = Get-TideLog
        Add-Check 'logcat 用户流' ($logText -match '/stream') (($logText -split "`n" | Select-String 'TideSSE' | Select-Object -Last 8) -join "`n")
        Add-Evidence '用户流 logcat' $logText

        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 5
        $openedBefore = [int]$health.realtime.connectionsOpened
        Add-Check 'activeUserConnections' ([int]$health.realtime.activeUserConnections -ge 1) (
            "active=$($health.realtime.activeUserConnections), opened=$openedBefore"
        )

        $list = Invoke-TideJson GET '/conversations'
        $conversations = @($list.Body.conversations)
        Add-Check '至少三个会话' ($conversations.Count -ge 3) "count=$($conversations.Count)"
        $targets = @($conversations | Select-Object -First 3)
        for ($i = 0; $i -lt $targets.Count; $i++) {
            $cid = $targets[$i].id
            $clientMsgId = "p0-6-$stampText-$i"
            $text = "P0.6 verify $stampText #$($i + 1)"
            $sent = Invoke-TideJson POST "/conversations/$cid/prompt" @{
                text = $text
                client_msg_id = $clientMsgId
            }
            Add-Check "发送会话 $($i + 1)" ($sent.Status -eq 200) "cid=$cid status=$($sent.Status)"
            $found = Wait-Until -Seconds 15 -Failure "会话 $cid 没有落库 $clientMsgId" -Condition {
                $page = Invoke-TideJson GET "/conversations/$cid/messages?limit=100"
                @($page.Body.messages | Where-Object { $_.clientMsgId -eq $clientMsgId }).Count -ge 1
            }
            Add-Check "落库会话 $($i + 1)" ($found -eq $true) "client_msg_id=$clientMsgId"
        }

        & $Adb -s $device shell am force-stop com.whaleeye.tide | Out-Null
        Start-Sleep -Seconds 1
        $probe = Invoke-TideJson POST "/conversations/$($targets[0].id)/prompt" @{
            text = "P0.6 resume probe $stampText"
            client_msg_id = "p0-6-resume-$stampText"
        }
        Add-Check '离线补发探针' ($probe.Status -eq 200) "status=$($probe.Status)"
        $healthBeforeResume = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 5
        $replayBefore = [int]$healthBeforeResume.realtime.replayEvents
        Open-App
        $resumeState = Wait-Until -Seconds 20 -Failure '进程重开后没有重新建立用户流' -Condition {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 5
            if ([int]$h.realtime.connectionsOpened -gt $openedBefore -and
                [int]$h.realtime.replayEvents -gt $replayBefore) {
                return $h
            }
            return $null
        }
        Add-Check 'force-stop 后 since 续传' ([bool]$resumeState) "replay $replayBefore -> $($resumeState.realtime.replayEvents)"
        $resumeLog = Get-TideLog
        Add-Check 'logcat 带 since 重连' ($resumeLog -match '/stream\?since=') 'TideSSE'
        Add-Evidence '续传 logcat' $resumeLog
    } else {
        Add-Check '三会话与续传' $true 'SKIP：-SkipDevice'
    }

    Remove-Item -LiteralPath $realtimeEnv -Force -ErrorAction SilentlyContinue
    $fallbackRestart = Restart-Gateway
    $fallbackConfig = Invoke-TideJson GET '/realtime/config'
    Add-Check '回退到 legacy' (
        $fallbackConfig.Status -eq 200 -and $fallbackConfig.Body.mode -eq 'legacy'
    ) ($fallbackConfig.Raw)

    if (-not $SkipDevice) {
        $legacyLog = Wait-Until -Seconds 20 -Failure '没有观察到实时模式切回 legacy' -Condition {
            $text = Get-TideLog
            if ($text -match '(fallback to legacy|realtime mode=legacy)') { return $text }
            return $null
        }
        Add-Check 'logcat legacy 回退' ([bool]$legacyLog) 'fallback to legacy'
        $legacyHealth = Wait-Until -Seconds 10 -Failure '回退后用户流连接没有关闭' -Condition {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 5
            if ([int]$h.realtime.activeUserConnections -eq 0) { return $h }
            return $null
        }
        Add-Check '用户流已关闭' ([bool]$legacyHealth) (
            "active=$($legacyHealth.realtime.activeUserConnections)"
        )
        Add-Evidence 'legacy logcat' $legacyLog
    }
} catch {
    Add-Check '执行异常' $false $_.Exception.Message
} finally {
    Remove-Item -LiteralPath $realtimeEnv -Force -ErrorAction SilentlyContinue
    try {
        $finalPid = Get-GatewayPid
        if ($finalPid -eq 0) { Start-ScheduledTask -TaskName 'TideGateway' | Out-Null }
        $finalHealth = Wait-Until -Seconds 20 -Failure '最终网关 health 不可用' -Condition {
            try {
                $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7800/health' -TimeoutSec 3
                if ($h.ok) { return $h }
            } catch {}
            return $null
        }
        Add-Check '最终网关健康' ([bool]$finalHealth) "pid=$(Get-GatewayPid) mode=legacy"
    } catch {
        Add-Check '最终清理' $false $_.Exception.Message
    }

    $passed = @($checks | Where-Object Ok).Count
    $failed = @($checks | Where-Object { -not $_.Ok }).Count
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('# Tide P0-6 一键验收')
    $lines.Add('')
    $lines.Add("- 时间：$($stamp.ToString('yyyy-MM-dd HH:mm:ss'))")
    $lines.Add("- APK：``$ApkPath``")
    $lines.Add("- 设备：``$device``")
    $lines.Add("- 结果：$passed pass / $failed fail")
    $lines.Add('')
    $lines.Add('| 检查 | 结果 | 详情 |')
    $lines.Add('|---|---|---|')
    foreach ($check in $checks) {
        $mark = if ($check.Ok) { 'PASS' } else { 'FAIL' }
        $detail = ($check.Detail -replace "`r?`n", ' ' -replace '\|', '\|')
        $lines.Add("| $($check.Name) | $mark | $detail |")
    }
    if ($evidence.Count -gt 0) {
        $lines.Add('')
        $lines.Add('## 证据')
        $lines.Add('')
        foreach ($item in $evidence) { $lines.Add($item) }
    }
    $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "报告：$reportPath"
    if ($failed -gt 0) { exit 1 }
}
