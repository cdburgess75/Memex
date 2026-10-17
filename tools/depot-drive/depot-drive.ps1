<#
depot-drive -- open Depot as a drive on this computer, signed in the way the website is.

  depot-drive.ps1 setup https://depot.example.com   sign in once (your browser opens) and save the connection
  depot-drive.ps1 mount [letter or folder]           open the drive (default: the first free drive letter); Ctrl-C closes it
  depot-drive.ps1 status                             who is signed in, and to which Depot
  depot-drive.ps1 signout                            forget the sign-in
  depot-drive.ps1 token                              print a fresh access token (rclone runs this itself)

Needs rclone (https://rclone.org/install/) and WinFsp (https://winfsp.dev) to open the drive.
The sign-in is kept encrypted to your Windows account and renewed on its own; it ends after
30 days unused, or when an administrator switches you off. Served by every Depot at
<depot>/api/docs/depot-drive.ps1. Run with: powershell -ExecutionPolicy Bypass -File depot-drive.ps1 ...
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Arg = ''
)
$ErrorActionPreference = 'Stop'
$ConfDir = Join-Path $env:APPDATA 'depot-drive'
$Conf = Join-Path $ConfDir 'connection.json'
$SecretFile = Join-Path $ConfDir 'signin.txt'
$Self = $PSCommandPath
$Remote = 'depot'

function Say($m) { [Console]::Error.WriteLine($m) }
function Load {
  if (-not (Test-Path $Conf)) { throw 'not set up yet. Run: depot-drive.ps1 setup https://your-depot' }
  Get-Content $Conf -Raw | ConvertFrom-Json
}
# Encrypted with the Windows data protection API: only this account on this computer can read it.
function Keep-Secret($t) { ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $SecretFile }
function Read-Secret {
  if (-not (Test-Path $SecretFile)) { return $null }
  $s = Get-Content $SecretFile -Raw | ConvertTo-SecureString
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
function Post($url, $form) { Invoke-RestMethod -Method Post -Uri $url -Body $form -ContentType 'application/x-www-form-urlencoded' }
function Token-Endpoint($c) { "$($c.keycloak)/realms/$($c.realm)/protocol/openid-connect/token" }
function Who($c, $access) { (Invoke-RestMethod "$($c.keycloak)/realms/$($c.realm)/protocol/openid-connect/userinfo" -Headers @{ Authorization = "Bearer $access" }).email }
function Error-Body { try { $_.ErrorDetails.Message | ConvertFrom-Json } catch { $null } }

function Setup($url) {
  if (-not $url) { throw 'give your Depot''s address, e.g. depot-drive.ps1 setup https://depot.example.com' }
  $url = $url.TrimEnd('/'); if ($url -notmatch '^https?://') { $url = "https://$url" }
  $cfg = Invoke-RestMethod "$url/api/config"
  if (-not $cfg.driveClientId) { throw "$url does not offer the drive (an older Depot?)" }
  $c = [pscustomobject]@{ url = $url; keycloak = $cfg.keycloakUrl; realm = $cfg.keycloakRealm; client = $cfg.driveClientId }
  $dev = Post "$($c.keycloak)/realms/$($c.realm)/protocol/openid-connect/auth/device" @{ client_id = $c.client; scope = 'openid offline_access' }
  $verify = if ($dev.verification_uri_complete) { $dev.verification_uri_complete } else { $dev.verification_uri }
  Say "Sign in to Depot in the browser window that opens (the code there is $($dev.user_code)). Waiting..."
  Start-Process $verify
  $interval = if ($dev.interval) { [int]$dev.interval } else { 5 }
  while ($true) {
    Start-Sleep -Seconds $interval
    try {
      $tok = Post (Token-Endpoint $c) @{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; client_id = $c.client; device_code = $dev.device_code }
      break
    } catch {
      $body = Error-Body
      switch ($body.error) {
        'authorization_pending' { }
        'slow_down' { $interval += 5 }
        default { throw "the sign-in did not finish: $($body.error_description)" }
      }
    }
  }
  if (-not $tok.refresh_token) { throw 'no lasting sign-in came back' }
  New-Item -ItemType Directory -Force $ConfDir | Out-Null
  $c | ConvertTo-Json | Set-Content $Conf
  Keep-Secret $tok.refresh_token
  Say "Signed in to $url as $(Who $c $tok.access_token)."
  Configure-Rclone $c
}

# rclone asks this program for a token whenever Depot wants a fresh one. Written straight
# into rclone's own settings file, so the path to this script may contain spaces.
function Configure-Rclone($c) {
  if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) { Say 'rclone is not installed yet: get it from https://rclone.org/install/ (and WinFsp from https://winfsp.dev), then run: depot-drive.ps1 mount'; return }
  $file = (rclone config file | Select-Object -Last 1).Trim()
  $section = @(
    "[$Remote]", 'type = webdav', "url = $($c.url)/dav/", 'vendor = other',
    "bearer_token_command = powershell -NoProfile -ExecutionPolicy Bypass -File `"$Self`" token", ''
  ) -join "`r`n"
  $existing = if (Test-Path $file) { Get-Content $file -Raw } else { '' }
  $kept = [regex]::Replace($existing, "(?ms)^\[$Remote\]\r?\n.*?(?=^\[|\z)", '')
  New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
  Set-Content $file ($kept.TrimEnd() + "`r`n`r`n" + $section)
  Say "Depot is set up for rclone as `"$Remote`:`". Open it with: depot-drive.ps1 mount"
}

function Token {
  $c = Load
  $refresh = Read-Secret
  if (-not $refresh) { throw "not signed in. Run: depot-drive.ps1 setup $($c.url)" }
  try { $tok = Post (Token-Endpoint $c) @{ grant_type = 'refresh_token'; client_id = $c.client; refresh_token = $refresh } }
  catch { throw "your Depot sign-in has ended. Run: depot-drive.ps1 setup $($c.url)" }
  if ($tok.refresh_token -and $tok.refresh_token -ne $refresh) { Keep-Secret $tok.refresh_token }
  Write-Output $tok.access_token
}

function Mount-Drive($where) {
  $c = Load
  if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) { throw 'rclone is not installed: get it from https://rclone.org/install/ (and WinFsp from https://winfsp.dev)' }
  if (-not ((rclone listremotes) -contains "$Remote`:")) { Configure-Rclone $c }
  if (-not $where) { $where = '*' }
  Say "Opening Depot at $where. Leave this window open; Ctrl-C closes the drive."
  & rclone mount "$Remote`:" $where --vfs-cache-mode full --volname Depot
}

function Status {
  $c = Load
  try { $access = Token } catch { Say "Set up for $($c.url), but not signed in. Run: depot-drive.ps1 setup $($c.url)"; exit 1 }
  Say "Signed in to $($c.url) as $(Who $c $access)."
}

function Signout {
  $c = Load
  $refresh = Read-Secret
  if ($refresh) { try { Post "$($c.keycloak)/realms/$($c.realm)/protocol/openid-connect/logout" @{ client_id = $c.client; refresh_token = $refresh } | Out-Null } catch { } }
  Remove-Item $SecretFile -ErrorAction SilentlyContinue
  Say "Signed out of $($c.url) on this computer."
}

switch ($Command) {
  'setup'   { Setup $Arg }
  'mount'   { Mount-Drive $Arg }
  'token'   { Token }
  'status'  { Status }
  'signout' { Signout }
  default   { Get-Content $Self | Select-Object -Skip 1 -First 7 | ForEach-Object { Say $_ }; exit 2 }
}
