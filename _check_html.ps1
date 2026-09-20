$node = "C:\Program Files\nodejs\node.exe"
$dir = "c:\Users\HomePC\Desktop\saf\Starlinks\starlink-reseller"
$tmp = Join-Path $env:TEMP "sl_inline_check"
if (!(Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }

$pages = Get-ChildItem -Path $dir -Recurse -Filter *.html
foreach ($page in $pages) {
  $html = Get-Content -Raw -Path $page.FullName
  # Grab every inline <script> ... </script> that has no src attribute
  $rx = [regex]'(?is)<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>'
  $m = $rx.Matches($html)
  $i = 0
  foreach ($match in $m) {
    $i++
    $code = $match.Groups[1].Value
    if ([string]::IsNullOrWhiteSpace($code)) { continue }
    $outFile = Join-Path $tmp ("{0}_{1}.js" -f ($page.BaseName), $i)
    Set-Content -Path $outFile -Value $code -Encoding UTF8
    $out = & $node --check $outFile 2>&1
    $rel = $page.FullName.Replace("$dir\", "")
    if ($LASTEXITCODE -ne 0) {
      $lastLine = ($out | Select-String -Pattern "SyntaxError" | Select-Object -First 1)
      Write-Output "FAIL $rel (inline script #$i)"
      Write-Output "     $out"
    }
    else {
      Write-Output "OK   $rel (inline script #$i)"
    }
  }
}
