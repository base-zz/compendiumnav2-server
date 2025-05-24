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
BACKUP_DIR="${BACKUP_DIR:-$HOME/compendium-backups}"

# Always false on macOS
IS_RASPBERRY_PI=false
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

# Check macOS version and compatibility
check_macos() {
    echo -e "${BLUE}🔍 Checking system compatibility...${NC}"
    
    # Verify macOS
    if [ "$(uname)" != "Darwin" ]; then
        echo -e "${RED}✗ This script is designed for macOS only.${NC}" >&2
        exit 1
    fi
    
    # Get macOS version
    if ! command_exists sw_vers; then
        echo -e "${RED}✗ Could not determine macOS version${NC}" >&2
        return 1
    fi
    
    local macos_version
    macos_version=$(sw_vers -productVersion)
    echo -e "${GREEN}✓ Detected: macOS $macos_version${NC}"
    
    # Check architecture
    local arch
    arch=$(uname -m)
    if [ "$arch" = "arm64" ]; then
        echo -e "${GREEN}✓ Architecture: Apple Silicon (${arch})${NC}"
    elif [ "$arch" = "x86_64" ]; then
        echo -e "${GREEN}✓ Architecture: Intel (${arch})${NC}"
    else
        echo -e "${YELLOW}⚠ Unsupported architecture: ${arch}${NC}"
    fi
    
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
    if ! command -v "$1" >/dev/null 2>&1; then
        echo -e "${YELLOW}✗ Command not found: $1${NC}" >&2
        return 1
    fi
    return 0
}

# Check if port is available
is_port_available() {
    local port=$1
    
    # Check if lsof is available (preferred on macOS)
    if command_exists lsof; then
        if ! lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            # Port is available
            return 0
        fi
    # Fallback to nc if lsof not available
    elif command_exists nc; then
        if ! nc -z 127.0.0.1 "$port" &>/dev/null; then
            # Port is available
            return 0
        fi
    else
        echo -e "${YELLOW}✗ Neither lsof nor nc found, port checking disabled${NC}" >&2
        return 0
    fi
    
    echo -e "${YELLOW}Port ${port} is in use${NC}" >&2
    return 1
}

# Find an available port starting from the given port
find_available_port() {
    local port=$1
    local max_attempts=100
    local attempts=0
    
    while [ $attempts -lt $max_attempts ]; do
        if is_port_available $port; then
            echo $port
            return 0
        fi
        
        echo -e "${YELLOW}Port $port is in use, trying $((port+1))${NC}" >&2
        port=$((port+1))
        attempts=$((attempts+1))
        
        # Skip ports that are commonly used by macOS
        if [ $port -eq 49152 ]; then
            port=60000  # Skip dynamic/private ports
        fi
    done
    
    echo -e "${RED}✗ Failed to find available port after $max_attempts attempts${NC}" >&2
    return 1
}

# Initialize ports
initialize_ports() {
    echo -e "${BLUE}🔍 Checking port availability...${NC}"
    
    # Find available HTTP port
    HTTP_PORT=$(find_available_port $DEFAULT_HTTP_PORT) || {
        echo -e "${RED}✗ Failed to find available HTTP port${NC}" >&2
        return 1
    }
    
    # Find available WebSocket port, ensuring it's different from HTTP port
    WS_PORT=$DEFAULT_WS_PORT
    if [ "$WS_PORT" -eq "$HTTP_PORT" ]; then
        WS_PORT=$((WS_PORT + 1))
    fi
    
    WS_PORT=$(find_available_port $WS_PORT) || {
        echo -e "${RED}✗ Failed to find available WebSocket port${NC}" >&2
        return 1
    }
    
    # Ensure ports are different
    if [ "$HTTP_PORT" -eq "$WS_PORT" ]; then
        WS_PORT=$((WS_PORT + 1))
        if ! is_port_available $WS_PORT; then
            echo -e "${RED}✗ Failed to find distinct ports for HTTP and WebSocket${NC}" >&2
            return 1
        fi
        echo -e "${YELLOW}⚠ Adjusted WebSocket port to $WS_PORT to avoid conflict with HTTP port${NC}"
    fi
    
    # Check if ports are in privileged range (requires root)
    if [ "$HTTP_PORT" -lt 1024 ] || [ "$WS_PORT" -lt 1024 ]; then
        echo -e "${YELLOW}⚠ Warning: Running services on ports below 1024 may require root privileges${NC}"
    fi
    
    echo -e "\n${GREEN}✅ Ports configured successfully:${NC}"
    echo -e "  • HTTP Server:    ${BLUE}http://localhost:${HTTP_PORT}${NC}"
    echo -e "  • WebSocket:      ${BLUE}ws://localhost:${WS_PORT}${NC}\n"
    
    return 0
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

# Verify repository
verify_repository() {
    echo -e "${BLUE}Verifying repository...${NC}"
    
    if [ ! -d ".git" ]; then
        echo -e "${RED}Error: Not a git repository. Please run this script from the compendiumnav2 directory.${NC}" >&2
        return 1
    fi
    
    # Ensure we have the latest version
    echo -e "${BLUE}Updating repository...${NC}"
    git pull
    
    # Set default version if not specified
    COMPENDIUM_VERSION="${COMPENDIUM_VERSION:-latest}"
    
    # Checkout specific version if specified and not 'latest'
    if [ "$COMPENDIUM_VERSION" != "latest" ]; then
        echo -e "${BLUE}Checking out version $COMPENDIUM_VERSION...${NC}"
        git checkout "$COMPENDIUM_VERSION" 2>/dev/null || {
            echo -e "${RED}Failed to checkout version $COMPENDIUM_VERSION${NC}" >&2;
            return 1
        }
    fi
    
    echo -e "${GREEN}Repository verified${NC}"
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
    
    # VPS connection configuration
    set_env_var "VPS_HOST" "compendiumnav.com"
    set_env_var "VPS_PATH" "/relay"
    
    # WebSocket connection settings
    set_env_var "VPS_PING_INTERVAL" "25000"  # 25 seconds between pings
    set_env_var "VPS_CONNECTION_TIMEOUT" "30000"  # 30 second connection timeout
    
    # We're using key-based authentication which is more secure than token-based auth
    # Remove TOKEN_SECRET if it exists to force key-based authentication
    if grep -q "^TOKEN_SECRET=" "$env_file"; then
        sed -i "" "/^TOKEN_SECRET=/d" "$env_file"
        echo -e "${GREEN}Removed TOKEN_SECRET to enable secure key-based authentication${NC}"
    fi
    
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
    echo -e "${BLUE}Configuring LaunchAgent for auto-start...${NC}"
    
    local launch_agent_dir="$HOME/Library/LaunchAgents"
    local launch_agent_plist="$launch_agent_dir/com.compendiumnav.server.plist"
    local log_dir="$APP_DIR/logs"
    
    # Create necessary directories
    mkdir -p "$launch_agent_dir"
    mkdir -p "$log_dir"
    
    # Get the full path to node and the main server file
    local node_path=$(which node)
    if [ -z "$node_path" ]; then
        echo -e "${RED}Error: Node.js not found. Please install Node.js first.${NC}" >&2
        return 1
    fi
    
    local main_script="$APP_DIR/src/mainServer.js"
    
    # Verify main server file exists
    if [ ! -f "$main_script" ]; then
        echo -e "${RED}Error: Main server file not found at $main_script${NC}" >&2
        echo -e "${YELLOW}Checking for alternative locations...${NC}"
        
        # Try to find the main server file
        local found_file=$(find "$APP_DIR" -name "mainServer.js" -type f -print -quit)
        
        if [ -n "$found_file" ]; then
            echo -e "${GREEN}Found main server file at: $found_file${NC}"
            main_script="$found_file"
        else
            echo -e "${RED}Could not find main server file in $APP_DIR${NC}"
            echo -e "${YELLOW}Please ensure the application files are properly installed.${NC}"
            return 1
        fi
    fi
    
    # Create the plist file with improved configuration
    echo -e "${BLUE}Creating LaunchAgent plist at $launch_agent_plist${NC}"
    
    cat > "$launch_agent_plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.compendiumnav.server</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>$node_path</string>
        <string>$main_script</string>
    </array>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>$HTTP_PORT</string>
        <key>WS_PORT</key>
        <string>$WS_PORT</string>
        <key>HOSTNAME</key>
        <string>$HOSTNAME</string>
        <key>NODE_PATH</key>
        <string>$APP_DIR/node_modules</string>
    </dict>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>$log_dir/compendium.log</string>
    
    <key>StandardErrorPath</key>
    <string>$log_dir/compendium-error.log</string>
    
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    
    <key>ProcessType</key>
    <string>Interactive</string>
    
    <key>SessionCreate</key>
    <true/>
    
    <key>AbandonProcessGroup</key>
    <true/>
    
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF
    
    # Set correct permissions
    chmod 644 "$launch_agent_plist"
    
    # Create log rotation configuration
    local log_rotate_conf="/etc/newsyslog.d/com.compendiumnav.server.conf"
    if [ ! -f "$log_rotate_conf" ]; then
        echo -e "${BLUE}Configuring log rotation...${NC}"
        echo -e "$log_dir/compendium.log $APP_USER:staff 644 7 * @T00 J" | sudo tee "$log_rotate_conf" > /dev/null
        echo -e "$log_dir/compendium-error.log $APP_USER:staff 644 7 * @T00 J" | sudo tee -a "$log_rotate_conf" > /dev/null
    fi
    
    # Load the LaunchAgent
    echo -e "${BLUE}Loading LaunchAgent...${NC}"
    launchctl unload "$launch_agent_plist" 2>/dev/null || true
    
    if launchctl load -w "$launch_agent_plist"; then
        echo -e "${GREEN}LaunchAgent configured successfully${NC}"
        
        # Start the service
        echo -e "${YELLOW}Starting Compendium service...${NC}"
        if launchctl start com.compendiumnav.server; then
            echo -e "${GREEN}Compendium service started successfully${NC}"
            echo -e "${BLUE}Service status:${NC}"
            launchctl list | grep com.compendiumnav.server
            
            # Show initial logs
            echo -e "\n${BLUE}=== Initial Logs ===${NC}"
            echo -e "${YELLOW}Application logs: $log_dir/compendium.log${NC}"
            echo -e "${YELLOW}Error logs: $log_dir/compendium-error.log${NC}"
            
            # Show the last few lines of the log
            if [ -f "$log_dir/compendium.log" ]; then
                echo -e "\n${BLUE}=== Last 5 lines of application log ===${NC}"
                tail -n 5 "$log_dir/compendium.log"
            fi
        else
            echo -e "${RED}Failed to start Compendium service${NC}" >&2
            return 1
        fi
        
        return 0
    else
        echo -e "${RED}Failed to load LaunchAgent${NC}" >&2
        return 1
    fi
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
    echo -e "${BLUE}Starting installation...${NC}"
    
    # Verify we're in the right directory
    verify_repository || return 1
    
    # Check if running as root (not recommended on macOS)
    if [ "$(id -u)" -eq 0 ]; then
        echo -e "${YELLOW}Warning: Running as root is not recommended on macOS.${NC}"
        read -p "Do you want to continue as root? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${RED}Installation aborted by user.${NC}"
            exit 1
        fi
    fi
    
    # Install Homebrew if not installed
    if ! command -v brew &> /dev/null; then
        echo -e "${BLUE}Installing Homebrew...${NC}"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
            echo -e "${RED}Failed to install Homebrew${NC}" >&2
            exit 1
        }
        
        # Add Homebrew to PATH if not already there
        if [[ ":$PATH:" != *":/opt/homebrew/bin:"* ]]; then
            echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
            export PATH="/opt/homebrew/bin:$PATH"
        fi
    fi
    
    # Install system dependencies
    install_dependencies
    
    # Configure environment
    configure_environment
    
    # Install npm dependencies
    echo -e "${BLUE}Installing npm dependencies...${NC}"
    if ! npm install --no-optional; then
        echo -e "${YELLOW}Warning: Failed to install some dependencies. Trying with --force...${NC}" >&2
        npm install --no-optional --force || {
            echo -e "${RED}Error: Failed to install dependencies${NC}" >&2
            return 1
        }
    fi
    
    # Ensure dotenv is available
    if ! npm list dotenv >/dev/null 2>&1; then
        echo -e "${BLUE}Installing dotenv...${NC}"
        npm install dotenv
    fi
    
    # Setup LaunchAgent
    setup_launch_agent
    
    # Configure firewall
    configure_firewall
    
    echo -e "\n${GREEN}Installation completed successfully!${NC}"
    echo -e "${YELLOW}The Compendium Navigation Server should now be running.${NC}"
    echo -e "${YELLOW}Access it at: http://localhost:${HTTP_PORT}${NC}"
    echo -e "\n${YELLOW}To start the server manually, run:${NC}"
    echo -e "  launchctl start com.compendiumnav.server"
    echo -e "\n${YELLOW}To view logs:${NC}"
    echo -e "  tail -f $(pwd)/logs/compendium.log"
}

# Update function
update() {
    echo -e "${BLUE}Updating Compendium Navigation Server...${NC}"
    
    # Verify we're in the right directory
    verify_repository || return 1
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
    if ! npm install --no-optional; then
        echo -e "${YELLOW}Warning: Failed to update some dependencies. Trying with --force...${NC}" >&2
        npm install --no-optional --force || {
            echo -e "${RED}Error: Failed to update dependencies${NC}" >&2
            return 1
        }
    fi
    
    # Ensure dotenv is available
    if ! npm list dotenv >/dev/null 2>&1; then
        echo -e "${BLUE}Installing dotenv...${NC}"
        npm install dotenv
    fi
    
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
