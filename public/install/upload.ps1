# =====================================================================
#  r2 by bunnxr: terminal upload client (Windows PowerShell)
#
#  Run it with:   irm https://upload.bunnxr.com | iex
#
#  Nothing is installed and nothing is written to this computer: no copy
#  of this script, no config file, no temporary files. Each chunk is read
#  straight out of the source file and written into the request stream,
#  and the password is only ever held in memory.
#
#  Works in Windows PowerShell 5.1 and in PowerShell 7+.
#
#  Sections below:
#    1. settings            6. one file
#    2. small helpers       7. one folder
#    3. path cleaning       8. the prompt
#    4. the API             9. start
#    5. progress display
# =====================================================================

# ---------------------------------------------------------------------
#  1. Settings
# ---------------------------------------------------------------------
$Script:Api      = 'https://files.bunnxr.com'  # the Worker; /cli/* is password-protected
$Script:Dest     = ''                          # folder inside the bucket, '' = top level
$Script:Block    = 1048576                     # 1 MiB: read size, and how often progress is redrawn
$Script:Retries  = 3                           # tries per chunk before a file is given up on
$Script:BarWidth = 26

# Windows PowerShell 5.1 still defaults to older TLS versions on some builds.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

$Script:Password  = ''
$Script:ApiError  = ''
$Script:PartError = ''

# ---------------------------------------------------------------------
#  2. Small helpers
# ---------------------------------------------------------------------
function Say  { param([string]$Text = '') Write-Host $Text }
function Warn { param([string]$Text)      Write-Host $Text -ForegroundColor Yellow }

# 1234567 -> "1.2 MB"
function HumanSize {
  param([double]$Bytes)
  $units = @('B', 'KB', 'MB', 'GB', 'TB')
  $i = 0
  while ($Bytes -ge 1024 -and $i -lt 4) { $Bytes = $Bytes / 1024; $i++ }
  if ($i -eq 0) { return ('{0:N0} {1}' -f $Bytes, $units[$i]) }
  return ('{0:N1} {1}' -f $Bytes, $units[$i])
}

# 95 -> "1m 35s"
function HumanTime {
  param([double]$Seconds)
  if ($Seconds -lt 0) { $Seconds = 0 }
  $s = [int][Math]::Round($Seconds)
  $h = [int]($s / 3600); $m = [int](($s % 3600) / 60); $r = $s % 60
  if ($h -gt 0) { return ('{0}h {1:00}m' -f $h, $m) }
  if ($m -gt 0) { return ('{0}m {1:00}s' -f $m, $r) }
  return ('{0}s' -f $r)
}

# Quote a value so it can go inside a JSON string.
function Esc {
  param([string]$Text)
  if ($null -eq $Text) { return '' }
  return $Text.Replace('\', '\\').Replace('"', '\"')
}

# ---------------------------------------------------------------------
#  3. Path cleaning
#
#  Dragging a file or folder into the window pastes its path at the
#  cursor, and Windows Terminal decorates it in a few different ways:
#    & "C:\Users\me\My Files"     the call operator and quotes
#    "C:\Users\me\report.pdf"     quotes only
#    C:\Users\me\report.pdf       bare
#  so the text is tidied up here before it is used.
# ---------------------------------------------------------------------
function Clean-Path {
  param([string]$Raw)
  $p = $Raw
  if ($null -eq $p) { return '' }
  $p = $p.Trim()
  # Windows Terminal prefixes a dragged path with the call operator when the
  # path contains a space.
  if ($p.StartsWith('& '))  { $p = $p.Substring(2).Trim() }
  elseif ($p.StartsWith('&')) { $p = $p.Substring(1).Trim() }
  # A matching pair of surrounding quotes, single or double.
  if ($p -match '^(["''])(.*)\1$') { $p = $Matches[2] }
  # Some shells escape a space with a backtick when completing a name.
  $p = $p.Replace('` ', ' ')
  # ~ is only expanded when it is typed bare, not when it arrives in a string.
  if ($p -eq '~') { $p = $HOME }
  elseif ($p.StartsWith('~\') -or $p.StartsWith('~/')) { $p = Join-Path $HOME $p.Substring(2) }
  return $p
}

# ---------------------------------------------------------------------
#  4. The API
#
#  Every /cli/ request carries the password as a bearer token. The password
#  is never written to a file and never appears in a URL.
# ---------------------------------------------------------------------
# Pull the Worker's own message out of a failed request.
function Read-ApiError {
  param($ErrorRecord)
  try {
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
      $o = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
      if ($o.error) { return [string]$o.error }
    }
  } catch { }
  $resp = $null
  try { $resp = $ErrorRecord.Exception.Response } catch { }
  if ($resp) {
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
      $reader.Close()
      $o = $text | ConvertFrom-Json
      if ($o.error) { return [string]$o.error }
    } catch { }
    try { return ('the server answered with HTTP {0}' -f [int]$resp.StatusCode) } catch { }
  }
  return [string]$ErrorRecord.Exception.Message
}

# Post a ready-made JSON string and return the parsed answer, or $null.
function Invoke-Api {
  param([string]$Path, [string]$JsonBody)
  $Script:ApiError = ''
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($JsonBody)
    return Invoke-RestMethod -Uri ($Script:Api + $Path) -Method Post `
      -Headers @{ Authorization = ('Bearer ' + $Script:Password) } `
      -ContentType 'application/json' -Body $bytes -TimeoutSec 120
  } catch {
    $Script:ApiError = Read-ApiError $_
    return $null
  }
}

function Request-Password {
  while ($true) {
    $secure = Read-Host -Prompt 'Upload password' -AsSecureString
    if ($null -eq $secure -or $secure.Length -eq 0) {
      Warn 'Nothing entered.'
    } else {
      # Turn the SecureString into text for the Authorization header, then
      # free the unmanaged copy straight away.
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try   { $Script:Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
      $secure.Dispose()

      if (Invoke-Api '/cli/verify' '{}') { return $true }
      $Script:Password = ''
      Warn ('Rejected: ' + $Script:ApiError)
    }
    $again = Read-Host -Prompt 'Try again? [Y/n]'
    if ($again -match '^(n|no)$') { return $false }
  }
}

# ---------------------------------------------------------------------
#  5. Progress display
#
#  One line, redrawn in place. The byte counter is fed by the loop that
#  writes into the request stream, so it tracks real upload progress.
# ---------------------------------------------------------------------
$Script:JTotal = 0      # bytes in the whole job
$Script:JDone  = 0      # bytes finished before the current file
$Script:JStart = [DateTime]::UtcNow
$Script:JFiles = 1      # how many files in the job
$Script:JIndex = 1      # which one is being sent
$Script:JName  = ''     # its name

function Draw {
  param([long]$DoneInFile)
  $done = $Script:JDone + $DoneInFile
  $pct = 0
  if ($Script:JTotal -gt 0) { $pct = [int](($done * 100) / $Script:JTotal) }
  if ($pct -gt 100) { $pct = 100 }
  $fill = [int](($pct * $Script:BarWidth) / 100)
  $bar = ('#' * $fill) + ('.' * ($Script:BarWidth - $fill))

  $elapsed = ([DateTime]::UtcNow - $Script:JStart).TotalSeconds
  if ($elapsed -lt 1) { $elapsed = 1 }
  $rate = $done / $elapsed
  if ($rate -gt 0) { $eta = HumanTime (($Script:JTotal - $done) / $rate) } else { $eta = '--' }

  $line = '[{0}] {1,3}%  {2} / {3}  {4}/s  {5} elapsed  ETA {6}' -f `
    $bar, $pct, (HumanSize $done), (HumanSize $Script:JTotal), (HumanSize $rate),
    (HumanTime $elapsed), $eta
  if ($Script:JFiles -gt 1) {
    $line = $line + ('  ({0}/{1} {2})' -f $Script:JIndex, $Script:JFiles, $Script:JName)
  }
  # The padding wipes whatever the previous, possibly longer, line left behind.
  Write-Host -NoNewline ("`r" + $line.PadRight(118))
}

function Draw-End { Write-Host '' }

# ---------------------------------------------------------------------
#  6. Uploading one file
# ---------------------------------------------------------------------
# Sends one part: reads it from the file a megabyte at a time, writes each
# block into the request stream and returns the ETag R2 gives back.
function Send-Part {
  param([string]$File, [long]$Offset, [long]$Length, [string]$Url, [long]$Base)
  $stream = $null; $body = $null; $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Method = 'PUT'
    $request.ContentLength = $Length
    $request.AllowWriteStreamBuffering = $false   # stream it instead of holding the chunk in memory
    $request.Timeout = 120000
    $request.ReadWriteTimeout = 600000
    try { $request.ServicePoint.Expect100Continue = $false } catch { }

    $stream = [System.IO.File]::OpenRead($File)
    $stream.Position = $Offset
    $body = $request.GetRequestStream()

    $buffer = New-Object byte[] $Script:Block
    $sent = [long]0
    while ($sent -lt $Length) {
      $want = [Math]::Min([long]$buffer.Length, $Length - $sent)
      $read = $stream.Read($buffer, 0, [int]$want)
      if ($read -le 0) { break }
      $body.Write($buffer, 0, $read)
      $sent = $sent + $read
      Draw ($Base + $sent)
    }
    $body.Flush(); $body.Close(); $body = $null

    $response = $request.GetResponse()
    $etag = $response.Headers['ETag']
    $response.Close(); $response = $null
    if ([string]::IsNullOrEmpty($etag)) {
      $Script:PartError = 'R2 did not return an ETag'
      return $null
    }
    # R2 returns the ETag in quotes; it is passed through exactly as the
    # browser uploader passes it, because that is what the complete call wants.
    return $etag
  } catch {
    $Script:PartError = Read-ApiError $_
    return $null
  } finally {
    if ($body)     { try { $body.Close() }     catch { } }
    if ($stream)   { try { $stream.Close() }   catch { } }
    if ($response) { try { $response.Close() } catch { } }
  }
}

# Upload one file into the bucket, optionally inside a relative folder.
function Send-File {
  param([string]$Path, [string]$Rel)
  $item = Get-Item -LiteralPath $Path
  $name = $item.Name
  $size = [long]$item.Length
  $Script:JName = $name

  $initBody = '{"prefix":"' + (Esc $Script:Dest) + '","rel":"' + (Esc $Rel) +
              '","name":"' + (Esc $name) + '","size":' + $size + ',"type":""}'
  $init = Invoke-Api '/cli/upload/init' $initBody
  if (-not $init) { Warn ("{0}: {1}" -f $name, $Script:ApiError); return $false }

  # An empty file is stored by the Worker in the init call itself.
  if ($init.mode -eq 'done') { Draw 0; return $true }

  $key = [string]$init.key
  $uploadId = [string]$init.uploadId
  $partSize = [long]$init.partSize
  $parts = [int]$init.parts
  if (-not $uploadId -or $partSize -le 0 -or $parts -le 0) {
    Warn ("{0}: the server sent an upload it could not describe" -f $name)
    return $false
  }

  $done = New-Object 'System.Collections.Generic.List[string]'
  for ($i = 0; $i -lt $parts; $i++) {
    $n = $i + 1
    $offset = [long]$i * $partSize
    $length = $size - $offset
    if ($length -gt $partSize) { $length = $partSize }

    $etag = $null
    for ($try = 1; $try -le $Script:Retries; $try++) {
      $Script:PartError = ''
      $signed = Invoke-Api '/cli/upload/part' (
        '{"key":"' + (Esc $key) + '","uploadId":"' + (Esc $uploadId) + '","partNumber":' + $n + '}')
      if (-not $signed) {
        $Script:PartError = $Script:ApiError
      } else {
        $etag = Send-Part -File $item.FullName -Offset $offset -Length $length -Url ([string]$signed.url) -Base $offset
        if ($etag) { break }
      }
      Start-Sleep -Seconds ($try * $try)
    }

    if (-not $etag) {
      Draw-End
      Warn ("{0}: chunk {1} failed ({2}). Cleaning up." -f $name, $n, $Script:PartError)
      Invoke-Api '/cli/upload/abort' (
        '{"key":"' + (Esc $key) + '","uploadId":"' + (Esc $uploadId) + '"}') | Out-Null
      return $false
    }
    $done.Add('{"PartNumber":' + $n + ',"ETag":"' + (Esc $etag) + '"}')
  }

  $complete = Invoke-Api '/cli/upload/complete' (
    '{"key":"' + (Esc $key) + '","uploadId":"' + (Esc $uploadId) + '","size":' + $size +
    ',"parts":[' + ($done -join ',') + ']}')
  if (-not $complete) {
    Draw-End
    Warn ("{0}: {1}" -f $name, $Script:ApiError)
    Invoke-Api '/cli/upload/abort' (
      '{"key":"' + (Esc $key) + '","uploadId":"' + (Esc $uploadId) + '"}') | Out-Null
    return $false
  }

  Draw $size
  return $true
}

# One file on its own: set the job up so the bar covers just this file.
function Send-OneFile {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path
  $Script:JTotal = [long]$item.Length
  $Script:JDone = 0
  $Script:JFiles = 1
  $Script:JIndex = 1
  $Script:JStart = [DateTime]::UtcNow
  Say ''
  Say ('Uploading {0}  ({1})' -f $item.Name, (HumanSize $item.Length))
  Draw 0
  if (Send-File -Path $item.FullName -Rel '') {
    Draw-End
    Say ('Done: {0}' -f $item.Name)
  }
}

# ---------------------------------------------------------------------
#  7. Uploading one folder, structure kept
# ---------------------------------------------------------------------
function Send-Folder {
  param([string]$Path)
  $root = (Get-Item -LiteralPath $Path)
  $rootFull = $root.FullName.TrimEnd('\', '/')
  $base = $root.Name

  Say ''
  Say ('Looking through {0} ...' -f $base)

  $skip = @('.DS_Store', 'Thumbs.db')
  $files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction SilentlyContinue |
             Where-Object { $skip -notcontains $_.Name })
  if ($files.Count -eq 0) {
    Warn ('There are no files in {0}.' -f $base)
    return
  }

  $total = [long]0
  foreach ($f in $files) { $total = $total + $f.Length }
  $word = 'files'; if ($files.Count -eq 1) { $word = 'file' }
  Say ('{0} {1}, {2}' -f $files.Count, $word, (HumanSize $total))

  $Script:JTotal = $total
  $Script:JDone = 0
  $Script:JFiles = $files.Count
  $Script:JIndex = 0
  $Script:JStart = [DateTime]::UtcNow

  $failed = 0
  foreach ($f in $files) {
    $Script:JIndex = $Script:JIndex + 1
    # Rebuild the path the file had inside the folder, so the structure
    # is recreated in the bucket under the folder's own name.
    $relPath = $f.FullName.Substring($rootFull.Length).TrimStart('\', '/')
    $relDir = Split-Path -Parent $relPath
    if ($relDir) { $rel = $base + '/' + ($relDir -replace '\\', '/') } else { $rel = $base }

    if (-not (Send-File -Path $f.FullName -Rel $rel)) { $failed = $failed + 1 }
    $Script:JDone = $Script:JDone + $f.Length   # keep the bar honest about what is left
  }

  Draw-End
  if ($failed -eq 0) {
    Say ('Done: {0} ({1} {2})' -f $base, $files.Count, $word)
  } else {
    Warn ('Finished {0} with {1} of {2} failed.' -f $base, $failed, $files.Count)
  }
}

# ---------------------------------------------------------------------
#  8. The prompt
# ---------------------------------------------------------------------
function Show-Usage {
  Say ''
  Say '  file <path>     upload one file'
  Say '  folder <path>   upload a folder and everything in it'
  Say '  <path>          same thing, worked out from the path itself'
  Say '  exit            quit'
  Say ''
  Say '  Drag a file or folder onto this window to paste its path.'
}

function Start-Prompt {
  while ($true) {
    Say ''
    $line = Read-Host -Prompt 'upload'
    if ($null -eq $line) { return }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    # Split off a leading keyword, if there is one.
    $keyword = $line
    $rest = ''
    $space = $line.IndexOf(' ')
    if ($space -gt 0) {
      $keyword = $line.Substring(0, $space)
      $rest = $line.Substring($space + 1)
    }

    if ($keyword -match '^(exit|quit|q)$') { return }
    if ($keyword -match '^(help|\?)$') { Show-Usage; continue }

    if ($keyword -eq 'file' -or $keyword -eq 'folder') {
      if ($rest -eq '') {
        Warn ('Give a path after {0}, or just paste the path on its own.' -f $keyword)
        continue
      }
      $target = Clean-Path $rest
    } else {
      $target = Clean-Path $line
    }

    if ($target -eq '') { Warn 'No path given.'; continue }
    if (-not (Test-Path -LiteralPath $target)) {
      Warn ('Nothing at: {0}' -f $target)
      Warn 'Check the path, or drag the file or folder onto this window.'
      continue
    }

    # The path decides what happens, not the keyword that was typed.
    if (Test-Path -LiteralPath $target -PathType Container) {
      Send-Folder $target
    } else {
      Send-OneFile $target
    }
  }
}

# ---------------------------------------------------------------------
#  9. Start
# ---------------------------------------------------------------------
Say 'r2 by bunnxr: terminal upload'
Say $Script:Api

try {
  if (Request-Password) {
    Say 'Password accepted.'
    Show-Usage
    Start-Prompt
    Say 'Bye.'
  } else {
    Say 'Stopped.'
  }
} finally {
  $Script:Password = ''
}
