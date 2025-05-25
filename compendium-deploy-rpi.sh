#!/bin/bash
# compendium-deploy-rpi.sh - Enhanced deployment script for Compendium Navigation Server with Raspberry Pi optimizations

set -Eeuo pipefail
IFS=$'\n\t'

# Global error handler
error_handler() {
    local exit_code=$?
    local line_number=$1
    local command_name=${2:-}
    
    echo -e "\n${RED}Error in ${command_name} at line ${line_number} with exit code ${exit_code}${NC}" >&2
    
    # Show the command that failed if available
    if [ -n "${command_name}" ]; then
        echo -e "${YELLOW}Failed command: ${command_name}${NC}" >&2
    fi
    
    # Show a stack trace
    echo -e "\n${YELLOW}Stack trace:${NC}" >&2
    local i=0
    while caller $i >/dev/null; do
        caller $i
        ((i++))
    done | sed 's/^/  /' >&2
    
    exit $exit_code
}

# Function to ensure required npm packages are installed
ensure_npm_packages() {
    local required_packages=("dotenv" "node-fetch@2")
    
    for pkg in "${required_packages[@]}"; do
        if ! npm list "$pkg" >/dev/null 2>&1; then
            echo -e "${BLUE}Installing $pkg...${NC}"
            if ! npm install "$pkg"; then
                echo -e "${YELLOW}Failed to install $pkg, trying with --force...${NC}"
                npm install --force "$pkg" || {
                    echo -e "${RED}Error: Failed to install $pkg${NC}" >&2
                    return 1
                }
            fi
        fi
    done
}

# Set the error handler
trap 'error_handler ${LINENO} "${BASH_COMMAND}"' ERR

# Function to handle errors explicitly
handle_error() {
    local exit_code=$?
    local line_number=$1
    local command_name=${2:-}
    local message=${3:-}
    
    if [ $exit_code -ne 0 ]; then
        echo -e "\n${RED}Error: ${message}${NC}" >&2
        error_handler $line_number "$command_name"
    fi
}

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'  # No Color

# Ensure bc is installed for floating-point comparisons
if ! command -v bc >/dev/null 2>&1; then
    echo -e "${YELLOW}Installing bc for floating-point calculations...${NC}"
    if ! run_with_sudo apt-get update || ! run_with_sudo apt-get install -y bc; then
        echo -e "${YELLOW}Warning: Failed to install bc. Some temperature checks may not work.${NC}"
    fi
fi

# Define USER_HOME if not set
: "${USER_HOME:=$HOME}"
if [ -z "$USER_HOME" ]; then
    USER_HOME=$(getent passwd "$USER" | cut -d: -f6)
    if [ -z "$USER_HOME" ]; then
        echo -e "${RED}Error: Could not determine user home directory${NC}" >&2
        exit 1
    fi
fi
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
CURRENT_USER=$(whoami)
APP_USER="${COMPENDIUM_USER:-$CURRENT_USER}"
SERVICE_NAME="compendium"

# Detect if running on Raspberry Pi
if [ -f /etc/rpi-issue ] || grep -q 'Raspberry Pi' /etc/os-release 2>/dev/null; then
    IS_RASPBERRY_PI=true
else
    IS_RASPBERRY_PI=false
fi  # For Avahi service

# User-specific directories
USER_HOME=$(eval echo ~"$APP_USER")
APP_DIR="${USER_HOME}/compendium"
BACKUP_DIR="${USER_HOME}/compendium-backups"
DATA_DIR="${USER_HOME}/compendium-data"
LOG_DIR="${USER_HOME}/compendium-logs"

# Application settings
NODE_VERSION="18"
GIT_REPO="https://github.com/base-zz/compendium2.git"
GIT_BRANCH="main"
TARGET_VERSION="${COMPENDIUM_VERSION:-latest}"

# Default ports
DEFAULT_HTTP_PORT=8080
DEFAULT_WS_PORT=3009
HTTP_PORT=$DEFAULT_HTTP_PORT
WS_PORT=$DEFAULT_WS_PORT

# Raspberry Pi specific configuration
DISABLE_BLUETOOTH="${DISABLE_BLUETOOTH:-false}"
PERFORMANCE_MODE="${PERFORMANCE_MODE:-false}"
CREATE_SWAP="${CREATE_SWAP:-auto}"  # auto, yes, no

# Check if running as root for operations that need it
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${YELLOW}Running as non-root user. Some operations may require sudo privileges.${NC}"
        return 1
    fi
    return 0
}

# Run a command with sudo if not root
run_with_sudo() {
    local cmd=("$@")
    local sudo_needed=0
    
    if [ "$(id -u)" -ne 0 ]; then
        sudo_needed=1
        if ! sudo -n true 2>/dev/null; then
            echo -e "${YELLOW}Root access required. Please enter your password if prompted.${NC}"
        fi
    fi
    
    if [ $sudo_needed -eq 1 ]; then
        sudo "${cmd[@]}" || handle_error $LINENO "sudo ${cmd[*]}" "Failed to execute command with sudo"
    else
        "${cmd[@]}" || handle_error $LINENO "${cmd[*]}" "Command failed"
    fi
}

# Check if running on a Raspberry Pi
check_raspberry_pi() {
    echo -e "${BLUE}Checking Raspberry Pi compatibility...${NC}"
    
    # Check if running on a Raspberry Pi
    if [ ! -f /proc/device-tree/model ] || ! grep -q "Raspberry Pi" /proc/device-tree/model; then
        echo -e "${YELLOW}Warning: This doesn't appear to be a Raspberry Pi. Proceeding anyway...${NC}"
        IS_RASPBERRY_PI=false
    else
        local model=$(cat /proc/device-tree/model)
        echo -e "${GREEN}Detected: $model${NC}"
        IS_RASPBERRY_PI=true
        
        # Check memory
        local mem_total=$(free -m | awk '/^Mem:/{print $2}')
        if [ "$mem_total" -lt 1024 ]; then
            echo -e "${YELLOW}Warning: Low memory detected ($mem_total MB). Performance may be affected.${NC}"
        fi
        
        # Check available disk space
        local disk_space=$(df -h / | awk 'NR==2 {print $4}')
        echo -e "${BLUE}Available disk space: $disk_space${NC}"
    fi
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if port is available
is_port_available() {
    local port=$1
    if ! command -v nc &> /dev/null; then
        return 0
    fi
    if nc -z 127.0.0.1 "$port" &>/dev/null; then
        return 1
    fi
    return 0
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

# Install system dependencies
install_dependencies() {
    echo -e "${BLUE}Installing system dependencies...${NC}"
    
    # Check if we can install packages
    if ! run_with_sudo true; then
        echo -e "${YELLOW}Root access required to install system dependencies${NC}"
        echo -e "${YELLOW}Please run the following command manually:${NC}"
        echo "sudo apt-get update && sudo apt-get install -y git curl wget build-essential python3 python3-pip libavahi-compat-libdnssd-dev libudev-dev libusb-1.0-0-dev avahi-daemon libnss-mdns avahi-utils"
        return 1
    fi
    
    # Update package lists
    if ! run_with_sudo apt-get update; then
        echo -e "${RED}Failed to update package lists${NC}" >&2
        return 1
    fi
    
    # Install required packages
    local packages=(
        git curl wget
        build-essential
        python3
        python3-pip
        libavahi-compat-libdnssd-dev
        libudev-dev
        libusb-1.0-0-dev
        avahi-daemon    # For mDNS support
        libnss-mdns     # For .local resolution
        avahi-utils     # For avahi-publish
    )
    
    if ! run_with_sudo apt-get install -y "${packages[@]}"; then
        echo -e "${RED}Failed to install required packages${NC}" >&2
        return 1
    fi
    
    # Install Node.js if needed
    if ! command -v node &> /dev/null; then
        echo -e "${BLUE}Installing Node.js...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | run_with_sudo bash -
        if ! run_with_sudo apt-get install -y nodejs; then
            echo -e "${RED}Failed to install Node.js${NC}" >&2
            return 1
        fi
    fi
    
    # Install PM2
    if ! command -v pm2 &> /dev/null; then
        echo -e "${BLUE}Installing PM2...${NC}"
        if ! npm install -g pm2; then
            echo -e "${RED}Failed to install PM2${NC}" >&2
            return 1
        fi
    fi
    
    echo -e "${GREEN}Dependencies installed successfully${NC}"
    return 0
}

# Verify repository
verify_repository() {
    echo -e "${BLUE}Verifying repository...${NC}"
    
    local repo_dir=$(pwd)
    
    # Try to find .git directory in current or parent directories
    while [ "$repo_dir" != "/" ]; do
        if [ -d "$repo_dir/.git" ]; then
            echo -e "${GREEN}Found git repository at: $repo_dir${NC}"
            cd "$repo_dir" || { echo -e "${RED}Failed to change to repository directory${NC}" >&2; return 1; }
            break
        fi
        repo_dir=$(dirname "$repo_dir")
    done
    
    if [ "$repo_dir" = "/" ]; then
        echo -e "${RED}Error: Not a git repository. Please run this script from within the compendiumnav2 directory.${NC}" >&2
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

# Configure environment variables with mDNS settings
configure_environment() {
    echo -e "${BLUE}Configuring environment...${NC}"
    
    # Create .env file if it doesn't exist
    local env_file=".env"
    if [ ! -f "$env_file" ]; then
        touch "$env_file"
    fi
    
    # Get the local IP address
    local ip_address
    if command -v hostname &> /dev/null; then
        ip_address=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "127.0.0.1")
    else
        ip_address="127.0.0.1"
    fi
    
    # Set environment variables
    set_env_var "PORT" "$HTTP_PORT"
    set_env_var "VPS_WS_PORT" "$WS_PORT"
    set_env_var "NODE_ENV" "production"
    set_env_var "FRONTEND_URL" "http://${ip_address}:${HTTP_PORT}"
    
    # VPS connection configuration
    set_env_var "VPS_HOST" "compendiumnav.com"
    set_env_var "VPS_PATH" "/relay"
    # Force WSS (secure WebSockets) for production
    set_env_var "VPS_WS_PORT" "443"  # SSL port for secure WebSockets
    
    # WebSocket connection settings
    set_env_var "VPS_PING_INTERVAL" "25000"  # 25 seconds between pings
    set_env_var "VPS_CONNECTION_TIMEOUT" "30000"  # 30 second connection timeout
    
    # We're using key-based authentication which is more secure than token-based auth
    # Remove TOKEN_SECRET if it exists to force key-based authentication
    if grep -q "^TOKEN_SECRET=" "$env_file"; then
        sed -i "/^TOKEN_SECRET=/d" "$env_file"
        echo -e "${GREEN}Removed TOKEN_SECRET to enable secure key-based authentication${NC}"
    fi
    
    # mDNS configuration
    set_env_var "MDNS_ENABLED" "true"
    set_env_var "MDNS_NAME" "$(hostname 2>/dev/null || echo "compendium")"
    set_env_var "MDNS_DOMAIN" "local"
    set_env_var "MDNS_SERVICE" "_compendium._tcp"
    
    # Log level
    set_env_var "LOG_LEVEL" "info"
    
    # Data directory - use a directory in the current user's home if not root
    local data_dir
    if [ "$(id -u)" -eq 0 ]; then
        data_dir="/home/$APP_USER/compendium-data"
    else
        data_dir="${HOME}/compendium-data"
    fi
    
    mkdir -p "$data_dir"
    set_env_var "DATA_DIR" "$data_dir"
    
    # Raspberry Pi specific settings
    if [ "$IS_RASPBERRY_PI" = true ]; then
        # Memory limit for Node.js
        local mem_total=1024  # Default to 1GB if we can't detect
        if command -v free &> /dev/null; then
            mem_total=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo "1024")
        fi
        
        local max_memory="512M"
        if [ "$mem_total" -lt 1024 ]; then
            max_memory="256M"
        fi
        set_env_var "NODE_OPTIONS" "--max-old-space-size=${max_memory%M}"
    fi
    
    echo -e "${GREEN}Environment configured${NC}"
    echo -e "${YELLOW}Data directory: ${data_dir}${NC}"
    return 0
}

# Configure memory management for Raspberry Pi
configure_memory_management() {
    if [ "$IS_RASPBERRY_PI" != true ]; then
        echo -e "${BLUE}Skipping memory management (not a Raspberry Pi)${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Configuring memory management for Raspberry Pi...${NC}"
    
    # Get memory info in MB
    local mem_kb
    mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    local mem_mb=$((mem_kb / 1024))
    
    # Calculate swap size (1.5x RAM for < 2GB, 1x for 2-4GB, 0.5x for >4GB, max 4GB)
    local swap_size_mb=0
    if [ $mem_mb -lt 2000 ]; then
        swap_size_mb=$((mem_mb * 3 / 2))  # 1.5x RAM
    elif [ $mem_mb -lt 4000 ]; then
        swap_size_mb=$mem_mb  # 1x RAM
    else
        swap_size_mb=$((mem_mb / 2))  # 0.5x RAM
    fi
    
    # Ensure swap is at least 1GB and not more than 4GB
    swap_size_mb=$((swap_size_mb < 1024 ? 1024 : swap_size_mb > 4096 ? 4096 : swap_size_mb))
    
    if [ "$CREATE_SWAP" = "yes" ] || ([ "$CREATE_SWAP" = "auto" ] && [ $mem_mb -lt 2048 ]); then
        local swapfile="/swapfile"
        local swapfile_in_home="${USER_HOME}/.swapfile"
        
        # Function to check if swap is active
        is_swap_active() {
            swapon --show 2>/dev/null | grep -q -e "$1"
        }
        
        # Check if swap is already configured
        if is_swap_active "$swapfile" || is_swap_active "$swapfile_in_home"; then
            echo -e "${GREEN}✓ Swap is already configured and active${NC}"
            return 0
        fi
        
        echo -e "${YELLOW}Configuring ${swap_size_mb}MB swap file...${NC}"
        
        # Function to create and enable swap
        create_swap() {
            local target_file="$1"
            local use_sudo=${2:-false}
            local cmd_prefix=""
            local shell_rcs=("${USER_HOME}/.bashrc" "${USER_HOME}/.zshrc")
            
            [ "$use_sudo" = true ] && cmd_prefix="sudo "
            
            # Check available disk space (need swap_size_mb + 100MB free)
            local available_mb
            available_mb=$(df -m --output=avail "$(dirname "$target_file")" | tail -1)
            if [ $available_mb -lt $((swap_size_mb + 100)) ]; then
                echo -e "${YELLOW}✗ Insufficient disk space for swap file (needed: $((swap_size_mb + 100))MB, available: ${available_mb}MB)${NC}" >&2
                return 1
            fi
            
            echo -e "${BLUE}Creating swap file at ${target_file}...${NC}"
            
            # Create parent directory if needed
            if ! mkdir -p "$(dirname "$target_file")" 2>/dev/null; then
                if [ "$use_sudo" = true ]; then
                    sudo mkdir -p "$(dirname "$target_file")" || return 1
                else
                    return 1
                fi
            fi
            
            # Create swap file (use fallocate if available, fall back to dd)
            if ! (command -v fallocate >/dev/null 2>&1 && 
                  $cmd_prefix fallocate -l ${swap_size_mb}M "$target_file" 2>/dev/null) && \
               ! $cmd_prefix dd if=/dev/zero of="$target_file" bs=1M count=$swap_size_mb status=none 2>/dev/null; then
                echo -e "${YELLOW}✗ Failed to create swap file${NC}" >&2
                return 1
            fi
            
            # Set permissions and initialize swap
            if ! $cmd_prefix chmod 600 "$target_file" 2>/dev/null || \
               ! $cmd_prefix mkswap "$target_file" >/dev/null 2>&1 || \
               ! $cmd_prefix swapon "$target_file" 2>/dev/null; then
                echo -e "${YELLOW}✗ Failed to enable swap${NC}" >&2
                $cmd_prefix swapoff "$target_file" 2>/dev/null || true
                $cmd_prefix rm -f "$target_file" 2>/dev/null || true
                return 1
            fi
            
            # Make swap permanent in fstab if system swap
            if [ "$use_sudo" = true ] && ! grep -q "^$target_file" /etc/fstab 2>/dev/null; then
                echo "$target_file swap swap defaults,pri=10 0 0" | $cmd_prefix tee -a /etc/fstab >/dev/null
            fi
            
            # Add to shell rc files if user swap
            if [ "$use_sudo" = false ]; then
                for rc_file in "${shell_rcs[@]}"; do
                    if [ -f "$rc_file" ] && ! grep -q "$target_file" "$rc_file"; then
                        echo -e "\n# Enable swap on login" | tee -a "$rc_file" >/dev/null
                        echo "if [ -f \"$target_file\" ] && ! swapon --show | grep -q \"$target_file\"; then" | tee -a "$rc_file" >/dev/null
                        echo "    swapon \"$target_file\" 2>/dev/null || true" | tee -a "$rc_file" >/dev/null
                        echo "fi" | tee -a "$rc_file" >/dev/null
                    fi
                done
            fi
            
            # Optimize swappiness
            if [ -w /proc/sys/vm/swappiness ]; then
                echo 10 | $cmd_prefix tee /proc/sys/vm/swappiness >/dev/null 2>&1 || true
            fi
            
            # Make swappiness setting persistent
            if [ "$use_sudo" = true ] && ! grep -q "^vm.swappiness" /etc/sysctl.conf 2>/dev/null; then
                echo "vm.swappiness=10" | $cmd_prefix tee -a /etc/sysctl.conf >/dev/null
            fi
            
            return 0
        }
        
        # Try home directory first (no root required)
        if [ -w "$(dirname "$swapfile_in_home")" ] || [ -w "$USER_HOME" ]; then
            if create_swap "$swapfile_in_home" false; then
                echo -e "${GREEN}✓ Swap file created in user home directory${NC}"
                return 0
            fi
        fi
        
        # Try system directory with sudo
        if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
            echo -e "${YELLOW}Attempting to create system swap file...${NC}"
            if create_swap "$swapfile" true; then
                echo -e "${GREEN}✓ System swap file created and enabled${NC}"
                return 0
            fi
        fi
        
        # If we get here, we couldn't create swap
        echo -e "${YELLOW}⚠ Warning: Could not create swap file. You may experience performance issues.${NC}"
        echo -e "${YELLOW}  You can try running the script with sudo or manually create a swap file:${NC}"
        echo -e "  sudo dd if=/dev/zero of=/swapfile bs=1M count=${swap_size_mb}"
        echo -e "  sudo chmod 600 /swapfile"
        echo -e "  sudo mkswap /swapfile"
        echo -e "  sudo swapon /swapfile"
        echo -e "  echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab"
        return 1
    else
        echo -e "${GREEN}✓ Memory management: No swap configuration needed (sufficient memory: ${mem_mb}MB)${NC}"
    fi
}

# Helper function to set or update an environment variable
set_env_var() {
    local key=$1
    local value=$2
    local env_file=".env"
    
    # Remove existing entry if present
    if grep -q "^$key=" "$env_file"; then
        sed -i "/^$key=/d" "$env_file"
    fi
    
    # Add new entry
    echo "$key=$value" >> "$env_file"
}

# Configure Avahi (mDNS) service
export HOSTNAME DOMAIN SERVICE_NAME

configure_avahi() {
    echo -e "${BLUE}Configuring Avahi mDNS service...${NC}"
    
    # Ensure Avahi is installed
    if ! command_exists avahi-daemon; then
        echo -e "${RED}Avahi daemon not found, mDNS will not work${NC}" >&2
        return 1
    fi
    
    # Create Avahi service file
    local service_file="/etc/avahi/services/compendium.service"
    cat > "$service_file" << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>Compendium Navigation Server</name>
  <service>
    <type>$SERVICE_NAME</type>
    <port>$HTTP_PORT</port>
    <txt-record>version=1.0</txt-record>
    <txt-record>path=/</txt-record>
  </service>
  <service>
    <type>_http._tcp</type>
    <port>$HTTP_PORT</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
EOF
    
    # Restart Avahi
    systemctl restart avahi-daemon
    
    # Test mDNS resolution
    echo -e "${BLUE}Testing mDNS resolution...${NC}"
    if command_exists avahi-resolve; then
        if avahi-resolve --name "$(hostname).local" &>/dev/null; then
            echo -e "${GREEN}mDNS resolution working: $(hostname).local${NC}"
        else
            echo -e "${YELLOW}mDNS resolution not working yet. This may take a moment to propagate.${NC}"
        fi
    fi
    
    echo -e "${GREEN}Avahi mDNS service configured${NC}"
    return 0
}

# Setup user systemd service
setup_systemd_service() {
    echo -e "${BLUE}Setting up user systemd service...${NC}"
    
    # Create user systemd directory if it doesn't exist
    USER_SYSTEMD_DIR="${USER_HOME}/.config/systemd/user"
    mkdir -p "${USER_SYSTEMD_DIR}"
    
    # Enable lingering for the user to allow user services to run at boot
    if ! loginctl show-user "$USER" | grep -q Linger=yes; then
        echo -e "${YELLOW}Enabling user service persistence across logins...${NC}"
        if command -v loginctl >/dev/null; then
            if ! loginctl enable-linger "$USER"; then
                echo -e "${YELLOW}Failed to enable user lingering. Services may not start at boot.${NC}"
            fi
        fi
    fi
    
    # Use localhost for user service
    echo -e "${BLUE}Using localhost for user service...${NC}"
    
    # Verify main server file exists
    local main_server_file="src/mainServer.js"
    if [ ! -f "$main_server_file" ]; then
        echo -e "${RED}Error: Main server file not found at $main_server_file${NC}" >&2
        echo -e "${YELLOW}Checking for alternative locations...${NC}"
        
        # Try to find the main server file
        local found_file=$(find . -name "mainServer.js" -type f -print -quit)
        
        if [ -n "$found_file" ]; then
            echo -e "${GREEN}Found main server file at: $found_file${NC}"
            main_server_file="$found_file"
        else
            echo -e "${RED}Could not find main server file in $APP_DIR${NC}"
            echo -e "${YELLOW}Please ensure the application files are properly installed.${NC}"
            return 1
        fi
    fi
    
    # Create user systemd service file
    local service_file="${USER_SYSTEMD_DIR}/compendium.service"
    
    echo -e "${BLUE}Creating user service file at ${service_file}...${NC}"
    
    # Create necessary directories
    mkdir -p "${DATA_DIR}" "${LOG_DIR}" "${BACKUP_DIR}"
    chmod 755 "${DATA_DIR}" "${LOG_DIR}" "${BACKUP_DIR}"
    
    cat > "$service_file" << EOF
[Unit]
Description=Compendium Navigation Server
After=network.target avahi-daemon.service

[Service]
Type=simple
User=%i
WorkingDirectory=%h/compendium
ExecStart=/usr/bin/node $main_server_file
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=compendium
Environment=NODE_ENV=production
Environment=PORT=$HTTP_PORT
Environment=WS_PORT=$WS_PORT

# mDNS service registration
ExecStartPost=/bin/sh -c 'avahi-publish -s $(hostname) _compendium._tcp $HTTP_PORT "Path=/" & echo \$! > /tmp/compendium-mdns.pid'
ExecStopPost=/bin/sh -c 'kill -9 \$(cat /tmp/compendium-mdns.pid) 2>/dev/null || true; rm -f /tmp/compendium-mdns.pid'

[Install]
WantedBy=multi-user.target
EOF
    
    # Enable and start the user service
    echo -e "${BLUE}Enabling and starting user service...${NC}"
    
    # Reload user systemd
    systemctl --user daemon-reload || {
        echo -e "${YELLOW}Failed to reload user systemd, trying with systemd-run...${NC}"
        systemd-run --user --scope -- daemon-reload || true
    }
    
    # Enable the service
    if ! systemctl --user enable --now compendium.service; then
        echo -e "${YELLOW}Failed to enable user service, but continuing anyway...${NC}"
    fi
    
    # Start the service
    if systemctl --user start compendium.service; then
        echo -e "${GREEN}Compendium user service started successfully${NC}"
        echo -e "${BLUE}Service status:${NC}"
        systemctl --user status compendium.service --no-pager || true
    else
        echo -e "${YELLOW}Failed to start user service, but continuing anyway...${NC}"
        journalctl --user -u compendium -n 20 --no-pager || true
    fi
    
    echo -e "\n${YELLOW}To manage the service, use:${NC}"
    echo "  systemctl --user status compendium.service"
    echo "  systemctl --user restart compendium.service"
    echo -e "\n${YELLOW}To view logs:${NC}"
    echo "  journalctl --user -u compendium -f"
    
    return 0
}

# Tune performance for Raspberry Pi
tune_performance() {
    if [ "$IS_RASPBERRY_PI" != true ]; then
        echo -e "${BLUE}Skipping performance tuning (not a Raspberry Pi)${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Tuning system performance for Raspberry Pi...${NC}"
    
    # Disable unnecessary services if requested
    if [ "$DISABLE_BLUETOOTH" = "true" ]; then
        local services_to_disable=(
            "bluetooth.service"
            "triggerhappy.service"
            "apt-daily.service"
            "apt-daily-upgrade.service"
        )
        
        for service in "${services_to_disable[@]}"; do
            if systemctl is-active --quiet "$service"; then
                systemctl stop "$service"
                systemctl disable "$service"
                echo -e "${GREEN}Disabled $service${NC}"
            fi
        done
    fi
    
    # Set CPU governor to performance if requested
    if [ "$PERFORMANCE_MODE" = "true" ]; then
        if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
            echo "performance" | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
            echo -e "${GREEN}Set CPU governor to performance mode${NC}"
        fi
    fi
    
    echo -e "${GREEN}Performance tuning completed${NC}"
}

# Inform about required firewall ports
configure_firewall() {
    echo -e "${BLUE}Checking firewall configuration...${NC}"
    
    # Check if we can access firewall commands
    local can_configure_firewall=0
    
    if [ "$(id -u)" -eq 0 ]; then
        can_configure_firewall=1
    elif command -v sudo >/dev/null 2>&1; then
        if sudo -n true 2>/dev/null; then
            can_configure_firewall=1
        fi
    fi
    
    if [ "$can_configure_firewall" -eq 1 ]; then
        # Check if ufw is available
        if command -v ufw >/dev/null 2>&1; then
            echo -e "${BLUE}Configuring ufw firewall...${NC}"
            if run_with_sudo ufw allow "$HTTP_PORT/tcp" 2>/dev/null; then
                echo -e "${GREEN}Firewall configured to allow port $HTTP_PORT (HTTP)${NC}"
            fi
            if run_with_sudo ufw allow "$WS_PORT/tcp" 2>/dev/null; then
                echo -e "${GREEN}Firewall configured to allow port $WS_PORT (WebSocket)${NC}"
            fi
        # Check if firewalld is available
        elif command -v firewall-cmd >/dev/null 2>&1; then
            echo -e "${BLUE}Configuring firewalld...${NC}"
            if run_with_sudo firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" 2>/dev/null; then
                run_with_sudo firewall-cmd --reload
                echo -e "${GREEN}Firewall configured to allow port $HTTP_PORT (HTTP)${NC}"
            fi
            if run_with_sudo firewall-cmd --permanent --add-port="$WS_PORT/tcp" 2>/dev/null; then
                run_with_sudo firewall-cmd --reload
                echo -e "${GREEN}Firewall configured to allow port $WS_PORT (WebSocket)${NC}"
            fi
        fi
    fi
    
    # Always show the required ports message
    echo -e "\n${YELLOW}IMPORTANT: Ensure the following ports are open in your firewall:${NC}"
    echo -e "- Port $HTTP_PORT/tcp (HTTP)"
    echo -e "- Port $WS_PORT/tcp (WebSocket)"
    echo -e "\n${YELLOW}If you're behind a router, you may need to configure port forwarding.${NC}"
}

# Monitor Raspberry Pi temperature
monitor_temperature() {
    if [ "$IS_RASPBERRY_PI" != true ]; then
        return 0
    fi
    
    if [ -f /opt/vc/bin/vcgencmd ] || [ -f /usr/bin/vcgencmd ]; then
        local vcgencmd_path="/opt/vc/bin/vcgencmd"
        if [ ! -f "$vcgencmd_path" ]; then
            vcgencmd_path="/usr/bin/vcgencmd"
        fi
        
        local temp=$($vcgencmd_path measure_temp | cut -d= -f2 | cut -d\' -f1)
        echo -e "${BLUE}Current CPU temperature: ${temp}°C${NC}"
        
        if (( $(echo "$temp > 75" | bc -l) )); then
            echo -e "${RED}Warning: CPU temperature is high. Consider adding cooling.${NC}"
        elif (( $(echo "$temp > 65" | bc -l) )); then
            echo -e "${YELLOW}Note: CPU temperature is elevated.${NC}"
        fi
    fi
}

# Health check function - performs various system and application checks
health_check() {
    local has_errors=0
    local has_warnings=0
    
    echo -e "${BLUE}Performing health check...${NC}"
    
    # 1. Check if service is running
    echo -e "\n${BLUE}1. Checking service status...${NC}"
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${GREEN}✓ Service is running${NC}"
    else
        echo -e "${RED}✗ Service is not running${NC}" >&2
        has_errors=1
    fi
    
    # 2. Check service logs for errors
    echo -e "\n${BLUE}2. Checking service logs for errors...${NC}"
    local log_errors
    log_errors=$(journalctl --user -u compendium --no-pager -n 20 2>&1 | grep -i -e error -e fail -e exception || true)
    
    if [ -z "$log_errors" ]; then
        echo -e "${GREEN}✓ No recent errors found in logs${NC}"
    else
        echo -e "${YELLOW}⚠ Found potential issues in logs:${NC}"
        echo "$log_errors" | head -n 5 | sed 's/^/  /'
        if [ $(echo "$log_errors" | wc -l) -gt 5 ]; then
            echo "  ... and more (see full logs with: journalctl --user -u compendium -n 50)"
        fi
        has_warnings=1
    fi
    
    # 3. Check disk space
    echo -e "\n${BLUE}3. Checking disk space...${NC}"
    df -h . | grep -v "^Filesystem" | while read -r line; do
        local usage_percent=$(echo "$line" | awk '{print $5}' | tr -d '%')
        local mount_point=$(echo "$line" | awk '{print $NF}')
        
        if [ "$usage_percent" -gt 90 ]; then
            echo -e "${RED}✗ Low disk space on $mount_point ($usage_percent% used)${NC}" >&2
            has_errors=1
        elif [ "$usage_percent" -gt 75 ]; then
            echo -e "${YELLOW}⚠ Moderate disk usage on $mount_point ($usage_percent% used)${NC}"
            has_warnings=1
        else
            echo -e "${GREEN}✓ Good disk space on $mount_point ($usage_percent% used)${NC}"
        fi
    done
    
    # 4. Check memory usage
    echo -e "\n${BLUE}4. Checking memory usage...${NC}"
    free -h | grep -v "^Swap"
    
    # 5. Check if ports are accessible
    echo -e "\n${BLUE}5. Checking service accessibility...${NC}"
    if command -v curl >/dev/null; then
        if curl -s -o /dev/null --connect-timeout 3 "http://localhost:${HTTP_PORT}"; then
            echo -e "${GREEN}✓ Service is responding on port $HTTP_PORT${NC}"
        else
            echo -e "${YELLOW}⚠ Could not connect to service on port $HTTP_PORT${NC}"
            has_warnings=1
        fi
    else
        echo -e "${YELLOW}⚠ curl not available, skipping port check${NC}"
    fi
    
    # 6. Check for system updates
    if [ -f "/etc/os-release" ] && grep -q "Raspbian\|Debian" /etc/os-release; then
        echo -e "\n${BLUE}6. Checking for system updates...${NC}"
        if command -v apt-get >/dev/null; then
            if [ "$(id -u)" -eq 0 ]; then
                apt-get update >/dev/null 2>&1
                updates=$(apt-get -s upgrade | grep -c '^Inst' || true)
                if [ "$updates" -gt 0 ]; then
                    echo -e "${YELLOW}⚠ $updates system updates available${NC}"
                    has_warnings=1
                else
                    echo -e "${GREEN}✓ System is up to date${NC}"
                fi
            else
                echo -e "${YELLOW}⚠ Run as root to check for system updates${NC}"
            fi
        fi
    fi
    
    # 7. Check Raspberry Pi specific conditions
    if [ "$IS_RASPBERRY_PI" = true ]; then
        echo -e "\n${BLUE}7. Raspberry Pi specific checks...${NC}"
        
        # Check temperature
        if [ -f "/sys/class/thermal/thermal_zone0/temp" ]; then
            local temp
            temp=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "unknown")
            if [ "$temp" != "unknown" ]; then
                if (( $(echo "$temp > 70" | bc -l) )); then
                    echo -e "${RED}✗ High CPU temperature: ${temp}°C${NC}" >&2
                    has_errors=1
                elif (( $(echo "$temp > 60" | bc -l) )); then
                    echo -e "${YELLOW}⚠ Elevated CPU temperature: ${temp}°C${NC}"
                    has_warnings=1
                else
                    echo -e "${GREEN}✓ Normal CPU temperature: ${temp}°C${NC}"
                fi
            fi
        fi
        
        # Check power supply
        if [ -f "/sys/class/power_supply/"*"type" ]; then
            local power_source
            power_source=$(grep -l "Mains" /sys/class/power_supply/*/type 2>/dev/null | xargs dirname | xargs basename || true)
            if [ -n "$power_source" ]; then
                if [ -f "/sys/class/power_supply/$power_source/online" ] && 
                   [ "$(cat "/sys/class/power_supply/$power_source/online" 2>/dev/null)" = "1" ]; then
                    echo -e "${GREEN}✓ Running on mains power${NC}"
                else
                    echo -e "${YELLOW}⚠ Running on battery power${NC}"
                    has_warnings=1
                fi
            fi
        fi
    fi
    
    # Summary
    echo -e "\n${BLUE}=== Health Check Summary ===${NC}"
    if [ "$has_errors" -gt 0 ]; then
        echo -e "${RED}✗ Health check completed with errors${NC}" >&2
        return 1
    elif [ "$has_warnings" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Health check completed with warnings${NC}"
        return 0
    else
        echo -e "${GREEN}✓ Health check completed successfully${NC}"
        return 0
    fi
}

# Install function
install() {
    echo -e "${BLUE}Starting Compendium Navigation Server installation...${NC}"
    echo -e "${YELLOW}This installation will run without root access where possible.${NC}"
    
    # Create necessary directories with proper permissions
    echo -e "${BLUE}Setting up directories...${NC}"
    for dir in "$APP_DIR" "$BACKUP_DIR" "$DATA_DIR" "$LOG_DIR"; do
        if ! mkdir -p "$dir" 2>/dev/null; then
            echo -e "${YELLOW}Failed to create directory $dir, trying with sudo...${NC}"
            if ! run_with_sudo mkdir -p "$dir"; then
                echo -e "${RED}Error: Failed to create directory: $dir${NC}" >&2
                return 1
            fi
        fi
        if ! chmod 755 "$dir" 2>/dev/null; then
            echo -e "${YELLOW}Warning: Failed to set permissions on $dir${NC}" >&2
        fi
    done
    
    # Check for existing installation
    if [ -d "$APP_DIR" ] && [ "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
        echo -e "${YELLOW}Existing installation found at $APP_DIR${NC}"
        read -p "Do you want to update the existing installation? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            update
            return $?
        else
            echo -e "${YELLOW}Please remove the existing installation or choose a different directory.${NC}"
            exit 1
        fi
    fi
    
    # Clone repository
    echo -e "${BLUE}Cloning repository from $GIT_REPO (branch: $GIT_BRANCH)...${NC}"
    if ! git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"; then
        echo -e "${RED}Failed to clone repository${NC}" >&2
        echo -e "${YELLOW}Please check your internet connection and repository URL.${NC}" >&2
        return 1
    fi
    
    # Change to application directory
    cd "$APP_DIR" || {
        echo -e "${RED}Failed to change to application directory: $APP_DIR${NC}" >&2
        return 1
    }
    
    # Initialize the repository properly
    if ! setup_repository; then
        echo -e "${RED}Failed to initialize repository${NC}" >&2
        return 1
    fi
    
    # Install system dependencies
    echo -e "${BLUE}Installing system dependencies...${NC}"
    if ! install_dependencies; then
        echo -e "${YELLOW}Warning: Some dependencies might not have been installed. Continuing anyway...${NC}" >&2
    fi
    
    # Install dependencies
    echo -e "${BLUE}Installing npm dependencies...${NC}"
    # First install production deps
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
    
    # Setup user systemd service
    if ! setup_systemd_service; then
        echo -e "${YELLOW}Warning: There were issues setting up the systemd service.${NC}" >&2
    fi
    
    # Configure firewall (just informs user about required ports)
    configure_firewall
    
    # Get network info
    local ip_address
    ip_address=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    local hostname
    hostname=$(hostname 2>/dev/null || echo "localhost")
    
    # Run health check
    echo -e "\n${BLUE}Running health check...${NC}"
    if ! health_check; then
        echo -e "${YELLOW}Health check completed with warnings.${NC}" >&2
    fi
    
    echo -e "\n${GREEN}Installation completed successfully!${NC}"
    echo -e "${YELLOW}The Compendium Navigation Server should now be running.${NC}"
    echo -e "\n${YELLOW}Access it at:${NC}"
    echo -e "- http://localhost:${HTTP_PORT} (on this machine)"
    echo -e "- http://${ip_address}:${HTTP_PORT} (on your local network)"
    echo -e "- http://${hostname}.local:${HTTP_PORT} (via mDNS if available)"
    
    echo -e "\n${YELLOW}To manage the service:${NC}"
    echo -e "  systemctl --user status compendium.service"
    echo -e "  systemctl --user restart compendium.service"
    echo -e "\n${YELLOW}To view logs:${NC}"
    echo -e "  journalctl --user -u compendium -f"
    
    return 0
}

# Setup repository for updates
setup_repository() {
    echo -e "${BLUE}Setting up repository for updates...${NC}"
    
    # Ensure we're in the correct directory
    if [ ! -d "$APP_DIR" ]; then
        echo -e "${RED}Error: Application directory not found at $APP_DIR${NC}" >&2
        return 1
    fi
    
    cd "$APP_DIR" || {
        echo -e "${RED}Failed to change to application directory: $APP_DIR${NC}" >&2
        return 1
    }
    
    # Check if this is a git repository
    if [ ! -d ".git" ]; then
        echo -e "${YELLOW}Not a git repository. Initializing...${NC}"
        git init || {
            echo -e "${RED}Failed to initialize git repository${NC}" >&2
            return 1
        }
        git remote add origin "$GIT_REPO" || {
            echo -e "${RED}Failed to add git remote${NC}" >&2
            return 1
        }
    fi
    
    # Fetch the latest changes
    echo -e "${BLUE}Fetching latest changes...${NC}"
    git fetch --all || {
        echo -e "${YELLOW}Warning: Failed to fetch from remote repository${NC}" >&2
        return 1
    }
    
    # Reset to the specified branch
    echo -e "${BLUE}Updating to branch: $GIT_BRANCH${NC}"
    git reset --hard "origin/$GIT_BRANCH" || {
        echo -e "${YELLOW}Warning: Failed to reset to branch $GIT_BRANCH${NC}" >&2
        return 1
    }
    
    # Clean up any untracked files
    git clean -fd || {
        echo -e "${YELLOW}Warning: Failed to clean repository${NC}" >&2
        return 1
    }
    
    echo -e "${GREEN}Repository updated successfully${NC}"
    return 0
}

# Update function
update() {
    echo -e "${BLUE}Updating Compendium Navigation Server...${NC}"
    
    # Ensure we have a valid application directory
    if [ ! -d "$APP_DIR" ]; then
        echo -e "${RED}Error: Application directory not found at $APP_DIR${NC}" >&2
        echo -e "${YELLOW}Please run the install command first.${NC}"
        return 1
    fi
    
    # Stop service if running
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${BLUE}Stopping compendium service...${NC}"
        if ! systemctl --user stop compendium.service; then
            echo -e "${YELLOW}Warning: Failed to stop compendium service${NC}" >&2
            # Continue anyway, as we might still be able to update
        fi
    fi
    
    # Backup existing installation
    if ! backup_existing; then
        echo -e "${YELLOW}Warning: Backup failed, but continuing with update...${NC}" >&2
    fi
    
    # Change to application directory
    cd "$APP_DIR" || {
        echo -e "${RED}Failed to change to application directory: $APP_DIR${NC}" >&2
        return 1
    }
    
    # Update repository
    if ! setup_repository; then
        echo -e "${YELLOW}Warning: Repository update failed, but continuing with existing files...${NC}" >&2
    fi
    
    # Update dependencies
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
    
    # Set main server file path
    local main_server_file="src/mainServer.js"
    if [ ! -f "$main_server_file" ]; then
        main_server_file=$(find . -name "mainServer.js" -type f -print -quit)
        if [ -z "$main_server_file" ]; then
            echo -e "${RED}Error: Could not find main server file${NC}" >&2
            return 1
        fi
    fi
    
    # Ensure systemd user directory exists
    local user_systemd_dir="${USER_HOME}/.config/systemd/user"
    mkdir -p "$user_systemd_dir"
    
    # Create or update systemd service file
    local service_file="${user_systemd_dir}/compendium.service"
    echo -e "${BLUE}Setting up systemd service...${NC}"
    
    cat > "$service_file" << EOF
[Unit]
Description=Compendium Navigation Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $main_server_file
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=compendium
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

    # Set proper permissions
    chmod 644 "$service_file"
    systemctl --user daemon-reload
    systemctl --user enable compendium.service
    
    # Start service
    echo -e "${BLUE}Starting compendium service...${NC}"
    if ! systemctl --user start compendium.service; then
        echo -e "${YELLOW}Warning: Failed to start the service automatically.${NC}" >&2
        echo -e "${YELLOW}You can try starting it manually with: systemctl --user start compendium.service${NC}" >&2
    fi
    
    # Show service status
    echo -e "\n${BLUE}Service status:${NC}"
    systemctl --user status compendium.service --no-pager || true
    
    # Get network info
    local ip_address
    ip_address=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    local hostname
    hostname=$(hostname 2>/dev/null || echo "localhost")
    
    echo -e "\n${GREEN}Update completed!${NC}"
    echo -e "${YELLOW}The Compendium Navigation Server has been updated.${NC}"
    echo -e "\n${YELLOW}Access it at:${NC}"
    echo -e "- http://localhost:${HTTP_PORT} (on this machine)"
    echo -e "- http://${ip_address}:${HTTP_PORT} (on your local network)"
    echo -e "- http://${hostname}.local:${HTTP_PORT} (via mDNS if available)"
    
    # Run health check
    if ! health_check; then
        echo -e "${YELLOW}Health check completed with warnings.${NC}" >&2
    fi
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
    
    # Stop and disable user service
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${BLUE}Stopping compendium service...${NC}"
        systemctl --user stop compendium.service
    fi
    
    if systemctl --user is-enabled --quiet compendium.service; then
        echo -e "${BLUE}Disabling compendium service...${NC}"
        systemctl --user disable compendium.service
    fi
    
    # Remove user service file
    local user_systemd_dir="${USER_HOME}/.config/systemd/user"
    local service_file="${user_systemd_dir}/compendium.service"
    
    if [ -f "$service_file" ]; then
        echo -e "${BLUE}Removing user service file...${NC}"
        rm -f "$service_file"
        systemctl --user daemon-reload
    fi
    
    # Backup existing installation if it exists
    if [ -d "$APP_DIR" ]; then
        backup_existing
    fi
    
    # Remove application directory
    if [ -d "$APP_DIR" ]; then
        echo -e "${BLUE}Removing application directory...${NC}"
        rm -rf "$APP_DIR"
    fi
    
    echo -e "\n${GREEN}Uninstallation completed!${NC}"
    echo -e "${YELLOW}Note: The following directories were not removed:${NC}"
    echo -e "- Data: $DATA_DIR"
    echo -e "- Logs: $LOG_DIR"
    echo -e "- Backups: $BACKUP_DIR"
    echo -e "\n${YELLOW}To completely remove all traces, you can run:${NC}"
    echo -e "  rm -rf \"$DATA_DIR\" \"$LOG_DIR\" \"$BACKUP_DIR\""
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
    echo "  DISABLE_BLUETOOTH   Disable Bluetooth on Raspberry Pi (default: false)"
    echo "  PERFORMANCE_MODE    Set CPU governor to performance mode (default: false)"
    echo "  CREATE_SWAP         Create swap file (auto, yes, no) (default: auto)"
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
