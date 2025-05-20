#!/bin/bash
# compendium-deploy-macos.sh - Deployment script for Compendium Navigation Server optimized for macOS

set -eo pipefail
IFS=$'\n\t'

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
CURRENT_USER=$(whoami)
APP_USER="${COMPENDIUM_USER:-$CURRENT_USER}"
HOSTNAME="compendium"
APP_DIR="${APP_DIR:-$HOME/compendiumnav2}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/compendium-backups}"
NODE_VERSION="18"
GIT_REPO="https://github.com/base-zz/compendium2.git"
GIT_BRANCH="main"
TARGET_VERSION="${COMPENDIUM_VERSION:-latest}"

# Default ports
DEFAULT_HTTP_PORT=8080
DEFAULT_WS_PORT=3009
HTTP_PORT=$DEFAULT_HTTP_PORT
WS_PORT=$DEFAULT_WS_PORT

# Check if running as root (not recommended on macOS)
check_root() {
    if [ "$(id -u)" -eq 0 ]; then
        echo -e "${YELLOW}Warning: Running as root is not recommended on macOS.${NC}" >&2
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Check macOS version
check_macos() {
    echo -e "${BLUE}Checking macOS compatibility...${NC}"
    
    if [ "$(uname)" != "Darwin" ]; then
        echo -e "${RED}This script is designed for macOS only.${NC}" >&2
        exit 1
    fi
    
    local macos_version=$(sw_vers -productVersion)
    echo -e "${GREEN}Detected: macOS $macos_version${NC}"
    
    # Check if macOS version is supported (10.15+)
    if [[ $(echo "$macos_version" | cut -d. -f1) -lt 10 || ($(echo "$macos_version" | cut -d. -f1) -eq 10 && $(echo "$macos_version" | cut -d. -f2) -lt 15) ]]; then
        echo -e "${YELLOW}Warning: macOS version $macos_version may not be fully supported. Recommended: macOS 10.15 or later.${NC}"
    fi
    
    # Check available disk space
    local disk_space=$(df -h "$HOME" | awk 'NR==2 {print $4}')
    echo -e "${BLUE}Available disk space: $disk_space${NC}"
    
    # Check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        echo -e "${YELLOW}Homebrew is not installed. It's recommended for installing dependencies.${NC}"
        read -p "Would you like to install Homebrew? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        else
            echo -e "${YELLOW}Proceeding without Homebrew. You may need to install dependencies manually.${NC}"
        fi
    else
        echo -e "${GREEN}Homebrew is installed.${NC}"
    fi
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if port is available
is_port_available() {
    local port=$1
    if ! nc -z 127.0.0.1 "$port" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Find an available port starting from the given port
find_available_port() {
    local port=$1
    while ! is_port_available $port; do
        echo -e "${YELLOW}Port $port is in use, trying $((port+1))${NC}"
        port=$((port+1))
    done
    echo $port
}

# Initialize ports
initialize_ports() {
    echo -e "${BLUE}Checking port availability...${NC}"
    HTTP_PORT=$(find_available_port $DEFAULT_HTTP_PORT)
    WS_PORT=$(find_available_port $DEFAULT_WS_PORT)
    
    if [ "$HTTP_PORT" -eq "$WS_PORT" ]; then
        WS_PORT=$((WS_PORT+1))
        echo -e "${YELLOW}Adjusted WebSocket port to $WS_PORT to avoid conflict with HTTP port${NC}"
    fi
    
    echo -e "${GREEN}Using ports - HTTP: $HTTP_PORT, WebSocket: $WS_PORT${NC}"
}

# Validate configuration
validate_config() {
    echo -e "${BLUE}Validating configuration...${NC}"
    
    # Check if ports are available
    if ! is_port_available $HTTP_PORT; then
        echo -e "${YELLOW}HTTP port $HTTP_PORT is in use, will find another port${NC}"
        HTTP_PORT=$(find_available_port $HTTP_PORT)
    fi
    
    if ! is_port_available $WS_PORT; then
        echo -e "${YELLOW}WebSocket port $WS_PORT is in use, will find another port${NC}"
        WS_PORT=$(find_available_port $WS_PORT)
    fi
    
    # Ensure ports are different
    if [ "$HTTP_PORT" -eq "$WS_PORT" ]; then
        WS_PORT=$((WS_PORT+1))
        echo -e "${YELLOW}Adjusted WebSocket port to $WS_PORT to avoid conflict with HTTP port${NC}"
    fi
    
    echo -e "${GREEN}Configuration validated${NC}"
}

# Backup existing installation
backup_existing() {
    echo -e "${BLUE}Checking for existing installation...${NC}"
    
    if [ -d "$APP_DIR" ]; then
        echo -e "${YELLOW}Existing installation found, creating backup...${NC}"
        local timestamp=$(date +%Y%m%d_%H%M%S)
        local backup_path="$BACKUP_DIR/backup_$timestamp"
        
        mkdir -p "$BACKUP_DIR"
        cp -r "$APP_DIR" "$backup_path"
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Backup created at $backup_path${NC}"
        else
            echo -e "${RED}Failed to create backup${NC}" >&2
            return 1
        fi
    else
        echo -e "${GREEN}No existing installation found, proceeding with fresh install${NC}"
    fi
}

# Install system dependencies using Homebrew
install_dependencies() {
    echo -e "${BLUE}Installing system dependencies...${NC}"
    
    if ! command_exists brew; then
        echo -e "${RED}Homebrew is required to install dependencies. Please install Homebrew first.${NC}" >&2
        echo -e "${BLUE}Visit: https://brew.sh${NC}"
        return 1
    fi
    
    # Update Homebrew
    brew update
    
    # Install required packages
    local packages=(
        git
        node@$NODE_VERSION
        python3
        libusb
        avahi  # For mDNS support
    )
    
    for package in "${packages[@]}"; do
        if ! brew list "$package" &>/dev/null; then
            echo -e "${BLUE}Installing $package...${NC}"
            brew install "$package"
        else
            echo -e "${GREEN}$package is already installed${NC}"
        fi
    done
    
    # Ensure node from node@18 is in PATH
    if ! command_exists node; then
        echo -e "${BLUE}Adding node to PATH...${NC}"
        brew link --force node@$NODE_VERSION
    fi
    
    # Install PM2
    if ! command_exists pm2; then
        echo -e "${BLUE}Installing PM2...${NC}"
        npm install -g pm2
    else
        echo -e "${GREEN}PM2 is already installed${NC}"
    fi
    
    echo -e "${GREEN}Dependencies installed successfully${NC}"
    return 0
}

# Setup repository
setup_repository() {
    echo -e "${BLUE}Setting up repository...${NC}"
    
    if [ ! -d "$APP_DIR" ]; then
        # Clone the repository
        echo -e "${BLUE}Cloning repository...${NC}"
        git clone --branch "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"
    else
        # Update existing repository
        echo -e "${BLUE}Updating repository...${NC}"
        cd "$APP_DIR" || return 1
        git fetch --all
    fi
    
    # Checkout specific version if requested
    cd "$APP_DIR" || return 1
    if [ "$TARGET_VERSION" != "latest" ]; then
        echo -e "${BLUE}Checking out version $TARGET_VERSION...${NC}"
        git checkout "$TARGET_VERSION"
    else
        echo -e "${BLUE}Checking out latest version...${NC}"
        git checkout "$GIT_BRANCH"
        git pull
    fi
    
    echo -e "${GREEN}Repository setup completed${NC}"
    return 0
}

# Configure environment variables
configure_environment() {
    echo -e "${BLUE}Configuring environment...${NC}"
    
    # Create .env file if it doesn't exist
    local env_file="$APP_DIR/.env"
    if [ ! -f "$env_file" ]; then
        touch "$env_file"
    fi
    
    # Set environment variables
    set_env_var "PORT" "$HTTP_PORT"
    set_env_var "VPS_WS_PORT" "$WS_PORT"
    set_env_var "NODE_ENV" "development"  # Use development mode on macOS for better debugging
    set_env_var "FRONTEND_URL" "http://localhost:$HTTP_PORT"
    
    # macOS specific settings
    set_env_var "MACOS" "true"
    
    # Log level
    set_env_var "LOG_LEVEL" "debug"  # More detailed logs for macOS development
    
    # Data directory
    local data_dir="$HOME/compendium-data"
    mkdir -p "$data_dir"
    set_env_var "DATA_DIR" "$data_dir"
    
    echo -e "${GREEN}Environment configured${NC}"
    return 0
}

# Helper function to set or update an environment variable
set_env_var() {
    local key=$1
    local value=$2
    local env_file="$APP_DIR/.env"
    
    # Remove existing entry if present
    if grep -q "^$key=" "$env_file"; then
        sed -i.bak "/^$key=/d" "$env_file" && rm "$env_file.bak"
    fi
    
    # Add new entry
    echo "$key=$value" >> "$env_file"
}

# Configure macOS LaunchAgent for auto-start
setup_launch_agent() {
    echo -e "${BLUE}Setting up LaunchAgent for auto-start...${NC}"
    
    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_file="$plist_dir/com.compendium.navigation.plist"
    
    # Create LaunchAgents directory if it doesn't exist
    mkdir -p "$plist_dir"
    
    # Create plist file
    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.compendium.navigation</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which npm)</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/compendium.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/compendium.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
        <key>NODE_ENV</key>
        <string>development</string>
        <key>PORT</key>
        <string>$HTTP_PORT</string>
        <key>VPS_WS_PORT</key>
        <string>$WS_PORT</string>
    </dict>
</dict>
</plist>
EOF
    
    # Load the LaunchAgent
    launchctl unload "$plist_file" 2>/dev/null || true
    launchctl load -w "$plist_file"
    
    echo -e "${GREEN}LaunchAgent configured${NC}"
    return 0
}

# Configure macOS firewall
configure_firewall() {
    echo -e "${BLUE}Configuring macOS firewall...${NC}"
    
    # Check if firewall is enabled
    local firewall_status=$(defaults read /Library/Preferences/com.apple.alf globalstate)
    
    if [ "$firewall_status" -eq 0 ]; then
        echo -e "${YELLOW}Firewall is disabled. No configuration needed.${NC}"
        return 0
    fi
    
    # Add node to firewall exceptions
    local node_path=$(which node)
    
    echo -e "${YELLOW}You may need to manually add Node.js to the firewall exceptions.${NC}"
    echo -e "${YELLOW}Go to System Preferences > Security & Privacy > Firewall > Firewall Options${NC}"
    echo -e "${YELLOW}Add an exception for: $node_path${NC}"
    
    return 0
}

# Start the service
start_service() {
    echo -e "${BLUE}Starting Compendium Navigation Server...${NC}"
    
    cd "$APP_DIR" || return 1
    
    # Check if already running with PM2
    if command_exists pm2 && pm2 list | grep -q "compendium"; then
        echo -e "${BLUE}Restarting with PM2...${NC}"
        pm2 restart compendium
    else
        echo -e "${BLUE}Starting with PM2...${NC}"
        pm2 start npm --name "compendium" -- start
    fi
    
    # Save PM2 configuration
    pm2 save
    
    echo -e "${GREEN}Service started${NC}"
    return 0
}

# Health check
health_check() {
    echo -e "${BLUE}Performing health check...${NC}"
    
    # Wait for service to start
    sleep 5
    
    # Check if HTTP port is open
    if ! is_port_available $HTTP_PORT; then
        echo -e "${GREEN}HTTP port $HTTP_PORT is open${NC}"
    else
        echo -e "${RED}HTTP port $HTTP_PORT is not open${NC}" >&2
        return 1
    fi
    
    # Check if WebSocket port is open
    if ! is_port_available $WS_PORT; then
        echo -e "${GREEN}WebSocket port $WS_PORT is open${NC}"
    else
        echo -e "${RED}WebSocket port $WS_PORT is not open${NC}" >&2
        return 1
    fi
    
    # Try to access the server
    if command_exists curl; then
        echo -e "${BLUE}Testing HTTP connection...${NC}"
        if curl -s "http://localhost:$HTTP_PORT" > /dev/null; then
            echo -e "${GREEN}HTTP connection successful${NC}"
        else
            echo -e "${YELLOW}HTTP connection failed. Server may still be starting.${NC}"
        fi
    fi
    
    echo -e "${GREEN}Health check completed${NC}"
    return 0
}

# Main installation function
install() {
    check_root
    check_macos
    initialize_ports
    validate_config
    backup_existing
    install_dependencies
    setup_repository
    configure_environment
    
    # Install npm dependencies
    cd "$APP_DIR" || exit 1
    echo -e "${BLUE}Installing npm dependencies...${NC}"
    npm install
    
    setup_launch_agent
    configure_firewall
    start_service
    health_check
    
    echo -e "${GREEN}Compendium Navigation Server has been successfully installed!${NC}"
    echo -e "${GREEN}You can access it at http://localhost:$HTTP_PORT${NC}"
    echo -e "${BLUE}Logs are available at:${NC}"
    echo -e "${BLUE}- $HOME/Library/Logs/compendium.log${NC}"
    echo -e "${BLUE}- $HOME/Library/Logs/compendium.error.log${NC}"
}

# Update function
update() {
    echo -e "${BLUE}Updating Compendium Navigation Server...${NC}"
    
    check_macos
    backup_existing
    
    # Stop service
    if command_exists pm2 && pm2 list | grep -q "compendium"; then
        pm2 stop compendium
    fi
    
    # Update repository
    setup_repository
    
    # Update environment
    configure_environment
    
    # Update dependencies
    cd "$APP_DIR" || exit 1
    echo -e "${BLUE}Updating npm dependencies...${NC}"
    npm install
    
    # Restart service
    start_service
    health_check
    
    echo -e "${GREEN}Compendium Navigation Server has been successfully updated!${NC}"
    echo -e "${GREEN}You can access it at http://localhost:$HTTP_PORT${NC}"
}

# Uninstall function
uninstall() {
    echo -e "${BLUE}Uninstalling Compendium Navigation Server...${NC}"
    
    # Confirm uninstall
    read -p "Are you sure you want to uninstall Compendium Navigation Server? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}Uninstall cancelled${NC}"
        return 0
    fi
    
    # Stop service
    if command_exists pm2 && pm2 list | grep -q "compendium"; then
        pm2 stop compendium
        pm2 delete compendium
        pm2 save
    fi
    
    # Remove LaunchAgent
    local plist_file="$HOME/Library/LaunchAgents/com.compendium.navigation.plist"
    if [ -f "$plist_file" ]; then
        launchctl unload "$plist_file" 2>/dev/null || true
        rm -f "$plist_file"
    fi
    
    # Backup existing installation
    backup_existing
    
    # Remove application directory
    rm -rf "$APP_DIR"
    
    echo -e "${GREEN}Compendium Navigation Server has been successfully uninstalled${NC}"
    echo -e "${YELLOW}Backups are still available at $BACKUP_DIR${NC}"
    echo -e "${YELLOW}Data directory at $HOME/compendium-data has not been removed${NC}"
}

# Show help
show_help() {
    echo "Usage: $0 [command]"
    echo
    echo "Commands:"
    echo "  install    Install Compendium Navigation Server"
    echo "  update     Update existing installation"
    echo "  uninstall  Remove Compendium Navigation Server"
    echo "  help       Show this help message"
    echo
    echo "Environment variables:"
    echo "  COMPENDIUM_USER     User to run the service as (default: current user)"
    echo "  COMPENDIUM_VERSION  Version to install (default: latest)"
    echo "  APP_DIR             Installation directory (default: ~/compendiumnav2)"
    echo "  BACKUP_DIR          Backup directory (default: ~/compendium-backups)"
}

# Main script execution
case "${1:-}" in
    install)
        install
        ;;
    update)
        update
        ;;
    uninstall)
        uninstall
        ;;
    help)
        show_help
        ;;
    *)
        show_help
        exit 1
        ;;
esac

exit 0
