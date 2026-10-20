function Install-ServiceProfile {
    param([string]$ProjectRoot, [string]$ProfilePath)

    $shortcuts = Join-Path $ProjectRoot 'service\shortcuts.ps1'
    if (-not (Test-Path -LiteralPath $shortcuts -PathType Leaf)) { throw "Missing shortcuts script: $shortcuts" }
    $start = '# >>> Duprove service shortcuts >>>'
    $end = '# <<< Duprove service shortcuts <<<'
    $sourceLine = ". '{0}'" -f $shortcuts.Replace("'", "''")
    $block = @($start, $sourceLine, $end) -join "`r`n"
    $content = if (Test-Path -LiteralPath $ProfilePath -PathType Leaf) {
        [IO.File]::ReadAllText($ProfilePath)
    } else { '' }
    $pattern = '(?ms)^' + [regex]::Escape($start) + '\r?\n.*?^' + [regex]::Escape($end) + '(?=\r?$)'

    $sameScriptPattern = '(?m)^# >>> (?<brand>[^\r\n]+) service shortcuts >>>\r?\n' +
        [regex]::Escape($sourceLine) + '\r?\n# <<< \k<brand> service shortcuts <<<(?=\r?$)'
    if ([regex]::IsMatch($content, $pattern)) {
        $updated = [regex]::Replace($content, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $block })
    } elseif ($content.Contains($start) -or $content.Contains($end)) {
        throw 'Incomplete Duprove profile block. Profile was not changed.'
    } elseif ([regex]::IsMatch($content, $sameScriptPattern)) {
        $updated = [regex]::Replace($content, $sameScriptPattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $block })
    } else {
        $separator = if ($content -and -not $content.EndsWith("`n")) { "`r`n" } else { '' }
        $updated = $content + $separator + $block + "`r`n"
    }
    if ($updated -ne $content) {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $ProfilePath))
        if (Test-Path -LiteralPath $ProfilePath -PathType Leaf) {
            $backup = '{0}.duprove-{1}-{2}.bak' -f $ProfilePath, (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N'))
            Copy-Item -LiteralPath $ProfilePath -Destination $backup
        }
        [IO.File]::WriteAllText($ProfilePath, $updated, [Text.UTF8Encoding]::new($true))
    }
}
