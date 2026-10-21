param(
  [switch]$CheckOnly,
  [switch]$ValidateUi,
  [switch]$ValidateRoot,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'T3-CoS-Integration')
)
$ErrorActionPreference = 'Stop'
$script:sourceRoot = Split-Path -Parent $PSScriptRoot

function Get-SetupReadiness {
  param([string]$Root)
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeVersion = $null
  $nodeReady = $false
  $npmReady = $false
  if ($node) {
    try {
      $nodeVersion = (& $node.Source -p 'process.versions.node' 2>$null).Trim()
      $nodeReady = ([version]$nodeVersion -ge [version]'26.12.1' -and ([version]$nodeVersion).Major -eq 26)
      $npm = Join-Path (Split-Path $node.Source) 'node_modules\npm\bin\npm-cli.js'
      $npmReady = (Test-Path -LiteralPath $npm) -or [bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)
    } catch {}
  }
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
  $t3Path = Join-Path $homeDir '.t3\userdata\settings.json'
  $t3Ready = Test-Path -LiteralPath $t3Path
  $cosLocations = @(
    $env:COS_ACP_COS_EXE
    (Join-Path $env:LOCALAPPDATA 'Programs\Chat On Steroids\Chat On Steroids.exe')
    (Join-Path $env:ProgramFiles 'Chat On Steroids\Chat On Steroids.exe')
    (Join-Path $env:ProgramFiles 'Chat On Steroids\Chat On Steroids.exe')
  ) | Where-Object { $_ -and $_.Trim() }
  $cosReady = [bool]($cosLocations | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
  $installed = Test-Path -LiteralPath (Join-Path $Root 'installation.json')
  $providerEnabled = $false
  $settingsReadable = $true
  if ($t3Ready) {
    try {
      $settings = Get-Content -LiteralPath $t3Path -Raw | ConvertFrom-Json
      $providerEnabled = [bool]($settings.providerInstances.chat_on_steroids.enabled)
    } catch { $settingsReadable = $false }
  }
  # Any enabled previous provider is an upgrade blocker. This is intentional:
  # the wizard must not stop an in-flight input or silently rewrite its runtime.
  $upgradeBlocked = $providerEnabled
  $canInstall = $nodeReady -and $npmReady -and $t3Ready -and $settingsReadable -and $cosReady -and -not $upgradeBlocked
  [pscustomobject]@{
    platform = [Environment]::OSVersion.Platform.ToString()
    nodeFound = [bool]$node
    nodeVersion = $nodeVersion
    nodeReady = $nodeReady
    npmReady = $npmReady
    t3Ready = $t3Ready
    settingsReadable = $settingsReadable
    cosReady = $cosReady
    existingInstall = $installed
    providerEnabled = $providerEnabled
    upgradeBlocked = $upgradeBlocked
    canInstall = $canInstall
  }
}
function Assert-SafeInstallRoot {
  param([string]$Root)
  if ([string]::IsNullOrWhiteSpace($Root) -or $Root.IndexOfAny([char[]]@('"',[char]10,[char]13)) -ge 0) {
    throw 'Choose a valid install folder without quotes or line breaks.'
  }
  if (-not [IO.Path]::IsPathRooted($Root) -or $Root.StartsWith('\\')) {
    throw 'Choose an absolute local Windows path, not a network share.'
  }
  $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ($full -eq $driveRoot -or $full.Length -lt $driveRoot.Length + 5) {
    throw 'Choose a dedicated integration folder, not a drive root.'
  }
  if ((Test-Path -LiteralPath $full -PathType Leaf) -or ($full -match '[<>|?*]')) {
    throw 'That location is not a usable installation directory.'
  }
  if (Test-Path -LiteralPath $full -PathType Container) {
    $known = Test-Path -LiteralPath (Join-Path $full 'installation.json')
    if (-not $known -and @(Get-ChildItem -LiteralPath $full -Force | Select-Object -First 1).Count -gt 0) {
      throw 'Select an empty folder or an existing T3-CoS integration installation.'
    }
  }
  return $full
}

if ($ValidateRoot) {
  Assert-SafeInstallRoot -Root $InstallRoot
  return
}
if ($CheckOnly) {
  Get-SetupReadiness -Root $InstallRoot | ConvertTo-Json -Compress
  return
}
if ($env:OS -ne 'Windows_NT') { throw 'The graphical setup wizard requires Windows 10 or 11.' }
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  throw 'Start this wizard with Install.cmd (PowerShell -STA is required).'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'install.ps1'))) {
  throw 'Installer files are incomplete. Extract the whole GitHub ZIP.'
}
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="T3 + Chat on Steroids | Setup" Width="950" Height="690"
        ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
        Background="#0B1020" FontFamily="Segoe UI" Foreground="#EDF2FF">
  <Window.Resources>
    <Style TargetType="Button" x:Key="Primary">
      <Setter Property="Background" Value="#22D3EE"/><Setter Property="Foreground" Value="#08111B"/>
      <Setter Property="FontWeight" Value="SemiBold"/><Setter Property="FontSize" Value="14"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="22,13"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border Background="{TemplateBinding Background}" CornerRadius="10" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#67E8F9"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter Property="Background" Value="#2A3545"/><Setter Property="Foreground" Value="#8996A9"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="Button" x:Key="Secondary">
      <Setter Property="Background" Value="#1D293B"/><Setter Property="Foreground" Value="#DCE5F5"/>
      <Setter Property="FontWeight" Value="SemiBold"/><Setter Property="FontSize" Value="13"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="19,13"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border Background="{TemplateBinding Background}" CornerRadius="10" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#334155"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="TextBlock" x:Key="Body">
      <Setter Property="FontSize" Value="14"/><Setter Property="Foreground" Value="#AAB9D0"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
    </Style>
    <Style TargetType="TextBlock" x:Key="Item">
      <Setter Property="FontSize" Value="13"/><Setter Property="Foreground" Value="#DAE6F7"/>
      <Setter Property="Margin" Value="0,3,0,10"/><Setter Property="TextWrapping" Value="Wrap"/>
    </Style>
    <Style TargetType="CheckBox">
      <Setter Property="FontSize" Value="14"/><Setter Property="Foreground" Value="#E5EFFD"/>
      <Setter Property="Margin" Value="0,5,0,5"/>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width="270"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <Border Grid.Column="0" Padding="30,34">
      <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
        <GradientStop Color="#163552" Offset="0"/><GradientStop Color="#1F1C4E" Offset="1"/>
      </LinearGradientBrush></Border.Background>
      <StackPanel>
        <Border Width="53" Height="53" Background="#202E49" CornerRadius="15"
                HorizontalAlignment="Left" BorderBrush="#476C96" BorderThickness="1" Margin="0,0,0,22">
          <TextBlock Text="T3" FontSize="22" FontWeight="Bold" HorizontalAlignment="Center"
                     VerticalAlignment="Center" Foreground="#70E9FA"/>
        </Border>
        <TextBlock Text="T3 + CoS" FontSize="27" FontWeight="Bold" Foreground="#FFFFFF"/>
        <TextBlock Text="BRIDGE SETUP" FontSize="11" FontWeight="SemiBold"
                   Foreground="#6DE6F9" Margin="0,8,0,22"/>
        <TextBlock Text="Your ChatGPT account. Your CoS tools. Right inside T3 Code."
                   Style="{StaticResource Body}" Foreground="#C2CBE4" Margin="0,0,0,34"/>
        <StackPanel Margin="0,8">
          <TextBlock x:Name="StepOne" Text="01   System check" FontSize="14" FontWeight="SemiBold"
                     Margin="0,0,0,24" Foreground="#67E8F9"/>
          <TextBlock x:Name="StepTwo" Text="02   Preferences" FontSize="14" Margin="0,0,0,24" Foreground="#A1B2CF"/>
          <TextBlock x:Name="StepThree" Text="03   Installation" FontSize="14" Margin="0,0,0,24" Foreground="#A1B2CF"/>
          <TextBlock x:Name="StepFour" Text="04   You're ready" FontSize="14" Margin="0,0,0,24" Foreground="#A1B2CF"/>
        </StackPanel>
        <Border Background="#1B2E4D" CornerRadius="10" Padding="15" Margin="0,36,0,0">
          <StackPanel>
            <TextBlock Text="PRIVATE BY DESIGN" FontSize="11" FontWeight="Bold" Foreground="#86E9F3"/>
            <TextBlock Text="No API keys, no extra ChatGPT login, and no changes to your T3 or CoS application files."
                       TextWrapping="Wrap" FontSize="12" Foreground="#C0CEE0" Margin="0,8,0,0"/>
          </StackPanel>
        </Border>
      </StackPanel>
    </Border>
    <Grid Grid.Column="1" Margin="36,28,36,26">
      <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
      <StackPanel Grid.Row="0" Margin="0,0,0,22">
        <TextBlock Text="WINDOWS SETUP WIZARD" Foreground="#67E8F9" FontSize="11" FontWeight="Bold"/>
        <TextBlock x:Name="PageTitle" Text="Let's get connected" FontSize="29" FontWeight="Bold" Margin="0,8,0,5"/>
        <TextBlock x:Name="PageSubtitle" Text="A quick check before we install anything." Style="{StaticResource Body}"/>
      </StackPanel>
      <Grid Grid.Row="1">
        <StackPanel x:Name="CheckPage">
          <TextBlock Text="Requirements" FontSize="18" FontWeight="SemiBold" Margin="0,0,0,14"/>
          <Border Background="#141F31" CornerRadius="12" Padding="19">
            <StackPanel>
              <TextBlock x:Name="NodeCheck" Style="{StaticResource Item}"/>
              <TextBlock x:Name="NpmCheck" Style="{StaticResource Item}"/>
              <TextBlock x:Name="T3Check" Style="{StaticResource Item}"/>
              <TextBlock x:Name="CosCheck" Style="{StaticResource Item}" Margin="0,3,0,1"/>
            </StackPanel>
          </Border>
          <Border Background="#152338" CornerRadius="11" Padding="15" Margin="0,18,0,0">
            <TextBlock x:Name="UpgradeMessage" Style="{StaticResource Body}" Text="Checking existing installation..."/>
          </Border>
          <TextBlock Text="Open T3 once before setup. Sign in to Chat on Steroids and enable its local control API and actions in CoS Settings."
                     Style="{StaticResource Body}" Margin="0,16,0,0"/>
          <StackPanel Orientation="Horizontal" Margin="0,18,0,0">
            <Button x:Name="RefreshButton" Content="Refresh checks" Style="{StaticResource Secondary}" Margin="0,0,10,0"/>
            <Button x:Name="NodeHelpButton" Content="Node.js" Style="{StaticResource Secondary}" Margin="0,0,9,0"/>
            <Button x:Name="T3HelpButton" Content="T3 Code" Style="{StaticResource Secondary}" Margin="0,0,9,0"/>
            <Button x:Name="CosHelpButton" Content="Get CoS" Style="{StaticResource Secondary}"/>
          </StackPanel>
        </StackPanel>
        <StackPanel x:Name="OptionsPage" Visibility="Collapsed">
          <TextBlock Text="Make it yours" FontSize="18" FontWeight="SemiBold" Margin="0,0,0,13"/>
          <Border Background="#141F31" Padding="21" CornerRadius="12">
            <StackPanel>
              <CheckBox x:Name="RegisterCheck" IsChecked="True" Content="Add Chat on Steroids to T3 Code automatically"/>
              <TextBlock Text="Updates only the bridge provider in T3 settings and makes a timestamped backup."
                         Style="{StaticResource Body}" FontSize="12" Margin="25,0,0,15"/>
              <CheckBox x:Name="AutoStartCheck" IsChecked="True" Content="Start CoS when the bridge needs it"/>
              <TextBlock Text="Uses your existing Windows CoS profile. Never creates a second account or browser profile."
                         Style="{StaticResource Body}" FontSize="12" Margin="25,0,0,0"/>
            </StackPanel>
          </Border>
          <Expander Header="Advanced: installation folder" Foreground="#BFD1E6" Margin="0,20,0,0">
            <StackPanel Margin="0,12,0,0">
              <TextBox x:Name="RootBox" Height="34" Padding="9,6" Background="#19283D"
                       BorderBrush="#465A73" Foreground="White"/>
              <TextBlock Text="Keep the default for normal use. Do not choose a project or a shared/network folder."
                         Style="{StaticResource Body}" FontSize="12" Margin="0,7,0,0"/>
            </StackPanel>
          </Expander>
          <TextBlock x:Name="OptionsWarning" Text="" Foreground="#FCA5A5" TextWrapping="Wrap" Margin="0,17,0,0"/>
          <TextBlock Text="The first install downloads npm dependencies, builds the adapter, runs its tests, verifies the release, and then registers it. Internet access is needed for dependencies."
                     Style="{StaticResource Body}" Margin="0,24,0,0"/>
        </StackPanel>
        <Grid x:Name="InstallPage" Visibility="Collapsed">
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions>
          <TextBlock Text="Installing &amp; verifying" FontSize="18" FontWeight="SemiBold" Margin="0,0,0,18"/>
          <StackPanel Grid.Row="1" Margin="0,4,0,18">
            <ProgressBar x:Name="InstallProgress" Height="7" IsIndeterminate="True"
                         Foreground="#31D6EA" Background="#22324A"/>
            <TextBlock x:Name="InstallHint" Text="Building the adapter and running safety checks..."
                       Style="{StaticResource Body}" Margin="0,15,0,0"/>
          </StackPanel>
          <TextBox x:Name="OutputLog" Grid.Row="2" Background="#0D1727" Foreground="#BDD2E8"
                   BorderBrush="#344861" FontFamily="Consolas" FontSize="11" TextWrapping="Wrap"
                   IsReadOnly="True" VerticalScrollBarVisibility="Auto"
                   HorizontalScrollBarVisibility="Disabled" Padding="14"/>
        </Grid>
        <StackPanel x:Name="CompletePage" Visibility="Collapsed">
          <Border Width="69" Height="69" CornerRadius="22" Background="#154953"
                  HorizontalAlignment="Left" Margin="0,0,0,18">
            <TextBlock x:Name="ResultIcon" Text="OK" FontSize="22" FontWeight="Bold"
                       Foreground="#7CF5E1" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <TextBlock x:Name="ResultTitle" FontSize="23" FontWeight="Bold"
                     Text="You're connected!" Margin="0,0,0,11"/>
          <TextBlock x:Name="ResultDescription" Style="{StaticResource Body}" TextWrapping="Wrap"/>
          <Border Background="#141F31" CornerRadius="12" Padding="18" Margin="0,23,0,0">
            <StackPanel>
              <TextBlock Text="Next steps" FontSize="15" FontWeight="SemiBold"
                         Foreground="#DAF8FF" Margin="0,0,0,10"/>
              <TextBlock x:Name="NextSteps" Style="{StaticResource Body}"/>
            </StackPanel>
          </Border>
          <Button x:Name="CopyLogButton" Content="Copy setup log" Style="{StaticResource Secondary}"
                  HorizontalAlignment="Left" Margin="0,22,0,0"/>
        </StackPanel>
      </Grid>
      <Border Grid.Row="2" BorderThickness="0,1,0,0" BorderBrush="#27354B" Padding="0,18,0,0">
        <DockPanel LastChildFill="False">
          <TextBlock Text="LOCAL INSTALL  |  NO API KEY REQUIRED" Foreground="#7589A8"
                     FontSize="10" VerticalAlignment="Center" DockPanel.Dock="Left"/>
          <StackPanel Orientation="Horizontal" DockPanel.Dock="Right">
            <Button x:Name="BackButton" Content="Back" Style="{StaticResource Secondary}"
                    Margin="0,0,12,0" Visibility="Collapsed"/>
            <Button x:Name="NextButton" Content="Continue" Style="{StaticResource Primary}" MinWidth="140"/>
          </StackPanel>
        </DockPanel>
      </Border>
    </Grid>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$names = @('PageTitle','PageSubtitle','StepOne','StepTwo','StepThree','StepFour','CheckPage','OptionsPage','InstallPage','CompletePage','NodeCheck','NpmCheck','T3Check','CosCheck','UpgradeMessage','RefreshButton','NodeHelpButton','T3HelpButton','CosHelpButton','RootBox','RegisterCheck','AutoStartCheck','OptionsWarning','InstallProgress','InstallHint','OutputLog','ResultIcon','ResultTitle','ResultDescription','NextSteps','CopyLogButton','BackButton','NextButton')
foreach ($name in $names) { Set-Variable -Name $name -Value $window.FindName($name) -Scope Script }

$script:page = 0
$script:busy = $false
$script:lastSucceeded = $false
$script:installProcess = $null
$script:stdoutPath = $null
$script:stderrPath = $null
$script:allLog = ''
$script:readiness = $null
$script:installRegistered = $false
$RootBox.Text = $InstallRoot

function Set-Page {
  param([int]$Page)
  $script:page = $Page
  $sections = @($CheckPage,$OptionsPage,$InstallPage,$CompletePage)
  $steps = @($StepOne,$StepTwo,$StepThree,$StepFour)
  for ($i=0; $i -lt $sections.Count; $i++) {
    $sections[$i].Visibility = if ($i -eq $Page) { 'Visible' } else { 'Collapsed' }
    $steps[$i].Foreground = if ($i -eq $Page) { '#67E8F9' } else { '#A1B2CF' }
    $steps[$i].FontWeight = if ($i -eq $Page) { 'SemiBold' } else { 'Normal' }
  }
  $BackButton.Visibility = if ($Page -eq 1) { 'Visible' } else { 'Collapsed' }
  $NextButton.IsEnabled = $true
  switch ($Page) {
    0 {
      $PageTitle.Text = "Let's get connected"
      $PageSubtitle.Text = "A quick system check before we install anything."
      $NextButton.Content = 'Continue'
      Refresh-Checks
    }
    1 {
      $PageTitle.Text = "One last look"
      $PageSubtitle.Text = "Choose how the bridge should connect to T3."
      $NextButton.Content = 'Install bridge'
    }
    2 {
      $PageTitle.Text = "Almost there"
      $PageSubtitle.Text = "Preparing a verified release for your computer."
      $NextButton.Content = 'Installing...'
      $NextButton.IsEnabled = $false
    }
    3 {
      $PageTitle.Text = if ($script:lastSucceeded) { 'All connected' } else { 'Setup needs attention' }
      $PageSubtitle.Text = if ($script:lastSucceeded) { 'The bridge is ready to use.' } else { 'Your current CoS account and T3 history are untouched.' }
      $NextButton.Content = 'Close wizard'
      if (-not $script:lastSucceeded) {
        $BackButton.Content = 'Try again'
        $BackButton.Visibility = 'Visible'
      }
    }
  }
}

function Refresh-Checks {
  try {
    $root = Assert-SafeInstallRoot -Root $RootBox.Text
    $script:readiness = Get-SetupReadiness -Root $root
  } catch {
    $script:readiness = $null
    $UpgradeMessage.Text = $_.Exception.Message
    $NextButton.IsEnabled = $false
    return
  }
  $r = $script:readiness
  $NodeCheck.Text = if ($r.nodeReady) { "READY   Node.js $($r.nodeVersion) (26.12.1+)" } else { 'MISSING   Node.js 26.12.1 or a later Node 26 patch is required' }
  $NpmCheck.Text = if ($r.npmReady) { 'READY   npm package manager' } else { 'MISSING   npm must be installed alongside Node.js' }
  $T3Check.Text = if ($r.t3Ready -and $r.settingsReadable) { 'READY   T3 Code settings detected' } else { 'MISSING   Install and open T3 Code once' }
  $CosCheck.Text = if ($r.cosReady) { 'READY   Chat on Steroids installation detected' } else { 'MISSING   Install Chat on Steroids for Windows' }
  foreach ($row in @(@($NodeCheck,$r.nodeReady),@($NpmCheck,$r.npmReady),@($T3Check,($r.t3Ready -and $r.settingsReadable)),@($CosCheck,$r.cosReady))) {
    $row[0].Foreground = if ($row[1]) { '#86EFAC' } else { '#FCA5A5' }
  }
  if ($r.upgradeBlocked) {
    $UpgradeMessage.Text = 'SAFE UPGRADE PAUSED. Finish ongoing CoS turns, disable only the Chat on Steroids provider in T3 Settings > Providers, then select Refresh checks. Your chat history remains intact.'
    $UpgradeMessage.Foreground = '#FCD34D'
  } elseif ($r.canInstall) {
    $UpgradeMessage.Text = if ($r.existingInstall) { 'Ready to upgrade. The existing private session database will be preserved.' } else { 'All checks passed. Ready for your first installation.' }
    $UpgradeMessage.Foreground = '#86EFAC'
  } else {
    $UpgradeMessage.Text = 'Install the missing prerequisites above, then choose Refresh checks. No files have been changed.'
    $UpgradeMessage.Foreground = '#FCD34D'
  }
  if ($script:page -eq 0) { $NextButton.IsEnabled = [bool]$r.canInstall }
}

function Read-SetupLog {
  $log = ''
  if ($script:stdoutPath -and (Test-Path -LiteralPath $script:stdoutPath)) {
    try { $log += (Get-Content -LiteralPath $script:stdoutPath -Raw -Encoding UTF8 -ErrorAction Stop) } catch {}
  }
  if ($script:stderrPath -and (Test-Path -LiteralPath $script:stderrPath)) {
    try { $log += [Environment]::NewLine + (Get-Content -LiteralPath $script:stderrPath -Raw -Encoding UTF8 -ErrorAction Stop) } catch {}
  }
  if ($script:allLog -ne $log) {
    $script:allLog = $log
    $OutputLog.Text = if ($log.Length -gt 18000) { '... earlier output hidden ...' + [Environment]::NewLine + $log.Substring($log.Length - 18000) } else { $log }
    $OutputLog.ScrollToEnd()
  }
}

function Finish-Setup {
  param([bool]$Succeeded, [string]$Detail)
  $script:busy = $false
  $script:lastSucceeded = $Succeeded
  $InstallProgress.IsIndeterminate = $false
  $InstallProgress.Value = if ($Succeeded) { 100 } else { 0 }
  $ResultIcon.Text = if ($Succeeded) { 'OK' } else { '!' }
  $ResultTitle.Text = if ($Succeeded) { 'Installation complete' } else { 'Installation did not complete' }
  $ResultDescription.Text = $Detail
  $NextSteps.Text = if ($Succeeded -and $script:installRegistered) {
    "1. Open T3 Code (or refresh its providers)." + [Environment]::NewLine +
    "2. Pick Chat on Steroids from the model/provider selector." + [Environment]::NewLine +
    "3. Start a new projectless chat. CoS must be signed in with local control/actions enabled."
  } elseif ($Succeeded) {
    "The verified bridge is installed, but T3 registration was intentionally skipped." + [Environment]::NewLine +
    "Register it using scripts/register-t3.mjs when you are ready."
  } else {
    "Review the setup log. Keep the existing CoS provider disabled if upgrading; do not delete adapter state." +
    [Environment]::NewLine + "After fixing the issue, choose Try again."
  }
  Set-Page 3
}

function Start-Setup {
  $OptionsWarning.Text = ''
  try {
    $root = Assert-SafeInstallRoot -Root $RootBox.Text
    $r = Get-SetupReadiness -Root $root
    if (-not $r.canInstall) { throw 'Prerequisites changed or the existing CoS provider is active. Return to System check and refresh.' }
    $script:installRegistered = ($RegisterCheck.IsChecked -eq $true)
    $script:allLog = ''
    $OutputLog.Text = ''
    $prefix = Join-Path $env:TEMP ('t3-cos-setup-' + [guid]::NewGuid().ToString('N'))
    $script:stdoutPath = $prefix + '.out.log'
    $script:stderrPath = $prefix + '.err.log'
    $script:receiptPath = $prefix + '.exit.txt'
    $script:wrapperPath = $prefix + '.ps1'
    $installer = Join-Path $PSScriptRoot 'install.ps1'
    $flags = ''
    if ($AutoStartCheck.IsChecked -eq $true) { $flags += ' -AutoStartMain' }
    if ($script:installRegistered) { $flags += ' -RegisterT3' }
    # Windows PowerShell Start-Process -PassThru may report an empty ExitCode.
    # A one-use local wrapper leaves a completion receipt; absence fails closed.
    $wrapper = @'
$ErrorActionPreference = 'Stop'
try {
  & '__INSTALLER__' -InstallRoot '__ROOT__' -Mode existing-install __FLAGS__
  if ($LASTEXITCODE -ne 0) { throw 'The core installer returned a non-zero status.' }
  [IO.File]::WriteAllText('__RECEIPT__', '0')
} catch {
  [IO.File]::WriteAllText('__RECEIPT__', '1')
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
'@
    $wrapper = $wrapper.Replace('__INSTALLER__', $installer.Replace("'", "''"))
    $wrapper = $wrapper.Replace('__ROOT__', $root.Replace("'", "''"))
    $wrapper = $wrapper.Replace('__RECEIPT__', $script:receiptPath.Replace("'", "''"))
    $wrapper = $wrapper.Replace('__FLAGS__', $flags)
    [IO.File]::WriteAllText($script:wrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))
    $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script:wrapperPath + '"'
    $script:installProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdoutPath -RedirectStandardError $script:stderrPath
    $script:busy = $true
    Set-Page 2
    $script:pollTimer.Start()
  } catch {
    $OptionsWarning.Text = $_.Exception.Message
  }
}

$script:pollTimer = New-Object Windows.Threading.DispatcherTimer
$script:pollTimer.Interval = [TimeSpan]::FromMilliseconds(550)
$script:pollTimer.Add_Tick({
  Read-SetupLog
  if ($script:installProcess -and $script:installProcess.HasExited) {
    $script:pollTimer.Stop()
    Read-SetupLog
    $script:installProcess.WaitForExit()
    $exitCode = if (Test-Path -LiteralPath $script:receiptPath) {
      (Get-Content -LiteralPath $script:receiptPath -Raw -Encoding UTF8).Trim()
    } else { 'no completion receipt' }
    $script:installProcess.Dispose()
    $script:installProcess = $null
    if ($exitCode -eq 0) {
      Finish-Setup -Succeeded $true -Detail 'The verified bridge has been installed. Your existing ChatGPT login, CoS profile and T3 conversations are preserved.'
    } else {
      Finish-Setup -Succeeded $false -Detail ('Setup exited with code ' + $exitCode + '. The log below contains the installer output; existing session data was not intentionally cleared.')
    }
  }
})
$RefreshButton.Add_Click({ Refresh-Checks })
$NodeHelpButton.Add_Click({ Start-Process 'https://nodejs.org/en/download' })
$T3HelpButton.Add_Click({ Start-Process 'https://github.com/pingdotgg/t3code/releases' })
$CosHelpButton.Add_Click({ Start-Process 'https://github.com/totec448-spec/chat-on-steroids/releases' })
$NextButton.Add_Click({
  if ($script:page -eq 0 -and $script:readiness.canInstall) { Set-Page 1 }
  elseif ($script:page -eq 1) { Start-Setup }
  elseif ($script:page -eq 3) { $window.Close() }
})
$BackButton.Add_Click({
  if ($script:page -eq 1) { Set-Page 0 }
  elseif ($script:page -eq 3 -and -not $script:lastSucceeded) {
    $BackButton.Content = 'Back'
    Set-Page 0
  }
})
$CopyLogButton.Add_Click({
  if ($script:allLog) { [Windows.Clipboard]::SetText($script:allLog) }
})
$window.Add_Closing({
  param($sender, $args)
  if ($script:busy) {
    $args.Cancel = $true
    [Windows.MessageBox]::Show('The installer is still running. Please keep this window open so the verified setup can finish.', 'Installation in progress', 'OK', 'Information') | Out-Null
  } else {
    $script:pollTimer.Stop()
    foreach ($file in @($script:stdoutPath, $script:stderrPath, $script:receiptPath, $script:wrapperPath)) {
      if ($file -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    }
  }
})
Set-Page 0
if ($ValidateUi) { Write-Output 'SETUP_UI_VALID'; return }
[void]$window.ShowDialog()
