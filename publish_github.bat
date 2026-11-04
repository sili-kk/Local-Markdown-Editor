@echo off
setlocal
set "MOJIAN_PUBLISH_SELF=%~f0"
set "MOJIAN_PUBLISH_ARG1=%~1"
set "MOJIAN_PUBLISH_ARG2=%~2"
set "MOJIAN_PUBLISH_ARG3=%~3"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$parts = [IO.File]::ReadAllText($env:MOJIAN_PUBLISH_SELF) -split '(?m)^# POWERSHELL-BEGIN\r?$', 2; if ($parts.Count -ne 2) { throw 'Publish script is incomplete.' }; & ([scriptblock]::Create($parts[1]))"
set "MOJIAN_PUBLISH_RESULT=%ERRORLEVEL%"
if not "%MOJIAN_PUBLISH_RESULT%"=="0" echo Publish failed. See the error above.
exit /b %MOJIAN_PUBLISH_RESULT%
# POWERSHELL-BEGIN
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$createdTag = $false
$pushStarted = $false
$published = $false
try {
    $arguments = @($env:MOJIAN_PUBLISH_ARG1, $env:MOJIAN_PUBLISH_ARG2) | Where-Object { $_ }
    if ($env:MOJIAN_PUBLISH_ARG3) { throw 'Too many arguments. Use publish_github.bat [version] [--check].' }
    if ($arguments -contains '--help' -or $arguments -contains '-h') {
        Write-Host 'Usage: publish_github.bat [v1.2.3 | v1.2.3-rc.1] [--check]'
        Write-Host 'No version: automatically use the next patch version; no input required. --check: sync and test, without committing or pushing.'
        Write-Host 'Release: merge source into github/Local-Markdown-Editor, test, commit ALL non-ignored repository changes, tag, atomic push.'
        exit 0
    }
    $checkOnly = $false
    $version = $null
    foreach ($argument in $arguments) {
        if ($argument -eq '--check' -and !$checkOnly) { $checkOnly = $true }
        elseif ($argument.StartsWith('-') -or $version) { throw ('Unknown or repeated argument: ' + $argument) }
        else { $version = $argument }
    }

    $gitPath = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $null = Get-Command go.exe -CommandType Application -ErrorAction Stop
    $scriptDirectory = [IO.Path]::GetDirectoryName($env:MOJIAN_PUBLISH_SELF)
    $sourceDirectory = $null
    $repository = $null
    foreach ($candidate in @((Join-Path $scriptDirectory 'github\Local-Markdown-Editor'), $scriptDirectory)) {
        if (Test-Path -LiteralPath (Join-Path $candidate '.git')) {
            $repository = [IO.Path]::GetFullPath($candidate)
            if ($repository -ne $scriptDirectory) { $sourceDirectory = $scriptDirectory }
            break
        }
    }
    if (!$repository) { throw 'No repository found beside this BAT or in github/Local-Markdown-Editor.' }

    function Invoke-Git([string[]] $GitArguments) {
        & $gitPath -C $repository @GitArguments | Out-Host
        if ($LASTEXITCODE -ne 0) { throw ('git ' + $GitArguments[0] + ' failed (exit ' + $LASTEXITCODE + ').') }
    }
    function Get-GitOutput([string[]] $GitArguments) {
        $output = & $gitPath -C $repository @GitArguments
        if ($LASTEXITCODE -ne 0) { throw ('git ' + $GitArguments[0] + ' failed (exit ' + $LASTEXITCODE + ').') }
        return $output
    }
    function Assert-Main {
        if ((Get-GitOutput @('branch', '--show-current')) -cne 'main') {
            throw 'Switch to the main branch first. This script does not switch branches or merge changes.'
        }
        foreach ($state in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer')) {
            $statePath = Get-GitOutput @('rev-parse', '--git-path', $state)
            if (![IO.Path]::IsPathRooted($statePath)) { $statePath = Join-Path $repository $statePath }
            if (Test-Path -LiteralPath $statePath) { throw ('Finish or abort the active Git operation first: ' + $state) }
        }
        if (@(Get-GitOutput @('diff', '--name-only', '--diff-filter=U')).Count -gt 0) {
            throw 'Resolve all merge conflicts first.'
        }
    }

    $topLevel = Get-GitOutput @('rev-parse', '--show-toplevel')
    if ([IO.Path]::GetFullPath($topLevel) -ne $repository) { throw 'The BAT must select the repository root.' }
    foreach ($required in @('go.mod', 'scripts\test.mjs')) {
        if (!(Test-Path -LiteralPath (Join-Path $repository $required) -PathType Leaf)) {
            throw ('Required project file is missing: ' + $required)
        }
    }
    Assert-Main
    $null = Get-GitOutput @('var', 'GIT_AUTHOR_IDENT')
    $null = Get-GitOutput @('var', 'GIT_COMMITTER_IDENT')
    $fetchUrls = @(Get-GitOutput @('remote', 'get-url', '--all', 'origin'))
    $pushUrls = @(Get-GitOutput @('remote', 'get-url', '--push', '--all', 'origin'))
    if ($fetchUrls.Count -ne 1 -or $pushUrls.Count -ne 1 -or $fetchUrls[0] -cne $pushUrls[0]) {
        throw 'origin must have one matching fetch/push URL so validation and publishing use the same remote.'
    }

    Write-Host ('Repository: ' + $repository)
    Write-Host 'Target: origin / main'
    Write-Host 'Fetching origin/main and checking remote tags...'
    Invoke-Git @('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    $initialHead = Get-GitOutput @('rev-parse', 'HEAD')
    & $gitPath -C $repository merge-base --is-ancestor refs/remotes/origin/main $initialHead
    if ($LASTEXITCODE -eq 1) { throw 'origin/main is ahead or has diverged. Integrate the remote changes and rerun; nothing will be force-pushed.' }
    if ($LASTEXITCODE -ne 0) { throw 'Unable to check main ancestry.' }

    $remoteTagLines = @(Get-GitOutput @('ls-remote', '--tags', '--refs', 'origin'))
    $remoteTags = @($remoteTagLines | ForEach-Object { ($_ -split '\s+', 2)[1] -replace '^refs/tags/', '' })
    $localTags = @(Get-GitOutput @('tag', '--list'))
    if (!$version) {
        $stableVersions = @(@($localTags + $remoteTags) | ForEach-Object {
            if ($_ -match '^v([0-9]+\.[0-9]+\.[0-9]+)$') { [version] $Matches[1] }
        } | Sort-Object -Descending)
        $version = 'v0.1.0'
        if ($stableVersions.Count -gt 0) {
            $latest = $stableVersions[0]
            $version = 'v{0}.{1}.{2}' -f $latest.Major, $latest.Minor, ([long] $latest.Build + 1)
        }
        Write-Host ('Automatically selected version: ' + $version)
    }
    $version = $version.Trim()
    if (!$version.StartsWith('v')) { $version = 'v' + $version }
    if ($version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
        throw 'Version must look like v1.2.3 or v1.2.3-rc.1 (the leading v is optional).'
    }
    Invoke-Git @('check-ref-format', ('refs/tags/' + $version))
    if ($localTags -contains $version -or $remoteTags -contains $version) {
        throw ('Tag already exists locally or on origin: ' + $version + '. Choose a new version.')
    }

    $syncChanges = @()
    if ($sourceDirectory) {
        Write-Host 'Merging local source changes into github/Local-Markdown-Editor...'
        $syncHelper = Join-Path $sourceDirectory 'scripts\sync-source.mjs'
        if (!(Test-Path -LiteralPath $syncHelper -PathType Leaf)) { throw 'scripts/sync-source.mjs is missing from the source project.' }
        $syncOutput = & $nodePath $syncHelper '--source' $sourceDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Source synchronization failed. No commit, tag or push was attempted.' }
        $sync = ($syncOutput -join "`n") | ConvertFrom-Json
        $syncChanges = @($sync.changed)
        Write-Host ('Synchronized files: ' + $syncChanges.Count)
        foreach ($name in $syncChanges) { Write-Host ('  ' + $name) }
    }
    Write-Host ('Version: ' + $version)
    Write-Host ('Unpushed commits: ' + (Get-GitOutput @('rev-list', '--count', 'refs/remotes/origin/main..HEAD')))
    Write-Host 'Repository changes (ALL non-ignored changes will be committed for a release):'
    Invoke-Git @('-c', 'core.quotepath=false', 'status', '--short')
    Write-Host 'Running node scripts/test.mjs...'
    Push-Location -LiteralPath $repository
    try {
        & $nodePath 'scripts/test.mjs' | Out-Host
        if ($LASTEXITCODE -ne 0) { throw ('Project checks failed (exit ' + $LASTEXITCODE + '). No commit, tag or push was attempted.') }
    } finally { Pop-Location }
    Assert-Main
    if ((Get-GitOutput @('rev-parse', 'HEAD')) -cne $initialHead) {
        throw 'HEAD changed during validation. Rerun on the current commit.'
    }
    if (!$checkOnly -or $syncChanges.Count -gt 0) {
        $today = Get-Date -Format 'yyyy-MM-dd'
        $scope = if ($syncChanges.Count -gt 0) { $syncChanges -join ', ' } else { '仓库现有待发布改动' }
        $record = "`n`n### $today - GitHub 发布准备：$version`n`n" +
            "| 范围 | 结果 |`n| --- | --- |`n" +
            '| 源码同步 | ' + $scope + " |`n" +
            "| 验证 | node scripts/test.mjs 已通过；此记录写于提交、标签及推送之前。 |`n" +
            "| 目标 | origin/main 与新附注标签 $version；不强制推送。 |`n"
        [IO.File]::AppendAllText((Join-Path $repository 'update.md'), $record, (New-Object Text.UTF8Encoding($false)))
    }
    if ($checkOnly) {
        Write-Host ('CHECK PASSED: ' + $version + '. No files staged, no commit/tag created, no push attempted.') -ForegroundColor Green
        exit 0
    }

    Invoke-Git @('add', '--all', '--', '.')
    & $gitPath -C $repository diff --cached --quiet
    $diffExit = $LASTEXITCODE
    if ($diffExit -eq 1) { Invoke-Git @('commit', '-m', ('chore: release ' + $version)) }
    elseif ($diffExit -ne 0) { throw 'Unable to inspect the staged changes.' }
    Assert-Main
    if (@(Get-GitOutput @('status', '--porcelain', '--untracked-files=all')).Count -gt 0) {
        throw 'The repository changed during commit (possibly a Git hook). Review the changes and rerun before publishing.'
    }
    $releaseCommit = Get-GitOutput @('rev-parse', 'HEAD')
    Invoke-Git @('tag', '-a', '-m', ('Release ' + $version), '--', $version, $releaseCommit)
    $createdTag = $true
    $tagObject = Get-GitOutput @('rev-parse', ('refs/tags/' + $version))
    $pushStarted = $true
    # Explicit object IDs publish the checked commit and tag, even if local refs change concurrently.
    # Disable implicit tag following and mirror mode; publish only main and this one new tag.
    Invoke-Git @('-c', 'push.followTags=false', '-c', 'remote.origin.mirror=false', 'push', '--atomic', 'origin',
        ($releaseCommit + ':refs/heads/main'), ($tagObject + ':refs/tags/' + $version))
    $published = $true
    Write-Host ('PUBLISHED: main and ' + $version + ' at ' + $releaseCommit) -ForegroundColor Green
    Write-Host 'On GitHub, the existing v* tag workflow will now build and publish the Release.'
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    if ($createdTag -and !$published) {
        Write-Host ('The local commit and annotated tag ' + $version + ' were kept. No rollback or force-push was performed.')
        if ($pushStarted) {
            Write-Host 'Check the remote first: a connection error can occur after the server accepted a push.'
            Write-Host 'To retry this exact commit and tag after resolving the problem:'
            Write-Host ('git -C "' + $repository + '" -c push.followTags=false -c remote.origin.mirror=false push --atomic origin ' +
                $releaseCommit + ':refs/heads/main ' + $tagObject + ':refs/tags/' + $version)
        }
    }
    exit 1
}
