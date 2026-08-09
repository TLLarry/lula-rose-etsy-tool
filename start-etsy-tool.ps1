# Launcher for the Lula Rose Etsy tool.
#
# The desktop shortcut used to be a plain Chrome web shortcut pointing at
# http://localhost:5173/. That opens the browser but starts nothing, so it
# only ever worked if the dev server happened to already be running --
# otherwise Chrome shows ERR_CONNECTION_REFUSED. This script starts the
# server first, waits for the port to actually accept connections, and only
# then opens the browser.

$project = $PSScriptRoot
$port = 5173
$url = "http://localhost:$port/"
$timeoutSeconds = 90

# Probe over HTTP rather than opening a raw socket to a hardcoded IP: Vite
# binds to the IPv6 loopback ([::1]:5173) and does NOT listen on 127.0.0.1,
# so a TcpClient aimed at 127.0.0.1 is refused even while the app is up and
# serving fine in the browser. Requesting the URL lets the name resolution
# try both families, the same way Chrome does.
function Test-AppReady {
    param([string]$Address)
    try {
        Invoke-WebRequest -Uri $Address -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Already running (e.g. the shortcut got clicked twice)? Just open the tab
# instead of starting a second server on a fallback port.
if (Test-AppReady -Address $url) {
    Start-Process $url
    exit 0
}

if (-not (Test-Path (Join-Path $project 'package.json'))) {
    Write-Host "Could not find the Etsy tool files in: $project" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Starting the Etsy tool..."
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', 'title Lula Rose Etsy Tool - keep this window open & npm run dev' `
    -WorkingDirectory $project `
    -WindowStyle Minimized

for ($i = 0; $i -lt $timeoutSeconds; $i++) {
    if (Test-AppReady -Address $url) {
        Start-Process $url
        exit 0
    }
    Start-Sleep -Seconds 1
}

Write-Host "The server did not come up within $timeoutSeconds seconds." -ForegroundColor Red
Write-Host "Check the minimized 'Lula Rose Etsy Tool' window for the error." -ForegroundColor Red
Read-Host "Press Enter to close"
exit 1
