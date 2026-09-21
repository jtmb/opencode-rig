$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-RpcResult {
    param([object]$Id, [object]$Result)
    [Console]::Out.WriteLine((@{ jsonrpc = "2.0"; id = $Id; result = $Result } | ConvertTo-Json -Compress -Depth 10))
}

function Write-RpcError {
    param([object]$Id, [int]$Code, [string]$Message)
    [Console]::Out.WriteLine((@{ jsonrpc = "2.0"; id = $Id; error = @{ code = $Code; message = $Message } } | ConvertTo-Json -Compress -Depth 5))
}

function Get-BoundedInteger {
    param([object]$Value, [int]$Default, [int]$Minimum, [int]$Maximum, [string]$Name)
    if ($null -eq $Value) { return $Default }
    $parsed = 0
    if (-not [int]::TryParse([string]$Value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        throw "$Name must be an integer from $Minimum through $Maximum"
    }
    return $parsed
}

function Get-BoundedString {
    param([object]$Value, [int]$Maximum, [string]$Name, [bool]$Required = $false)
    if ($null -eq $Value) {
        if ($Required) { throw "$Name is required" }
        return $null
    }
    $text = [string]$Value
    if (($Required -and [string]::IsNullOrWhiteSpace($text)) -or $text.Length -gt $Maximum -or $text.Contains([char]0)) {
        throw "$Name is invalid or exceeds $Maximum characters"
    }
    return $text
}

function Import-UiAutomation {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
}

function Get-RawAstInspection {
    param([object]$Params)
    $script = Get-BoundedString $Params.script 65536 "script" $true
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        $message = @($errors | Select-Object -First 8 | ForEach-Object { $_.Message }) -join "; "
        throw "PowerShell AST parse failed: $message"
    }
    $commandNames = New-Object System.Collections.ArrayList
    $dynamic = $false
    $commands = $ast.FindAll({
        param($node)
        return $node -is [System.Management.Automation.Language.CommandAst]
    }, $true)
    foreach ($command in $commands) {
        $name = $command.GetCommandName()
        if ($null -eq $name) {
            $dynamic = $true
        } elseif (-not $commandNames.Contains($name) -and $commandNames.Count -lt 64) {
            [void]$commandNames.Add($name)
        }
    }
    return [ordered]@{ commands = [object[]]$commandNames; dynamicCommands = $dynamic }
}

function Get-ElementSnapshot {
    param([System.Windows.Automation.AutomationElement]$Element)
    $current = $Element.Current
    $rectangle = $current.BoundingRectangle
    $runtimeId = @($Element.GetRuntimeId()) -join "."
    return [ordered]@{
        processId = $current.ProcessId
        runtimeId = $runtimeId
        name = $current.Name
        automationId = $current.AutomationId
        controlType = $current.ControlType.ProgrammaticName
        className = $current.ClassName
        enabled = $current.IsEnabled
        offscreen = $current.IsOffscreen
        bounds = [ordered]@{ x = $rectangle.X; y = $rectangle.Y; width = $rectangle.Width; height = $rectangle.Height }
    }
}

function Get-ExpectedSnapshot {
    param([object]$Value)
    if ($null -eq $Value) { throw "expectedTarget is required" }
    $processId = Get-BoundedInteger $Value.processId 0 1 2147483647 "expectedTarget.processId"
    $runtimeId = Get-BoundedString $Value.runtimeId 512 "expectedTarget.runtimeId" $true
    if ($runtimeId -notmatch '^-?[0-9]+(?:\.-?[0-9]+)*$') { throw "expectedTarget.runtimeId is invalid" }
    $name = Get-BoundedString $Value.name 1024 "expectedTarget.name"
    $automationId = Get-BoundedString $Value.automationId 512 "expectedTarget.automationId"
    $controlType = Get-BoundedString $Value.controlType 256 "expectedTarget.controlType"
    $className = Get-BoundedString $Value.className 512 "expectedTarget.className"
    if ($Value.enabled -isnot [bool] -or $Value.offscreen -isnot [bool]) { throw "expectedTarget state fields must be boolean" }
    if ($null -eq $Value.bounds) { throw "expectedTarget.bounds is required" }
    $bounds = [ordered]@{}
    foreach ($field in @("x", "y", "width", "height")) {
        $number = 0.0
        if (-not [double]::TryParse([string]$Value.bounds.$field, [ref]$number) -or [double]::IsNaN($number) -or [double]::IsInfinity($number) -or [math]::Abs($number) -gt 10000000) {
            throw "expectedTarget.bounds.$field is invalid"
        }
        if (($field -eq "width" -or $field -eq "height") -and $number -lt 0) { throw "expectedTarget.bounds.$field must not be negative" }
        $bounds[$field] = $number
    }
    return [ordered]@{
        processId = $processId
        runtimeId = $runtimeId
        name = if ($null -eq $name) { "" } else { $name }
        automationId = if ($null -eq $automationId) { "" } else { $automationId }
        controlType = if ($null -eq $controlType) { "" } else { $controlType }
        className = if ($null -eq $className) { "" } else { $className }
        enabled = [bool]$Value.enabled
        offscreen = [bool]$Value.offscreen
        bounds = $bounds
    }
}

function Assert-SnapshotEqual {
    param([object]$Expected, [object]$Actual)
    foreach ($field in @("processId", "runtimeId", "name", "automationId", "controlType", "className", "enabled", "offscreen")) {
        if ($Expected[$field] -ne $Actual[$field]) { throw "UI Automation target changed at $field" }
    }
    foreach ($field in @("x", "y", "width", "height")) {
        if ([double]$Expected.bounds[$field] -ne [double]$Actual.bounds[$field]) { throw "UI Automation target changed at bounds.$field" }
    }
}

function Get-AppWindows {
    param([object]$Params)
    $maximum = Get-BoundedInteger $Params.maxItems 50 1 100 "maxItems"
    $name = Get-BoundedString $Params.name 128 "name"
    $items = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($null -ne $name) {
        $items = $items | Where-Object { $_.ProcessName -eq $name -or $_.MainWindowTitle -like "*$name*" }
    }
    return @($items | Sort-Object ProcessName, Id | Select-Object -First $maximum | ForEach-Object {
        [ordered]@{ processId = $_.Id; processName = $_.ProcessName; title = $_.MainWindowTitle; windowHandle = [string]$_.MainWindowHandle }
    })
}

function Find-UiElements {
    param([object]$Params)
    Import-UiAutomation
    $processId = Get-BoundedInteger $Params.processId 0 1 2147483647 "processId"
    $name = Get-BoundedString $Params.name 256 "name"
    $automationId = Get-BoundedString $Params.automationId 256 "automationId"
    $controlType = Get-BoundedString $Params.controlType 128 "controlType"
    if ($null -eq $name -and $null -eq $automationId -and $null -eq $controlType) {
        throw "at least one UI Automation selector is required"
    }
    $maxDepth = Get-BoundedInteger $Params.maxDepth 8 1 12 "maxDepth"
    $maxNodes = Get-BoundedInteger $Params.maxNodes 1000 1 2000 "maxNodes"
    $maxResults = Get-BoundedInteger $Params.maxResults 20 1 100 "maxResults"
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $processId
    )
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $condition
    )
    $queue = New-Object System.Collections.Queue
    foreach ($root in $roots) { $queue.Enqueue(@($root, 0)) }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $visited = 0
    $results = New-Object System.Collections.ArrayList
    $truncated = $false
    while ($queue.Count -gt 0 -and $visited -lt $maxNodes -and $results.Count -lt $maxResults) {
        $entry = $queue.Dequeue()
        $element = [System.Windows.Automation.AutomationElement]$entry[0]
        $depth = [int]$entry[1]
        $visited += 1
        try {
            $snapshot = Get-ElementSnapshot $element
            $matches = ($null -eq $name -or $snapshot.name -eq $name) -and
                ($null -eq $automationId -or $snapshot.automationId -eq $automationId) -and
                ($null -eq $controlType -or $snapshot.controlType -eq $controlType -or $snapshot.controlType -eq "ControlType.$controlType")
            if ($matches) { [void]$results.Add($snapshot) }
            if ($depth -lt $maxDepth) {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child) {
                    if ($visited + $queue.Count -ge $maxNodes) {
                        $truncated = $true
                        break
                    }
                    $queue.Enqueue(@($child, $depth + 1))
                    $child = $walker.GetNextSibling($child)
                }
            } elseif ($null -ne $walker.GetFirstChild($element)) {
                $truncated = $true
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            $truncated = $true
        }
    }
    if ($queue.Count -gt 0 -or $visited -ge $maxNodes -or $results.Count -ge $maxResults) { $truncated = $true }
    return [ordered]@{ items = @($results); visited = $visited; truncated = $truncated }
}

function Invoke-UiAction {
    param([object]$Params)
    $found = Find-UiElements $Params
    if ($found.truncated) { throw "UI Automation action refuses truncated discovery" }
    if ($found.items.Count -ne 1) { throw "UI Automation action requires exactly one current match; found $($found.items.Count)" }
    $expected = Get-ExpectedSnapshot $Params.expectedTarget
    Assert-SnapshotEqual $expected $found.items[0]
    Import-UiAutomation
    $processId = Get-BoundedInteger $Params.processId 0 1 2147483647 "processId"
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $processId
    )
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $target = $null
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $queue = New-Object System.Collections.Queue
    foreach ($root in $roots) { $queue.Enqueue(@($root, 0)) }
    $visited = 0
    $maxDepth = Get-BoundedInteger $Params.maxDepth 8 1 12 "maxDepth"
    $maxNodes = Get-BoundedInteger $Params.maxNodes 1000 1 2000 "maxNodes"
    while ($queue.Count -gt 0 -and $visited -lt $maxNodes -and $null -eq $target) {
        $entry = $queue.Dequeue()
        $element = [System.Windows.Automation.AutomationElement]$entry[0]
        $depth = [int]$entry[1]
        $visited += 1
        try {
            $snapshot = Get-ElementSnapshot $element
            if ($snapshot.runtimeId -eq [string]$found.items[0].runtimeId) { $target = $element; break }
            if ($depth -lt $maxDepth) {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child -and $visited + $queue.Count -lt $maxNodes) {
                    $queue.Enqueue(@($child, $depth + 1))
                    $child = $walker.GetNextSibling($child)
                }
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
        }
    }
    if ($null -eq $target) { throw "selected UI Automation element became unavailable" }
    $currentTarget = Get-ElementSnapshot $target
    Assert-SnapshotEqual $expected $currentTarget
    $action = Get-BoundedString $Params.action 32 "action" $true
    switch ($action) {
        "focus" { $target.SetFocus() }
        "invoke" {
            $pattern = $null
            if (-not $target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw "target does not support invoke" }
            ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
        }
        "setValue" {
            $value = Get-BoundedString $Params.value 4096 "value" $true
            $pattern = $null
            if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw "target does not support setValue" }
            ([System.Windows.Automation.ValuePattern]$pattern).SetValue($value)
        }
        "toggle" {
            $pattern = $null
            if (-not $target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { throw "target does not support toggle" }
            ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
        }
        "select" {
            $pattern = $null
            if (-not $target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { throw "target does not support select" }
            ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
        }
        default { throw "unsupported UI Automation action: $action" }
    }
    return [ordered]@{ action = $action; target = $currentTarget }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $requestId = $null
    try {
        if ($line.Length -gt 1048576) { throw "JSON-RPC request exceeds 1 MiB" }
        $request = $line | ConvertFrom-Json
        $requestId = $request.id
        if ($request.jsonrpc -ne "2.0" -or $null -eq $request.id) { throw "invalid JSON-RPC envelope" }
        $params = if ($null -eq $request.params) { [pscustomobject]@{} } else { $request.params }
        switch ([string]$request.method) {
            "status" {
                $uiAutomation = $true
                try { Import-UiAutomation } catch { $uiAutomation = $false }
                Write-RpcResult $requestId ([ordered]@{
                    version = $PSVersionTable.PSVersion.ToString()
                    edition = [string]$PSVersionTable.PSEdition
                    uiAutomation = $uiAutomation
                })
            }
            "processes" {
                $maximum = Get-BoundedInteger $params.maxItems 50 1 200 "maxItems"
                $name = Get-BoundedString $params.name 128 "name"
                $items = Get-Process
                if ($null -ne $name) { $items = $items | Where-Object { $_.ProcessName -eq $name } }
                Write-RpcResult $requestId @($items | Sort-Object ProcessName, Id | Select-Object -First $maximum Id, ProcessName, CPU, WorkingSet64)
            }
            "services" {
                $maximum = Get-BoundedInteger $params.maxItems 50 1 200 "maxItems"
                $name = Get-BoundedString $params.name 128 "name"
                $items = Get-Service
                if ($null -ne $name) { $items = $items | Where-Object { $_.Name -eq $name } }
                Write-RpcResult $requestId @($items | Sort-Object Name | Select-Object -First $maximum Name, DisplayName, Status, StartType)
            }
            "path" {
                $path = Get-BoundedString $params.path 4096 "path" $true
                if ($path -notmatch '^[A-Za-z]:\\') { throw "path must be an absolute local-drive path; UNC paths are not accepted" }
                if (Test-Path -LiteralPath $path) {
                    Write-RpcResult $requestId (Get-Item -LiteralPath $path | Select-Object FullName, Name, Length, Attributes, LastWriteTimeUtc)
                } else {
                    Write-RpcResult $requestId ([ordered]@{ FullName = $path; Exists = $false })
                }
            }
            "raw.parse" { Write-RpcResult $requestId (Get-RawAstInspection $params) }
            "windows.apps" {
                $apps = @(Get-AppWindows $params)
                Write-RpcResult -Id $requestId -Result ([object[]]$apps)
            }
            "windows.find" { Write-RpcResult $requestId (Find-UiElements $params) }
            "windows.act" { Write-RpcResult $requestId (Invoke-UiAction $params) }
            default { throw "unknown JSON-RPC method: $($request.method)" }
        }
    } catch {
        Write-RpcError $requestId -32000 $_.Exception.Message
    }
}
