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

function Assert-BrowserParams {
    param([object]$Params, [string]$Method, [string[]]$Allowed, [string[]]$Required = @())
    if ($null -eq $Params -or $Params -isnot [System.Management.Automation.PSCustomObject]) {
        throw "$Method params must be a JSON object"
    }
    $names = @($Params.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $names) {
        if ($Allowed -cnotcontains $name) { throw "$Method params contains unsupported field: $name" }
    }
    foreach ($name in $Required) {
        if ($names -cnotcontains $name) { throw "$Method requires params.$name" }
    }
}

function Get-BrowserStringParam {
    param(
        [object]$Params,
        [string]$Name,
        [int]$Maximum,
        [bool]$Required = $false,
        [bool]$AllowLineBreaks = $false
    )
    $property = $Params.PSObject.Properties[$Name]
    if ($null -eq $property) {
        if ($Required) { throw "$Name is required" }
        return $null
    }
    if ($property.Value -isnot [string]) { throw "$Name must be a string" }
    $text = [string]$property.Value
    if (
        $text.Length -gt $Maximum -or
        $text.Contains([char]0) -or
        (-not $AllowLineBreaks -and [regex]::IsMatch($text, '[\r\n]'))
    ) {
        throw "$Name is invalid or exceeds $Maximum characters"
    }
    return $text
}

function Get-BrowserIntegerParam {
    param([object]$Params, [string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum)
    $property = $Params.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($property.Value -isnot [int] -and $property.Value -isnot [long]) { throw "$Name must be an integer" }
    return (Get-BoundedInteger $property.Value $Default $Minimum $Maximum $Name)
}

function Import-UiAutomation {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
}

function Get-WindowsScreenshot {
    param([object]$Params)
    $mode = Get-BoundedString $Params.mode 16 "mode"
    if ($null -eq $mode) { $mode = "screen" }
    if ($mode -ne "screen" -and $mode -ne "window") { throw "mode must be screen or window" }
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    if ($mode -eq "screen") {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    } else {
        if (-not ("OpenRig.NativeWindow" -as [type])) {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace OpenRig {
    public static class NativeWindow {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);
    }
}
"@
        }
        $handle = [OpenRig.NativeWindow]::GetForegroundWindow()
        if ($handle -eq [IntPtr]::Zero) { throw "no foreground Windows window is available" }
        $rectangle = New-Object OpenRig.NativeWindow+Rect
        if (-not [OpenRig.NativeWindow]::GetWindowRect($handle, [ref]$rectangle)) { throw "could not read the foreground window bounds" }
        $bounds = [System.Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
    }
    if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $bounds.Width -gt 32768 -or $bounds.Height -gt 32768) {
        throw "screenshot bounds are invalid"
    }
    $bitmap = $null
    $graphics = $null
    $stream = $null
    try {
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        if ($bytes.Length -lt 1 -or $bytes.Length -gt 6291456) { throw "screenshot exceeds the 6 MiB attachment boundary" }
        return [ordered]@{
            mimeType = "image/png"
            data = [Convert]::ToBase64String($bytes)
            bytes = $bytes.Length
            width = $bounds.Width
            height = $bounds.Height
        }
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Import-BrowserNative {
    if (-not ("OpenRig.BrowserNative" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace OpenRig {
    public static class BrowserNative {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct Point { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion { [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Input { public uint Type; public InputUnion Data; }
        private delegate bool WindowCallback(IntPtr handle, IntPtr state);
        [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr handle);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int maximum);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr hdc, uint flags);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr handle, uint attribute, out uint value, uint size);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out Rect rectangle);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref Point point);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
        public static IntPtr[] GetVisibleTopLevelWindows() {
            var handles = new List<IntPtr>();
            EnumWindows((handle, state) => { if (IsWindowVisible(handle)) handles.Add(handle); return true; }, IntPtr.Zero);
            return handles.ToArray();
        }
        public static uint ProcessId(IntPtr handle) { uint value; GetWindowThreadProcessId(handle, out value); return value; }
        public static string Title(IntPtr handle) {
            int length = Math.Min(Math.Max(GetWindowTextLength(handle), 0), 1024);
            var text = new StringBuilder(length + 1);
            GetWindowText(handle, text, text.Capacity);
            return text.ToString();
        }
        public static string ClassName(IntPtr handle) {
            var text = new StringBuilder(513);
            GetClassName(handle, text, text.Capacity);
            return text.ToString();
        }
        public static bool ClickAt(int x, int y) {
            if (!SetCursorPos(x, y)) return false;
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
            return true;
        }
        public static bool SendUnicode(string value) {
            if (value.Length == 0) return true;
            var inputs = new Input[value.Length * 2];
            for (int index = 0; index < value.Length; index++) {
                ushort character = value[index];
                inputs[index * 2] = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { ScanCode = character, Flags = 0x0004 } } };
                inputs[index * 2 + 1] = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { ScanCode = character, Flags = 0x0004 | 0x0002 } } };
            }
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
        }
        public static bool SendVirtualKey(ushort key) {
            var inputs = new Input[] {
                new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key } } },
                new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = 0x0002 } } },
            };
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
        }
    }
}
"@
    }
}

function Get-BrowserScheme {
    param([object]$Value)
    if ($null -eq $Value) { return "https" }
    if ($Value -isnot [string] -or ($Value -cne "http" -and $Value -cne "https")) { throw "scheme must be http or https" }
    return [string]$Value
}

function Get-BrowserDefaultAssociation {
    param([string]$Scheme)
    $registryPath = "Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$Scheme\UserChoice"
    $choice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath, $false)
    if ($null -eq $choice) { throw "Windows has no readable default $Scheme URL association" }
    try {
        $programId = [string]$choice.GetValue("ProgId", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $choice.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($programId) -or $programId.Length -gt 256 -or $programId -notmatch '^[A-Za-z0-9._{}-]+$') {
        throw "Windows returned an unsupported default $Scheme URL association"
    }
    $commandKey = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("$programId\shell\open\command", $false)
    if ($null -eq $commandKey) { throw "the Windows default $Scheme URL handler has no supported open command" }
    try {
        $command = [string]$commandKey.GetValue("", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $commandKey.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($command) -or $command.Length -gt 4096 -or $command.Contains([char]0)) {
        throw "the Windows default $Scheme URL handler command is invalid"
    }
    $match = [regex]::Match($command, '^\s*"(?<exe>[^"]+\.exe)"(?:\s|$)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        $match = [regex]::Match($command, '^(?<exe>[A-Za-z]:\\[^\s"]+\.exe)(?:\s|$)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    if (-not $match.Success) { throw "the Windows default $Scheme URL handler executable cannot be identified safely" }
    $executablePath = [Environment]::ExpandEnvironmentVariables($match.Groups["exe"].Value)
    if ($executablePath -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetExtension($executablePath) -ne ".exe") {
        throw "the Windows default $Scheme URL handler is not a local Windows executable"
    }
    $executablePath = [IO.Path]::GetFullPath($executablePath)
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw "the Windows default $Scheme URL handler executable is unavailable" }
    return [ordered]@{ scheme = $Scheme; programId = $programId; executablePath = $executablePath }
}

function Invoke-BrowserDefaultOpen {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser.open" -Allowed @("url") -Required @("url")
    $url = Get-BrowserStringParam -Params $Params -Name "url" -Maximum 2048 -Required $true
    $uri = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) { throw "url must be an absolute HTTP(S) URL" }
    if ($uri.Scheme -cne "http" -and $uri.Scheme -cne "https") { throw "only HTTP and HTTPS URLs are supported" }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { throw "URLs containing embedded credentials are not accepted" }
    $normalizedUrl = $uri.AbsoluteUri
    if ($normalizedUrl.Length -gt 2048) { throw "normalized URL exceeds 2048 characters" }
    $scheme = $uri.Scheme.ToLowerInvariant()
    $association = Get-BrowserDefaultAssociation $scheme
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $normalizedUrl
    $startInfo.UseShellExecute = $true
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
    } catch {
        throw "Windows ShellExecute could not open the default URL association"
    }
    if ($null -eq $process) { throw "Windows ShellExecute did not start the default URL association" }
    $process.Dispose()
    return [ordered]@{ requestAccepted = $true; scheme = $scheme; association = $association.programId }
}

function Get-BrowserWindowId {
    param([string]$Scheme, [string]$ProgramId, [int]$ProcessId, [long]$ProcessStartTimeTicks, [string]$WindowHandle, [string]$RuntimeId)
    $identity = "$Scheme`n$ProgramId`n$ProcessId`n$ProcessStartTimeTicks`n$WindowHandle`n$RuntimeId"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-BrowserElementId {
    param([string]$WindowId, [int]$ProcessId, [string]$RuntimeId)
    $identity = "$WindowId`n$ProcessId`n$RuntimeId"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-BrowserWindowList {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser.windows" -Allowed @("scheme", "maxItems")
    Import-UiAutomation
    Import-BrowserNative
    $scheme = Get-BrowserScheme (Get-BrowserStringParam -Params $Params -Name "scheme" -Maximum 8)
    $maximum = Get-BrowserIntegerParam -Params $Params -Name "maxItems" -Default 50 -Minimum 1 -Maximum 100
    $association = Get-BrowserDefaultAssociation $scheme
    $items = New-Object System.Collections.ArrayList
    $processPaths = @{}
    $processStartTimes = @{}
    foreach ($handle in [OpenRig.BrowserNative]::GetVisibleTopLevelWindows()) {
        $processId = [int][OpenRig.BrowserNative]::ProcessId($handle)
        if ($processId -lt 1) { continue }
        if (-not $processPaths.ContainsKey($processId)) {
            $process = $null
            try {
                $process = [System.Diagnostics.Process]::GetProcessById($processId)
                $processPaths[$processId] = [IO.Path]::GetFullPath($process.MainModule.FileName)
                $processStartTimes[$processId] = [long]$process.StartTime.ToUniversalTime().Ticks
            } catch {
                $processPaths[$processId] = ""
                $processStartTimes[$processId] = [long]0
            } finally {
                if ($null -ne $process) { $process.Dispose() }
            }
        }
        if (-not [string]::Equals([string]$processPaths[$processId], $association.executablePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $rectangle = New-Object OpenRig.BrowserNative+Rect
        if (-not [OpenRig.BrowserNative]::GetWindowRect($handle, [ref]$rectangle)) { throw "could not read a Windows default-browser window bound" }
        if ($rectangle.Right -le $rectangle.Left -or $rectangle.Bottom -le $rectangle.Top) { continue }
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($null -eq $element) { throw "a Windows default-browser window has no accessible UI Automation root" }
        $current = $element.Current
        if ([int]$current.ProcessId -ne $processId) { throw "Windows default-browser UI Automation identity changed during discovery" }
        $runtimeId = @($element.GetRuntimeId()) -join "."
        if ([string]::IsNullOrWhiteSpace($runtimeId) -or $runtimeId.Length -gt 512 -or $runtimeId -notmatch '^-?[0-9]+(?:\.-?[0-9]+)*$') {
            throw "Windows default-browser window has an invalid UI Automation identity"
        }
        $windowHandle = "0x{0:X}" -f $handle.ToInt64()
        $windowId = Get-BrowserWindowId $scheme $association.programId $processId ([long]$processStartTimes[$processId]) $windowHandle $runtimeId
        [void]$items.Add([ordered]@{
            windowId = $windowId
            processId = $processId
            windowHandle = $windowHandle
            runtimeId = $runtimeId
            title = [string]$current.Name
            className = [string]$current.ClassName
            bounds = [ordered]@{ x = $rectangle.Left; y = $rectangle.Top; width = $rectangle.Right - $rectangle.Left; height = $rectangle.Bottom - $rectangle.Top }
        })
    }
    if ($items.Count -eq 0) { throw "no accessible UI Automation window belongs to the Windows default browser" }
    $orderedItems = @($items | Sort-Object processId, windowHandle)
    $truncated = $orderedItems.Count -gt $maximum
    $selected = @($orderedItems | Select-Object -First $maximum)
    return [ordered]@{ scheme = $scheme; visited = [Math]::Min($orderedItems.Count, 100); items = $selected; truncated = $truncated }
}

function Resolve-BrowserWindow {
    param([string]$Scheme, [string]$WindowId)
    if ($WindowId -cnotmatch '^[a-f0-9]{64}$') { throw "windowId must be a discovered Windows browser window identity" }
    $windows = Get-BrowserWindowList ([pscustomobject]@{ scheme = $Scheme; maxItems = 100 })
    if ($windows.truncated) { throw "Windows default-browser window discovery is truncated; refusing an ambiguous target" }
    $matches = @($windows.items | Where-Object { $_.windowId -ceq $WindowId })
    if ($matches.Count -ne 1) { throw "windowId must match exactly one current Windows default-browser window; found $($matches.Count)" }
    return $matches[0]
}

function Get-BrowserElementSnapshot {
    param([System.Windows.Automation.AutomationElement]$Element, [string]$WindowId)
    $snapshot = Get-ElementSnapshot $Element
    $snapshot.windowId = $WindowId
    $snapshot.elementId = Get-BrowserElementId $WindowId ([int]$snapshot.processId) ([string]$snapshot.runtimeId)
    return $snapshot
}

function Get-BrowserTree {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser UI Automation tree" -Allowed @("scheme", "windowId", "maxDepth", "maxNodes", "maxResults") -Required @("windowId")
    $scheme = Get-BrowserScheme (Get-BrowserStringParam -Params $Params -Name "scheme" -Maximum 8)
    $windowId = Get-BrowserStringParam -Params $Params -Name "windowId" -Maximum 64 -Required $true
    $window = Resolve-BrowserWindow $scheme $windowId
    $maxDepth = Get-BrowserIntegerParam -Params $Params -Name "maxDepth" -Default 8 -Minimum 1 -Maximum 12
    $maxNodes = Get-BrowserIntegerParam -Params $Params -Name "maxNodes" -Default 1000 -Minimum 1 -Maximum 2000
    $maxResults = Get-BrowserIntegerParam -Params $Params -Name "maxResults" -Default 150 -Minimum 1 -Maximum 2000
    $handle = [IntPtr]::new([Convert]::ToInt64(([string]$window.windowHandle).Substring(2), 16))
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -eq $root -or [int]$root.Current.ProcessId -ne [int]$window.processId) { throw "selected Windows browser UI Automation root is unavailable" }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($root, 0))
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $nodes = New-Object System.Collections.ArrayList
    $visited = 0
    $truncated = $false
    while ($queue.Count -gt 0 -and $visited -lt $maxNodes -and $nodes.Count -lt $maxResults) {
        $entry = $queue.Dequeue()
        $element = [System.Windows.Automation.AutomationElement]$entry[0]
        $depth = [int]$entry[1]
        $visited += 1
        try {
            $snapshot = Get-BrowserElementSnapshot $element $windowId
            [void]$nodes.Add([pscustomobject]@{ snapshot = $snapshot; element = $element })
            if ($depth -lt $maxDepth) {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child) {
                    if ($visited + $queue.Count -ge $maxNodes) { $truncated = $true; break }
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
    if ($queue.Count -gt 0 -or $visited -ge $maxNodes -or $nodes.Count -ge $maxResults) { $truncated = $true }
    return [pscustomobject]@{
        window = $window
        nodes = @($nodes.ToArray())
        items = @($nodes | ForEach-Object { $_.snapshot })
        visited = $visited
        truncated = $truncated
    }
}

function Resolve-BrowserTarget {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser.target" -Allowed @("scheme", "windowId", "elementId", "maxDepth", "maxNodes", "maxResults") -Required @("scheme", "windowId", "elementId", "maxDepth", "maxNodes", "maxResults")
    $elementId = Get-BrowserStringParam -Params $Params -Name "elementId" -Maximum 64 -Required $true
    if ($elementId -cnotmatch '^[a-f0-9]{64}$') { throw "elementId must be a discovered UI Automation element identity" }
    $tree = Get-BrowserTree ([pscustomobject]@{
        scheme = $Params.scheme
        windowId = $Params.windowId
        maxDepth = $Params.maxDepth
        maxNodes = $Params.maxNodes
        maxResults = $Params.maxResults
    })
    if ($tree.truncated) { throw "Windows browser action refuses truncated UI Automation discovery" }
    $matches = @($tree.nodes | Where-Object { $_.snapshot.elementId -ceq $elementId })
    if ($matches.Count -ne 1) { throw "elementId must match exactly one current target in the selected browser window; found $($matches.Count)" }
    return [pscustomobject]@{ window = $tree.window; snapshot = $matches[0].snapshot; element = $matches[0].element; visited = $tree.visited; truncated = $tree.truncated }
}

function Get-BrowserCaptureIdentity {
    param([string]$Scheme, [string]$WindowId)
    Import-UiAutomation
    Import-BrowserNative
    $window = Resolve-BrowserWindow $Scheme $WindowId
    $association = Get-BrowserDefaultAssociation $Scheme
    $handle = [IntPtr]::new([Convert]::ToInt64(([string]$window.windowHandle).Substring(2), 16))
    if (-not [OpenRig.BrowserNative]::IsWindow($handle) -or -not [OpenRig.BrowserNative]::IsWindowVisible($handle) -or [OpenRig.BrowserNative]::IsIconic($handle)) {
        throw "selected Windows default-browser window is no longer visible"
    }
    if ([int][OpenRig.BrowserNative]::ProcessId($handle) -ne [int]$window.processId) {
        throw "selected Windows default-browser window process identity changed"
    }
    $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -eq $element -or [int]$element.Current.ProcessId -ne [int]$window.processId -or (@($element.GetRuntimeId()) -join ".") -cne [string]$window.runtimeId) {
        throw "selected Windows default-browser UI Automation identity changed"
    }
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById([int]$window.processId)
        $processPath = [IO.Path]::GetFullPath($process.MainModule.FileName)
        $processStartTimeTicks = [long]$process.StartTime.ToUniversalTime().Ticks
    } catch {
        throw "could not verify the selected Windows default-browser process identity"
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
    if (-not [string]::Equals($processPath, $association.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "selected Windows browser process no longer matches the default URL association"
    }
    $expectedWindowId = Get-BrowserWindowId $Scheme $association.programId ([int]$window.processId) $processStartTimeTicks ([string]$window.windowHandle) ([string]$window.runtimeId)
    if ($expectedWindowId -cne $WindowId) { throw "selected Windows browser association changed" }
    $rectangle = New-Object OpenRig.BrowserNative+Rect
    if (-not [OpenRig.BrowserNative]::GetWindowRect($handle, [ref]$rectangle)) { throw "could not read the selected Windows browser window bounds" }
    if (
        $rectangle.Right -le $rectangle.Left -or $rectangle.Bottom -le $rectangle.Top -or
        $rectangle.Left -ne $window.bounds.x -or $rectangle.Top -ne $window.bounds.y -or
        ($rectangle.Right - $rectangle.Left) -ne $window.bounds.width -or ($rectangle.Bottom - $rectangle.Top) -ne $window.bounds.height
    ) {
        throw "selected Windows browser window bounds changed during capture"
    }
    $cloaked = [uint32]0
    if ([OpenRig.BrowserNative]::DwmGetWindowAttribute($handle, [uint32]14, [ref]$cloaked, [uint32]4) -ne 0 -or $cloaked -ne 0) {
        throw "selected Windows default-browser window is cloaked or could not be verified"
    }
    return [pscustomobject]@{
        window = $window
        handle = $handle
        associationProgramId = [string]$association.programId
        executablePath = $processPath
        processStartTimeTicks = $processStartTimeTicks
        rectangle = $rectangle
    }
}

function Assert-BrowserWindowUnoccluded {
    param([object]$Capture)
    $target = $Capture.rectangle
    $handle = [OpenRig.BrowserNative]::GetWindow($Capture.handle, [uint32]3)
    $visited = 0
    while ($handle -ne [IntPtr]::Zero) {
        $visited += 1
        if ($visited -gt 512) { throw "could not verify Windows browser window z-order within the safety bound" }
        if ([OpenRig.BrowserNative]::IsWindowVisible($handle) -and -not [OpenRig.BrowserNative]::IsIconic($handle)) {
            $cloaked = [uint32]0
            if ([OpenRig.BrowserNative]::DwmGetWindowAttribute($handle, [uint32]14, [ref]$cloaked, [uint32]4) -ne 0) {
                throw "could not verify whether another Windows window occludes the selected browser"
            }
            if ($cloaked -eq 0) {
                $rectangle = New-Object OpenRig.BrowserNative+Rect
                if (-not [OpenRig.BrowserNative]::GetWindowRect($handle, [ref]$rectangle)) {
                    throw "could not verify whether another Windows window occludes the selected browser"
                }
                if ($rectangle.Left -lt $target.Right -and $rectangle.Right -gt $target.Left -and $rectangle.Top -lt $target.Bottom -and $rectangle.Bottom -gt $target.Top) {
                    throw "selected Windows default-browser window is occluded by another visible window"
                }
            }
        }
        $handle = [OpenRig.BrowserNative]::GetWindow($handle, [uint32]3)
    }
}

function Get-BrowserCaptureProbeColor {
    param([int]$Index)
    return [System.Drawing.Color]::FromArgb(255, 32 + ($Index % 224), 16 + [int][Math]::Floor($Index / 224), 224)
}

function Assert-BrowserCapturePixels {
    param([System.Drawing.Bitmap]$Bitmap)
    $grid = 32
    $unpainted = 0
    $colors = [System.Collections.Generic.HashSet[int]]::new()
    $minimumLuminance = 255
    $maximumLuminance = 0
    for ($sampleY = 0; $sampleY -lt $grid; $sampleY += 1) {
        for ($sampleX = 0; $sampleX -lt $grid; $sampleX += 1) {
            $x = [int][Math]::Floor((($sampleX + 0.5) * $Bitmap.Width) / $grid)
            $y = [int][Math]::Floor((($sampleY + 0.5) * $Bitmap.Height) / $grid)
            $color = $Bitmap.GetPixel($x, $y)
            $expected = Get-BrowserCaptureProbeColor (($sampleY * $grid) + $sampleX)
            if ($color.R -eq $expected.R -and $color.G -eq $expected.G -and $color.B -eq $expected.B) { $unpainted += 1 }
            [void]$colors.Add(($color.R -shl 16) -bor ($color.G -shl 8) -bor $color.B)
            $luminance = [int]((299 * $color.R + 587 * $color.G + 114 * $color.B) / 1000)
            if ($luminance -lt $minimumLuminance) { $minimumLuminance = $luminance }
            if ($luminance -gt $maximumLuminance) { $maximumLuminance = $luminance }
        }
    }
    if ($unpainted -gt 8 -or $colors.Count -lt 2 -or ($maximumLuminance - $minimumLuminance) -lt 16) {
        throw "PrintWindow returned blank or unpainted browser pixels"
    }
}

function Get-BrowserScreenshot {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser.screenshot" -Allowed @("scheme", "windowId") -Required @("windowId")
    $scheme = Get-BrowserScheme (Get-BrowserStringParam -Params $Params -Name "scheme" -Maximum 8)
    $windowId = Get-BrowserStringParam -Params $Params -Name "windowId" -Maximum 64 -Required $true
    $before = Get-BrowserCaptureIdentity $scheme $windowId
    Assert-BrowserWindowUnoccluded $before
    $width = [int]($before.rectangle.Right - $before.rectangle.Left)
    $height = [int]($before.rectangle.Bottom - $before.rectangle.Top)
    if ($width -lt 32 -or $height -lt 32 -or $width -gt 8192 -or $height -gt 8192 -or ([long]$width * [long]$height) -gt 16777216) {
        throw "selected Windows browser screenshot exceeds the 8192-pixel edge or 16,777,216-pixel boundary"
    }
    Add-Type -AssemblyName System.Drawing
    $bitmap = $null
    $graphics = $null
    $stream = $null
    try {
        $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::Black)
        $grid = 32
        $probeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
        try {
            for ($sampleY = 0; $sampleY -lt $grid; $sampleY += 1) {
                for ($sampleX = 0; $sampleX -lt $grid; $sampleX += 1) {
                    $x = [int][Math]::Floor((($sampleX + 0.5) * $width) / $grid)
                    $y = [int][Math]::Floor((($sampleY + 0.5) * $height) / $grid)
                    $probeBrush.Color = Get-BrowserCaptureProbeColor (($sampleY * $grid) + $sampleX)
                    $graphics.FillRectangle($probeBrush, $x, $y, 1, 1)
                }
            }
        } finally {
            $probeBrush.Dispose()
        }
        $hdc = [IntPtr]::Zero
        try {
            $hdc = $graphics.GetHdc()
            if ($hdc -eq [IntPtr]::Zero -or -not [OpenRig.BrowserNative]::PrintWindow($before.handle, $hdc, [uint32]2)) {
                throw "PrintWindow could not render the selected Windows default-browser window"
            }
        } finally {
            if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
        }
        $after = Get-BrowserCaptureIdentity $scheme $windowId
        foreach ($field in @("windowId", "processId", "windowHandle", "runtimeId", "title", "className")) {
            if ([string]$before.window.$field -cne [string]$after.window.$field) { throw "selected Windows browser window identity changed during capture" }
        }
        foreach ($field in @("x", "y", "width", "height")) {
            if ([double]$before.window.bounds[$field] -ne [double]$after.window.bounds[$field]) { throw "selected Windows browser window bounds changed during capture" }
        }
        if (
            $before.associationProgramId -cne $after.associationProgramId -or
            -not [string]::Equals($before.executablePath, $after.executablePath, [StringComparison]::OrdinalIgnoreCase) -or
            $before.processStartTimeTicks -ne $after.processStartTimeTicks
        ) {
            throw "selected Windows browser process or default association changed during capture"
        }
        Assert-BrowserWindowUnoccluded $after
        Assert-BrowserCapturePixels $bitmap
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        if ($bytes.Length -lt 1 -or $bytes.Length -gt 6291456) { throw "browser screenshot exceeds the 6 MiB attachment boundary" }
        return [ordered]@{
            windowId = $windowId
            mimeType = "image/png"
            data = [Convert]::ToBase64String($bytes)
            bytes = $bytes.Length
            width = $width
            height = $height
        }
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Invoke-BrowserAction {
    param([object]$Params)
    Assert-BrowserParams -Params $Params -Method "browser.act" -Allowed @("scheme", "windowId", "elementId", "maxDepth", "maxNodes", "maxResults", "action", "value", "key", "expectedTarget") -Required @("scheme", "windowId", "elementId", "maxDepth", "maxNodes", "maxResults", "action", "expectedTarget")
    $scheme = Get-BrowserScheme (Get-BrowserStringParam -Params $Params -Name "scheme" -Maximum 8 -Required $true)
    $windowId = Get-BrowserStringParam -Params $Params -Name "windowId" -Maximum 64 -Required $true
    $elementId = Get-BrowserStringParam -Params $Params -Name "elementId" -Maximum 64 -Required $true
    $maxDepth = Get-BrowserIntegerParam -Params $Params -Name "maxDepth" -Default 12 -Minimum 1 -Maximum 12
    $maxNodes = Get-BrowserIntegerParam -Params $Params -Name "maxNodes" -Default 2000 -Minimum 1 -Maximum 2000
    $maxResults = Get-BrowserIntegerParam -Params $Params -Name "maxResults" -Default 2000 -Minimum 1 -Maximum 2000
    $action = Get-BrowserStringParam -Params $Params -Name "action" -Maximum 16 -Required $true
    if ($action -cnotin @("click", "focus", "type", "press")) { throw "unsupported Windows browser action" }
    $value = $null
    $valueProperty = $Params.PSObject.Properties["value"]
    if ($action -ceq "type") {
        $value = Get-BrowserStringParam -Params $Params -Name "value" -Maximum 4096 -Required $true -AllowLineBreaks $true
    } elseif ($null -ne $valueProperty) {
        throw "value is valid only for action=type"
    }
    $key = $null
    $keyProperty = $Params.PSObject.Properties["key"]
    if ($action -ceq "press") {
        $key = Get-BrowserStringParam -Params $Params -Name "key" -Maximum 16 -Required $true
        if ($key -cnotin @("Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space")) {
            throw "press requires one supported unmodified keyboard key"
        }
    } elseif ($null -ne $keyProperty) {
        throw "key is valid only for action=press"
    }
    $expectedTarget = $Params.expectedTarget
    Assert-BrowserParams -Params $expectedTarget -Method "browser.act expectedTarget" -Allowed @("windowId", "elementId", "processId", "runtimeId", "name", "automationId", "controlType", "className", "enabled", "offscreen", "bounds") -Required @("windowId", "elementId", "processId", "runtimeId", "name", "automationId", "controlType", "className", "enabled", "offscreen", "bounds")
    $expectedWindowId = Get-BrowserStringParam -Params $expectedTarget -Name "windowId" -Maximum 64 -Required $true
    $expectedElementId = Get-BrowserStringParam -Params $expectedTarget -Name "elementId" -Maximum 64 -Required $true
    if ($expectedWindowId -cne $windowId -or $expectedElementId -cne $elementId) { throw "expectedTarget identity does not match the selected window and element" }
    foreach ($field in @("runtimeId", "name", "automationId", "controlType", "className")) {
        $maximum = switch ($field) {
            "runtimeId" { 512 }
            "name" { 1024 }
            "automationId" { 512 }
            "controlType" { 256 }
            "className" { 512 }
        }
        [void](Get-BrowserStringParam -Params $expectedTarget -Name $field -Maximum $maximum -Required $true)
    }
    $expectedProcessId = $expectedTarget.PSObject.Properties["processId"].Value
    if ($expectedProcessId -isnot [int] -and $expectedProcessId -isnot [long]) { throw "expectedTarget.processId must be an integer" }
    Assert-BrowserParams -Params $expectedTarget.bounds -Method "browser.act expectedTarget.bounds" -Allowed @("x", "y", "width", "height") -Required @("x", "y", "width", "height")
    foreach ($field in @("x", "y", "width", "height")) {
        $coordinate = $expectedTarget.bounds.PSObject.Properties[$field].Value
        if ($coordinate -isnot [int] -and $coordinate -isnot [long] -and $coordinate -isnot [double] -and $coordinate -isnot [decimal]) {
            throw "expectedTarget.bounds.$field must be a finite number"
        }
    }
    Import-BrowserNative
    $targetParams = [pscustomobject]@{
        scheme = $scheme
        windowId = $windowId
        elementId = $elementId
        maxDepth = $maxDepth
        maxNodes = $maxNodes
        maxResults = $maxResults
    }
    $resolved = Resolve-BrowserTarget $targetParams
    if ($expectedWindowId -cne [string]$resolved.window.windowId -or $expectedElementId -cne [string]$resolved.snapshot.elementId) {
        throw "Windows browser action identity changed after preview"
    }
    $expected = Get-ExpectedSnapshot $Params.expectedTarget
    Assert-SnapshotEqual $expected $resolved.snapshot
    if ($resolved.snapshot.processId -ne $resolved.window.processId -or -not $resolved.snapshot.enabled -or $resolved.snapshot.offscreen) {
        throw "Windows browser action target must remain enabled, visible, and in the selected window"
    }
    $handle = [IntPtr]::new([Convert]::ToInt64(([string]$resolved.window.windowHandle).Substring(2), 16))
    if ($action -ne "click" -and $action -ne "focus" -and $resolved.snapshot.runtimeId -eq $resolved.window.runtimeId) {
        throw "typing and keyboard actions require a specific UI Automation child target"
    }
    switch ($action) {
        "focus" {
            [void][OpenRig.BrowserNative]::SetForegroundWindow($handle)
            if ([OpenRig.BrowserNative]::GetForegroundWindow() -ne $handle) { throw "could not focus the explicitly selected browser window" }
            $resolved.element.SetFocus()
            if (-not $resolved.element.Current.HasKeyboardFocus) { throw "Windows UI Automation did not confirm focus on the selected target" }
        }
        "click" {
            if ($resolved.snapshot.runtimeId -eq $resolved.window.runtimeId) { throw "click requires a specific browser UI Automation child target" }
            if ($resolved.snapshot.bounds.width -le 0 -or $resolved.snapshot.bounds.height -le 0) { throw "browser click target has empty bounds" }
            $client = New-Object OpenRig.BrowserNative+Rect
            $origin = New-Object OpenRig.BrowserNative+Point
            if (-not [OpenRig.BrowserNative]::GetClientRect($handle, [ref]$client) -or -not [OpenRig.BrowserNative]::ClientToScreen($handle, [ref]$origin)) {
                throw "could not read the selected browser client area"
            }
            $left = $origin.X
            $top = $origin.Y
            $right = $left + ($client.Right - $client.Left)
            $bottom = $top + ($client.Bottom - $client.Top)
            $bounds = $resolved.snapshot.bounds
            if ($bounds.x -lt $left -or $bounds.y -lt $top -or ($bounds.x + $bounds.width) -gt $right -or ($bounds.y + $bounds.height) -gt $bottom) {
                throw "browser click target must be fully inside the selected window client area"
            }
            [void][OpenRig.BrowserNative]::SetForegroundWindow($handle)
            if ([OpenRig.BrowserNative]::GetForegroundWindow() -ne $handle) { throw "could not activate the explicitly selected browser window for clicking" }
            $x = [int][Math]::Floor($bounds.x + ($bounds.width / 2))
            $y = [int][Math]::Floor($bounds.y + ($bounds.height / 2))
            if (-not [OpenRig.BrowserNative]::ClickAt($x, $y)) { throw "Windows rejected the bounded browser click" }
        }
        "type" {
            if ($resolved.element.Current.IsPassword) { throw "typing into password controls is not supported" }
            $pattern = $null
            if (-not $resolved.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                throw "selected browser target does not support UI Automation ValuePattern"
            }
            $valuePattern = [System.Windows.Automation.ValuePattern]$pattern
            if ($valuePattern.Current.IsReadOnly) { throw "selected browser value target is read-only" }
            [void][OpenRig.BrowserNative]::SetForegroundWindow($handle)
            if ([OpenRig.BrowserNative]::GetForegroundWindow() -ne $handle) { throw "could not activate the explicitly selected browser window for typing" }
            $resolved.element.SetFocus()
            if (-not $resolved.element.Current.HasKeyboardFocus) { throw "Windows UI Automation did not confirm focus on the selected target" }
            $valuePattern.SetValue($value)
        }
        "press" {
            $keys = @{
                Enter = 0x0D; Escape = 0x1B; Tab = 0x09; Backspace = 0x08; Delete = 0x2E
                ArrowLeft = 0x25; ArrowUp = 0x26; ArrowRight = 0x27; ArrowDown = 0x28
                Home = 0x24; End = 0x23; PageUp = 0x21; PageDown = 0x22; Space = 0x20
            }
            if (-not $keys.ContainsKey($key)) { throw "press requires one supported unmodified keyboard key" }
            [void][OpenRig.BrowserNative]::SetForegroundWindow($handle)
            if ([OpenRig.BrowserNative]::GetForegroundWindow() -ne $handle) { throw "could not activate the explicitly selected browser window for keyboard input" }
            $resolved.element.SetFocus()
            if (-not $resolved.element.Current.HasKeyboardFocus) { throw "Windows UI Automation did not confirm focus on the selected target" }
            if (-not [OpenRig.BrowserNative]::SendVirtualKey([ushort]$keys[$key])) { throw "Windows rejected the bounded browser keyboard input" }
        }
    }
    return [ordered]@{ action = $action; windowId = $resolved.window.windowId; elementId = $resolved.snapshot.elementId }
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
    $boundsValid = $true
    foreach ($coordinate in @($rectangle.X, $rectangle.Y, $rectangle.Width, $rectangle.Height)) {
        if ([double]::IsNaN($coordinate) -or [double]::IsInfinity($coordinate) -or [math]::Abs($coordinate) -gt 10000000) {
            $boundsValid = $false
            break
        }
    }
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { $boundsValid = $false }
    $bounds = [ordered]@{ x = $rectangle.X; y = $rectangle.Y; width = $rectangle.Width; height = $rectangle.Height }
    if (-not $boundsValid) { $bounds = [ordered]@{ x = 0.0; y = 0.0; width = 0.0; height = 0.0 } }
    $runtimeId = @($Element.GetRuntimeId()) -join "."
    return [ordered]@{
        processId = $current.ProcessId
        runtimeId = $runtimeId
        name = $current.Name
        automationId = $current.AutomationId
        controlType = $current.ControlType.ProgrammaticName
        className = $current.ClassName
        enabled = $current.IsEnabled
        offscreen = [bool]$current.IsOffscreen -or -not $boundsValid
        bounds = $bounds
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
    if (-not $found.items[0].enabled -or $found.items[0].offscreen) { throw "UI Automation action target must remain enabled and visible" }
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
            "windows.screenshot" { Write-RpcResult $requestId (Get-WindowsScreenshot $params) }
            "browser.open" { Write-RpcResult $requestId (Invoke-BrowserDefaultOpen $params) }
            "browser.windows" { Write-RpcResult $requestId (Get-BrowserWindowList $params) }
            "browser.snapshot" {
                Assert-BrowserParams -Params $params -Method "browser.snapshot" -Allowed @("scheme", "windowId", "maxDepth", "maxNodes", "maxResults") -Required @("windowId")
                [void](Get-BrowserIntegerParam -Params $params -Name "maxResults" -Default 150 -Minimum 1 -Maximum 200)
                $tree = Get-BrowserTree $params
                Write-RpcResult $requestId ([ordered]@{
                    window = $tree.window
                    items = [object[]]$tree.items
                    visited = $tree.visited
                    truncated = $tree.truncated
                })
            }
            "browser.screenshot" { Write-RpcResult $requestId (Get-BrowserScreenshot $params) }
            "browser.target" {
                $target = Resolve-BrowserTarget $params
                Write-RpcResult $requestId ([ordered]@{
                    window = $target.window
                    target = $target.snapshot
                    visited = $target.visited
                    truncated = $target.truncated
                })
            }
            "browser.act" { Write-RpcResult $requestId (Invoke-BrowserAction $params) }
            default { throw "unknown JSON-RPC method: $($request.method)" }
        }
    } catch {
        Write-RpcError $requestId -32000 $_.Exception.Message
    }
}
