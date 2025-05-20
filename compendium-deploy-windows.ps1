# compendium-deploy-windows.ps1 - Deployment script for Compendium Navigation Server on Windows
# Run this script as Administrator in PowerShell

# Configuration
$ErrorActionPreference = "Stop"
$AppName = "CompendiumNavigationServer"
$AppUser = $env:USERNAME
$AppDir = "$env:USERPROFILE\compendiumnav2"
$BackupDir = "$env:USERPROFILE\compendium-backups"
$DataDir = "$env:USERPROFILE\compendium-data"
$NodeVersion = "18"
$GitRepo = "https://github.com/base-zz/compendium2.git"
$GitBranch = "main"
$TargetVersion = $env:COMPENDIUM_VERSION
if (-not $TargetVersion) { $TargetVersion = "latest" }

# Default ports
$DefaultHttpPort = 8080
$DefaultWsPort = 3009
$HttpPort = $DefaultHttpPort
$WsPort = $DefaultWsPort

# Functions
function Write-ColorOutput {
    param (
        [Parameter(Mandatory=$true)]
        [string]$Message,
        
        [Parameter(Mandatory=$false)]
        [string]$ForegroundColor = "White"
    )
    
    $originalColor = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    Write-Output $Message
    $host.UI.RawUI.ForegroundColor = $originalColor
}

function Test-Administrator {
    $currentUser = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-WindowsVersion {
    Write-ColorOutput "Checking Windows compatibility..." "Cyan"
    
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem
    $osVersion = [Version]$osInfo.Version
    $osName = $osInfo.Caption
    
    Write-ColorOutput "Detected: $osName (Version $($osVersion.ToString()))" "Green"
    
    # Check if Windows 10/11 or Server 2016+
    if ($osVersion.Major -lt 10) {
        Write-ColorOutput "Warning: Windows version may not be fully supported. Recommended: Windows 10 or later." "Yellow"
    }
    
    # Check available disk space
    $drive = Get-PSDrive -Name ($AppDir.Substring(0, 1))
    $freeSpace = [math]::Round($drive.Free / 1GB, 2)
    Write-ColorOutput "Available disk space: $freeSpace GB" "Cyan"
    
    if ($freeSpace -lt 2) {
        Write-ColorOutput "Warning: Low disk space. At least 2 GB recommended." "Yellow"
    }
}

function Test-CommandExists {
    param (
        [Parameter(Mandatory=$true)]
        [string]$Command
    )
    
    return (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Test-PortAvailable {
    param (
        [Parameter(Mandatory=$true)]
        [int]$Port
    )
    
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($listener -ne $null) {
            $listener.Stop()
        }
    }
}

function Find-AvailablePort {
    param (
        [Parameter(Mandatory=$true)]
        [int]$StartPort
    )
    
    $port = $StartPort
    while (-not (Test-PortAvailable -Port $port)) {
        Write-ColorOutput "Port $port is in use, trying $($port+1)" "Yellow"
        $port++
    }
    
    return $port
}

function Initialize-Ports {
    Write-ColorOutput "Checking port availability..." "Cyan"
    
    $script:HttpPort = Find-AvailablePort -StartPort $DefaultHttpPort
    $script:WsPort = Find-AvailablePort -StartPort $DefaultWsPort
    
    if ($HttpPort -eq $WsPort) {
        $script:WsPort = $WsPort + 1
        Write-ColorOutput "Adjusted WebSocket port to $WsPort to avoid conflict with HTTP port" "Yellow"
    }
    
    Write-ColorOutput "Using ports - HTTP: $HttpPort, WebSocket: $WsPort" "Green"
}

function Backup-ExistingInstallation {
    Write-ColorOutput "Checking for existing installation..." "Cyan"
    
    if (Test-Path $AppDir) {
        Write-ColorOutput "Existing installation found, creating backup..." "Yellow"
        
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupPath = "$BackupDir\backup_$timestamp"
        
        if (-not (Test-Path $BackupDir)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        }
        
        try {
            Copy-Item -Path $AppDir -Destination $backupPath -Recurse -Force
            Write-ColorOutput "Backup created at $backupPath" "Green"
        }
        catch {
            Write-ColorOutput "Failed to create backup: $_" "Red"
            throw
        }
    }
    else {
        Write-ColorOutput "No existing installation found, proceeding with fresh install" "Green"
    }
}

function Install-Dependencies {
    Write-ColorOutput "Installing system dependencies..." "Cyan"
    
    # Check for Chocolatey
    if (-not (Test-CommandExists -Command "choco")) {
        Write-ColorOutput "Installing Chocolatey package manager..." "Cyan"
        try {
            Set-ExecutionPolicy Bypass -Scope Process -Force
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
            Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
        }
        catch {
            Write-ColorOutput "Failed to install Chocolatey: $_" "Red"
            Write-ColorOutput "Please install Chocolatey manually: https://chocolatey.org/install" "Yellow"
            throw
        }
    }
    
    # Install Git if not present
    if (-not (Test-CommandExists -Command "git")) {
        Write-ColorOutput "Installing Git..." "Cyan"
        choco install git -y
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    }
    
    # Install Node.js if not present
    if (-not (Test-CommandExists -Command "node")) {
        Write-ColorOutput "Installing Node.js $NodeVersion..." "Cyan"
        choco install nodejs-lts --version=$NodeVersion -y
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    }
    
    # Install Python if not present
    if (-not (Test-CommandExists -Command "python")) {
        Write-ColorOutput "Installing Python 3..." "Cyan"
        choco install python3 -y
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    }
    
    # Install PM2 if not present
    if (-not (Test-CommandExists -Command "pm2")) {
        Write-ColorOutput "Installing PM2..." "Cyan"
        npm install -g pm2 windows-service
    }
    
    # Install Bonjour Print Services for mDNS support
    if (-not (Get-Service "Bonjour Service" -ErrorAction SilentlyContinue)) {
        Write-ColorOutput "Installing Bonjour Print Services for mDNS support..." "Cyan"
        Write-ColorOutput "Note: You may need to manually install Bonjour Print Services from Apple" "Yellow"
        Write-ColorOutput "Download link: https://support.apple.com/kb/DL999" "Yellow"
    }
    
    Write-ColorOutput "Dependencies installed successfully" "Green"
}

function Setup-Repository {
    Write-ColorOutput "Setting up repository..." "Cyan"
    
    if (-not (Test-Path $AppDir)) {
        # Clone the repository
        Write-ColorOutput "Cloning repository..." "Cyan"
        git clone --branch $GitBranch $GitRepo $AppDir
    }
    else {
        # Update existing repository
        Write-ColorOutput "Updating repository..." "Cyan"
        Push-Location $AppDir
        git fetch --all
        Pop-Location
    }
    
    # Checkout specific version if requested
    Push-Location $AppDir
    if ($TargetVersion -ne "latest") {
        Write-ColorOutput "Checking out version $TargetVersion..." "Cyan"
        git checkout $TargetVersion
    }
    else {
        Write-ColorOutput "Checking out latest version..." "Cyan"
        git checkout $GitBranch
        git pull
    }
    Pop-Location
    
    Write-ColorOutput "Repository setup completed" "Green"
}

function Configure-Environment {
    Write-ColorOutput "Configuring environment..." "Cyan"
    
    # Create .env file if it doesn't exist
    $envFile = "$AppDir\.env"
    if (-not (Test-Path $envFile)) {
        New-Item -ItemType File -Path $envFile -Force | Out-Null
    }
    else {
        # Clear existing file
        Clear-Content $envFile
    }
    
    # Set environment variables
    @(
        "PORT=$HttpPort",
        "VPS_WS_PORT=$WsPort",
        "NODE_ENV=production",
        "FRONTEND_URL=http://localhost:$HttpPort",
        "WINDOWS=true",
        "LOG_LEVEL=info"
    ) | Out-File -FilePath $envFile -Encoding utf8
    
    # Create data directory
    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }
    
    # Add DATA_DIR to .env
    Add-Content -Path $envFile -Value "DATA_DIR=$($DataDir.Replace('\', '\\'))"
    
    Write-ColorOutput "Environment configured" "Green"
}

function Configure-WindowsFirewall {
    Write-ColorOutput "Configuring Windows Firewall..." "Cyan"
    
    # Check if firewall is enabled
    $firewallEnabled = (Get-NetFirewallProfile | Where-Object { $_.Enabled -eq $true } | Measure-Object).Count -gt 0
    
    if ($firewallEnabled) {
        # Add firewall rules for HTTP and WebSocket ports
        $ruleName = "CompendiumNavigationServer-HTTP"
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -DisplayName $ruleName
        }
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $HttpPort -Action Allow | Out-Null
        
        $ruleName = "CompendiumNavigationServer-WS"
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -DisplayName $ruleName
        }
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $WsPort -Action Allow | Out-Null
        
        Write-ColorOutput "Firewall rules added" "Green"
    }
    else {
        Write-ColorOutput "Firewall is disabled, no rules needed" "Yellow"
    }
}

function Setup-WindowsService {
    Write-ColorOutput "Setting up Windows Service..." "Cyan"
    
    # Check if PM2 is installed
    if (-not (Test-CommandExists -Command "pm2")) {
        Write-ColorOutput "PM2 is not installed. Cannot setup Windows Service." "Red"
        return
    }
    
    # Stop existing service if running
    if (Get-Service "PM2*" -ErrorAction SilentlyContinue) {
        Write-ColorOutput "Stopping existing PM2 service..." "Cyan"
        Stop-Service "PM2*" -Force
    }
    
    # Remove existing PM2 service
    if (Get-Service "PM2*" -ErrorAction SilentlyContinue) {
        Write-ColorOutput "Removing existing PM2 service..." "Cyan"
        Push-Location $AppDir
        pm2 delete all
        pm2-service-uninstall
        Pop-Location
    }
    
    # Start the application with PM2
    Push-Location $AppDir
    Write-ColorOutput "Starting application with PM2..." "Cyan"
    pm2 start npm --name "compendium" -- start
    pm2 save
    
    # Install PM2 as a Windows service
    Write-ColorOutput "Installing PM2 as a Windows service..." "Cyan"
    pm2-service-install -name $AppName
    Pop-Location
    
    # Start the service
    Start-Service "PM2 $AppName"
    
    Write-ColorOutput "Windows Service setup completed" "Green"
}

function Health-Check {
    Write-ColorOutput "Performing health check..." "Cyan"
    
    # Wait for service to start
    Start-Sleep -Seconds 5
    
    # Check if HTTP port is open
    if (-not (Test-PortAvailable -Port $HttpPort)) {
        Write-ColorOutput "HTTP port $HttpPort is in use (good)" "Green"
    }
    else {
        Write-ColorOutput "HTTP port $HttpPort is not in use. Service may not be running correctly." "Red"
    }
    
    # Check if WebSocket port is open
    if (-not (Test-PortAvailable -Port $WsPort)) {
        Write-ColorOutput "WebSocket port $WsPort is in use (good)" "Green"
    }
    else {
        Write-ColorOutput "WebSocket port $WsPort is not in use. Service may not be running correctly." "Red"
    }
    
    # Try to access the server
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$HttpPort" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-ColorOutput "HTTP connection successful" "Green"
        }
    }
    catch {
        Write-ColorOutput "HTTP connection failed. Server may still be starting." "Yellow"
    }
    
    Write-ColorOutput "Health check completed" "Green"
}

function Install-CompendiumServer {
    if (-not (Test-Administrator)) {
        Write-ColorOutput "This script must be run as Administrator. Please restart PowerShell as Administrator." "Red"
        exit 1
    }
    
    Test-WindowsVersion
    Initialize-Ports
    Backup-ExistingInstallation
    Install-Dependencies
    Setup-Repository
    Configure-Environment
    
    # Install npm dependencies
    Push-Location $AppDir
    Write-ColorOutput "Installing npm dependencies..." "Cyan"
    npm install --no-optional
    Pop-Location
    
    Configure-WindowsFirewall
    Setup-WindowsService
    Health-Check
    
    Write-ColorOutput "Compendium Navigation Server has been successfully installed!" "Green"
    Write-ColorOutput "You can access it at http://localhost:$HttpPort" "Green"
    Write-ColorOutput "The server will start automatically when Windows boots" "Cyan"
}

function Update-CompendiumServer {
    if (-not (Test-Administrator)) {
        Write-ColorOutput "This script must be run as Administrator. Please restart PowerShell as Administrator." "Red"
        exit 1
    }
    
    Write-ColorOutput "Updating Compendium Navigation Server..." "Cyan"
    
    Backup-ExistingInstallation
    
    # Stop service
    if (Get-Service "PM2*" -ErrorAction SilentlyContinue) {
        Stop-Service "PM2*" -Force
    }
    
    Setup-Repository
    Configure-Environment
    
    # Update npm dependencies
    Push-Location $AppDir
    Write-ColorOutput "Updating npm dependencies..." "Cyan"
    npm install --no-optional
    Pop-Location
    
    # Start service
    if (Get-Service "PM2*" -ErrorAction SilentlyContinue) {
        Start-Service "PM2*"
    }
    else {
        Setup-WindowsService
    }
    
    Health-Check
    
    Write-ColorOutput "Compendium Navigation Server has been successfully updated!" "Green"
    Write-ColorOutput "You can access it at http://localhost:$HttpPort" "Green"
}

function Uninstall-CompendiumServer {
    if (-not (Test-Administrator)) {
        Write-ColorOutput "This script must be run as Administrator. Please restart PowerShell as Administrator." "Red"
        exit 1
    }
    
    Write-ColorOutput "Uninstalling Compendium Navigation Server..." "Cyan"
    
    # Confirm uninstall
    $confirmation = Read-Host "Are you sure you want to uninstall Compendium Navigation Server? (y/n)"
    if ($confirmation -ne 'y') {
        Write-ColorOutput "Uninstall cancelled" "Green"
        return
    }
    
    # Backup existing installation
    Backup-ExistingInstallation
    
    # Stop and remove service
    if (Get-Service "PM2*" -ErrorAction SilentlyContinue) {
        Write-ColorOutput "Stopping and removing service..." "Cyan"
        Stop-Service "PM2*" -Force
        
        Push-Location $AppDir
        pm2 delete all
        pm2-service-uninstall
        Pop-Location
    }
    
    # Remove firewall rules
    if (Get-NetFirewallRule -DisplayName "CompendiumNavigationServer-HTTP" -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName "CompendiumNavigationServer-HTTP"
    }
    
    if (Get-NetFirewallRule -DisplayName "CompendiumNavigationServer-WS" -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName "CompendiumNavigationServer-WS"
    }
    
    # Remove application directory
    if (Test-Path $AppDir) {
        Remove-Item -Path $AppDir -Recurse -Force
    }
    
    Write-ColorOutput "Compendium Navigation Server has been successfully uninstalled" "Green"
    Write-ColorOutput "Backups are still available at $BackupDir" "Yellow"
    Write-ColorOutput "Data directory at $DataDir has not been removed" "Yellow"
}

function Show-Help {
    Write-Output "Usage: .\compendium-deploy-windows.ps1 [command]"
    Write-Output ""
    Write-Output "Commands:"
    Write-Output "  install    Install Compendium Navigation Server"
    Write-Output "  update     Update existing installation"
    Write-Output "  uninstall  Remove Compendium Navigation Server"
    Write-Output "  help       Show this help message"
    Write-Output ""
    Write-Output "Environment variables:"
    Write-Output "  COMPENDIUM_VERSION  Version to install (default: latest)"
    Write-Output ""
    Write-Output "Note: This script must be run as Administrator in PowerShell"
}

# Main script execution
if ($args.Count -eq 0) {
    Show-Help
    exit 1
}

switch ($args[0]) {
    "install" {
        Install-CompendiumServer
    }
    "update" {
        Update-CompendiumServer
    }
    "uninstall" {
        Uninstall-CompendiumServer
    }
    "help" {
        Show-Help
    }
    default {
        Write-ColorOutput "Unknown command: $($args[0])" "Red"
        Show-Help
        exit 1
    }
}
