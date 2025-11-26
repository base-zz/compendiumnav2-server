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

# Key management
KEYS_DIR="${USER_HOME}/.compendium/keys"
PRIVATE_KEY_FILE="${KEYS_DIR}/private-key"
PUBLIC_KEY_FILE="${KEYS_DIR}/public-key"

# Detect if running on Raspberry Pi
if [ -f /etc/rpi-issue ] || grep -q 'Raspberry Pi' /etc/os-release 2>/dev/null; then
    IS_RASPBERRY_PI=true
else
    IS_RASPBERRY_PI=false
fi  # For Avahi service

# User-specific directories
USER_HOME=$(eval echo ~"$APP_USER")
# Main application directory now targets the server repo clone
APP_DIR="${USER_HOME}/compendiumnav2-server"
BACKUP_DIR="${USER_HOME}/compendiumnav2-server-backups"
DATA_DIR="${USER_HOME}/compendium-data"
LOG_DIR="${USER_HOME}/compendium-logs"

# Application settings - clone the server repository, not the client
NODE_VERSION="18"
GIT_REPO="https://github.com/base-zz/compendiumnav2-server.git"
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

# Check if running on a Raspberry Pi and detect model
check_raspberry_pi() {
    echo -e "${BLUE}Checking Raspberry Pi compatibility...${NC}"
    
    # Initialize variables
    IS_RASPBERRY_PI=false
    RPI_MODEL=""
    IS_RPI5=false
    
    # Check if running on a Raspberry Pi
    if [ -f /proc/device-tree/model ]; then
        RPI_MODEL=$(tr -d '\0' < /proc/device-tree/model)
        if [[ "$RPI_MODEL" == *"Raspberry Pi"* ]]; then
            IS_RASPBERRY_PI=true
            echo -e "${GREEN}Detected: $RPI_MODEL${NC}"
            
            # Check if it's a Raspberry Pi 5
            if [[ "$RPI_MODEL" == *"Raspberry Pi 5"* ]]; then
                IS_RPI5=true
                echo -e "${GREEN}Detected Raspberry Pi 5 - Enabling optimizations${NC}"
            fi
        else
            echo -e "${YELLOW}Warning: This doesn't appear to be a Raspberry Pi. Proceeding anyway...${NC}"
        fi
    else
        echo -e "${YELLOW}Warning: Could not determine device model. Proceeding with limited functionality...${NC}"
    fi
    
    export IS_RASPBERRY_PI RPI_MODEL IS_RPI5
    
    # Check memory
    local mem_total=$(free -m | awk '/^Mem:/{print $2}')
    if [ "$mem_total" -lt 1024 ]; then
        echo -e "${YELLOW}Warning: Low memory detected ($mem_total MB). Performance may be affected.${NC}"
    fi
    
    # Check available disk space
    local disk_space=$(df -h / | awk 'NR==2 {print $4}')
    echo -e "${BLUE}Available disk space: $disk_space${NC}"
}

# Configure memory management and system limits
configure_memory_management() {
    echo -e "${BLUE}Configuring memory management...${NC}"
    
    local total_mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    local total_mem_mb=$((total_mem_kb / 1024))
    
    echo -e "${BLUE}Total system memory: ${total_mem_mb}MB${NC}"
    
    # Set memory-related sysctls
    safe_exec sysctl -w vm.swappiness=10
    safe_exec sysctl -w vm.vfs_cache_pressure=50
    safe_exec sysctl -w vm.dirty_ratio=10
    safe_exec sysctl -w vm.dirty_background_ratio=5
    
    # Raspberry Pi 5 specific optimizations
    if [ "$IS_RPI5" = true ]; then
        echo -e "${GREEN}Applying Raspberry Pi 5 specific memory optimizations...${NC}"
        
        # More aggressive memory management for Pi 5's faster hardware
        safe_exec sysctl -w vm.min_free_kbytes=65536
        safe_exec sysctl -w vm.dirty_expire_centisecs=2000
        safe_exec sysctl -w vm.dirty_writeback_centisecs=100
        
        # Enable zswap for better memory compression (if kernel supports it)
        if [ -f /sys/module/zswap/parameters/enabled ]; then
            echo "Enabling zswap for better memory compression..."
            echo 1 > /sys/module/zswap/parameters/enabled
            echo z3fold > /sys/module/zswap/parameters/zpool
            echo zstd > /sys/module/zswap/parameters/compressor
        fi
    fi
    
    # Check if we need to create/configure swap
    if [ -z "$SWAP_SIZE_MB" ]; then
        # Auto-detect swap size based on memory
        if [ $total_mem_mb -lt 4096 ]; then
            SWAP_SIZE_MB=2048  # 2GB swap for systems with <4GB RAM
        else
            SWAP_SIZE_MB=1024  # 1GB swap for systems with >=4GB RAM
        fi
    fi
    
    # Create swap if needed
    if ! swapon --show | grep -q "/"; then
        echo -e "${YELLOW}No swap detected. Creating ${SWAP_SIZE_MB}MB swap file...${NC}"
        safe_exec fallocate -l ${SWAP_SIZE_MB}M /swapfile
        safe_exec chmod 600 /swapfile
        safe_exec mkswap /swapfile
        safe_exec swapon /swapfile
        
        # Add to fstab if not already there
        if ! grep -q "^/swapfile" /etc/fstab; then
            echo "/swapfile none swap sw 0 0" | safe_exec tee -a /etc/fstab
        fi
    else
        echo -e "${GREEN}Swap already configured.${NC}"
    fi
    
    # Optimize swappiness based on memory
    local swappiness=10
    if [ $total_mem_mb -lt 2048 ]; then
        swappiness=30
    elif [ $total_mem_mb -lt 4096 ]; then
        swappiness=20
    fi
    
    echo "vm.swappiness=$swappiness" | safe_exec tee /etc/sysctl.d/99-swappiness.conf
    safe_exec sysctl -w vm.swappiness=$swappiness
    
    echo -e "${GREEN}Memory management configured.${NC}"
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
        bluez            # Core Bluetooth stack / bluetoothd
        bluez-hcidump    # HCI debugging tools useful for BLE issues
        avahi-daemon     # For mDNS support
        libnss-mdns      # For .local resolution
        avahi-utils      # For avahi-publish
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
    
    # Configure environment variables
    configure_environment || return 1
    
    # Create keys directory with proper permissions
    echo -e "${BLUE}Setting up key directory...${NC}"
    mkdir -p "$KEYS_DIR"
    chmod 700 "$KEYS_DIR"
    chown "$APP_USER:" "$KEYS_DIR"
    
    # Generate and register keys
    echo -e "${BLUE}Setting up key-based authentication...${NC}"
    generate_and_register_keys || {
        echo -e "${YELLOW}Key generation/registration failed, but continuing with installation...${NC}"
        echo -e "${YELLOW}The application will attempt to generate keys on first run if needed.${NC}"
    }
    
    # Set proper permissions on key files and copy to project directory
    if [ -f "$PRIVATE_KEY_FILE" ] && [ -f "$PUBLIC_KEY_FILE" ]; then
        # Set permissions on original files
        chmod 600 "$PRIVATE_KEY_FILE"
        chmod 644 "$PUBLIC_KEY_FILE"
        chown "$APP_USER:" "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE"
        
        # Create project keys directory if it doesn't exist
        local project_keys_dir="${APP_DIR}/keys"
        mkdir -p "$project_keys_dir"
        chmod 700 "$project_keys_dir"
        
        # Copy keys to project directory
        cp "$PRIVATE_KEY_FILE" "${project_keys_dir}/"
        cp "$PUBLIC_KEY_FILE" "${project_keys_dir}/"
        
        # Set permissions on copied files
        chmod 600 "${project_keys_dir}/$(basename "$PRIVATE_KEY_FILE")"
        chmod 644 "${project_keys_dir}/$(basename "$PUBLIC_KEY_FILE")"
        chown -R "$APP_USER:" "$project_keys_dir"
        
        echo -e "${GREEN}Keys have been copied to: $project_keys_dir${NC}"
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
    
    # Raspberry Pi 5 specific optimizations
    if [ "$IS_RPI5" = true ]; then
        echo -e "${GREEN}Applying Raspberry Pi 5 specific performance optimizations...${NC}"
        
        # Set CPU governor to ondemand for better power/performance balance
        if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors ]; then
            if grep -q "ondemand" /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors; then
                echo "ondemand" | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
                echo -e "${GREEN}Set CPU governor to ondemand mode for better power efficiency${NC}"
            fi
        fi
        
        # Set CPU frequency scaling parameters
        if [ -f /sys/devices/system/cpu/cpufreq/ondemand/up_threshold ]; then
            echo 40 | tee /sys/devices/system/cpu/cpufreq/ondemand/up_threshold
            echo 10 | tee /sys/devices/system/cpu/cpufreq/ondemand/down_differential
            echo 1 | tee /sys/devices/system/cpu/cpufreq/ondemand/io_is_busy
            echo 10 | tee /sys/devices/system/cpu/cpufreq/ondemand/sampling_down_factor
            echo 10000 | tee /sys/devices/system/cpu/cpufreq/ondemand/sampling_rate
        fi
        
        # Set CPU affinity for IRQ handling (improves network performance)
        if command -v irqbalance &> /dev/null; then
            systemctl enable --now irqbalance
            # Set IRQ affinity to CPU 3 (the last core) for network interrupts
            for irq in $(grep eth0 /proc/interrupts | cut -d: -f1); do
                echo 8 > /proc/irq/$irq/smp_affinity
            done
        fi
        
        # Optimize network settings for better throughput
        cat > /etc/sysctl.d/99-rpi5-network.conf <<EOL
# Network optimizations for Raspberry Pi 5
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 65536 16777216
net.ipv4.tcp_fastopen=3
net.ipv4.tcp_slow_start_after_idle=0
net.ipv4.tcp_tw_reuse=1
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_max_syn_backlog=8192
net.core.netdev_max_backlog=5000
net.core.somaxconn=8192
net.ipv4.tcp_max_tw_buckets=2000000
net.ipv4.tcp_mtu_probing=1
EOL
        
        # Apply network settings
        sysctl -p /etc/sysctl.d/99-rpi5-network.conf
    else
        # Standard Raspberry Pi optimizations for non-Pi 5 models
        if [ "$PERFORMANCE_MODE" = "true" ]; then
            if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
                echo "performance" | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
                echo -e "${GREEN}Set CPU governor to performance mode${NC}"
            fi
        fi
    fi
    
    # Disable unnecessary services if requested
    if [ "$DISABLE_UNNECESSARY_SERVICES" = "true" ]; then
        local services_to_disable=(
            "triggerhappy.service"
            "apt-daily.service"
            "apt-daily-upgrade.service"
            "avahi-daemon.service"
            "dphys-swapfile.service"
            "raspi-config.service"
            "raspi-config-autologin.service"
        )

        # Only disable bluetooth.service when explicitly requested
        if [ "$DISABLE_BLUETOOTH" = "true" ]; then
            services_to_disable+=("bluetooth.service")
        fi
        
        for service in "${services_to_disable[@]}"; do
            if systemctl is-enabled --quiet "$service" 2>/dev/null; then
                systemctl stop "$service"
                systemctl disable "$service"
                echo -e "${GREEN}Disabled $service${NC}"
            fi
        done
    fi
    
    # Optimize filesystem settings
    if [ -f /etc/fstab ]; then
        # Check if already optimized
        if ! grep -q 'noatime,nodiratime' /etc/fstab; then
            # Backup original fstab
            cp /etc/fstab /etc/fstab.bak
            
            # Add mount options for root filesystem
            sed -i 's/\/\s*\w*\s*defaults/\/  ext4  defaults,noatime,nodiratime,commit=60,errors=remount-ro/' /etc/fstab
            
            # Add mount options for boot partition if it exists
            if grep -q '^PARTUUID=' /etc/fstab; then
                sed -i 's/^PARTUUID=\(.*\)\s*\/boot\s*vfat\s*\(.*\)/PARTUUID=\1  \/boot  vfat  \2,noatime,nodiratime,errors=remount-ro/' /etc/fstab
            fi
            
            echo -e "${GREEN}Optimized filesystem mount options in /etc/fstab${NC}"
        fi
    fi
    
    # Optimize disk I/O scheduler
    if [ -f /sys/block/mmcblk0/queue/scheduler ]; then
        echo "mq-deadline" > /sys/block/mmcblk0/queue/scheduler
        echo 1024 > /sys/block/mmcblk0/queue/nr_requests
        echo 16 > /sys/block/mmcblk0/queue/iosched/read_expire
        echo 4 > /sys/block/mmcblk0/queue/iosched/writes_starved
        echo -e "${GREEN}Optimized I/O scheduler for SD card${NC}"
    fi
    
    # Optimize network stack
    cat > /etc/sysctl.d/99-rpi-optimize.conf <<EOL
# Kernel optimizations for Raspberry Pi
fs.file-max = 2097152
fs.nr_open = 2097152
kernel.msgmnb = 65536
kernel.msgmax = 65536
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
net.core.netdev_max_backlog = 30000
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.ip_local_port_range = 1024 65000
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_time = 1800
net.ipv4.tcp_max_orphans = 60000
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_max_tw_buckets = 1440000
net.ipv4.tcp_mem = 65536 131072 262144
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_syn_retries = 2
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_tw_recycle = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_wmem = 4096 65536 16777216
vm.min_free_kbytes = 65536
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOL
    
    # Apply kernel optimizations
    sysctl -p /etc/sysctl.d/99-rpi-optimize.conf
    
    echo -e "${GREEN}Performance tuning completed successfully${NC}"
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

# Health check function - performs comprehensive system and application checks
health_check() {
    local has_errors=0
    local has_warnings=0
    local recommendations=()
    
    echo -e "${BLUE}Performing comprehensive system health check...${NC}"
    
    # 1. System Information
    echo -e "\n${BLUE}1. System Information:${NC}"
    local model="Unknown"
    local os_info=""
    local kernel_info=""
    local uptime_info=""
    
    # Get system information
    if [ -f /proc/device-tree/model ]; then
        model=$(tr -d '\0' < /proc/device-tree/model)
    fi
    
    if [ -f /etc/os-release ]; then
        os_info=$(grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')
    fi
    
    kernel_info=$(uname -r)
    uptime_info=$(uptime -p | sed 's/^up //')
    
    echo -e "${GREEN}• Hardware:${NC} $model"
    echo -e "${GREEN}• OS:${NC} $os_info"
    echo -e "${GREEN}• Kernel:${NC} $kernel_info"
    echo -e "${GREEN}• Uptime:${NC} $uptime_info"
    
    # 2. CPU and Memory Status
    echo -e "\n${BLUE}2. CPU and Memory Status:${NC}"
    
    # CPU Load
    local load_avg=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
    local cpu_cores=$(nproc)
    local load_per_core=$(echo "$load_avg" | awk -v cores=$cpu_cores '{print $1/cores*100 "%"}')
    echo -e "${GREEN}• CPU Load (1/5/15 min):${NC} $load_avg (${load_per_core} per core)"
    
    # CPU Temperature
    local temp="N/A"
    local temp_num=0
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        temp_num=$(cat /sys/class/thermal/thermal_zone0/temp)
        temp=$(echo "scale=1; $temp_num/1000" | bc)
    elif command -v vcgencmd &> /dev/null; then
        temp=$(vcgencmd measure_temp | cut -d= -f2)
        temp_num=$(echo $temp | cut -d. -f1)
    fi
    
    if [ -n "$temp" ] && [ "$temp" != "N/A" ]; then
        if [ $temp_num -gt 75 ]; then
            echo -e "${RED}• CPU Temperature:${NC} ${temp}°C (Warning: High temperature!)"
            recommendations+=("Consider improving cooling (heat sink, fan, or better case ventilation)")
            has_warnings=1
        elif [ $temp_num -gt 65 ]; then
            echo -e "${YELLOW}• CPU Temperature:${NC} ${temp}°C (Elevated)"
            recommendations+=("Monitor temperature, consider improving cooling if temperatures remain high")
        else
            echo -e "${GREEN}• CPU Temperature:${NC} ${temp}°C (Normal)"
        fi
    fi
    
    # CPU Frequency and Governor
    if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ] && \
       [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors ]; then
        local freq_cur=$(($(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq) / 1000))
        local freq_max=$(($(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq) / 1000))
        local governor=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)
        echo -e "${GREEN}• CPU Frequency:${NC} ${freq_cur} MHz (Max: ${freq_max} MHz)"
        echo -e "${GREEN}• CPU Governor:${NC} $governor"
        
        if [ "$IS_RPI5" = true ] && [ "$governor" != "ondemand" ]; then
            echo -e "${YELLOW}  Note: Consider using 'ondemand' governor for better power efficiency${NC}"
            recommendations+=("Set CPU governor to 'ondemand' for better power efficiency: echo ondemand | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor")
        fi
    fi
    
    # Memory Usage
    local mem_total=$(free -m | awk '/^Mem:/{print $2}')
    local mem_used=$(free -m | awk '/^Mem:/{print $3}')
    local mem_usage=$((mem_used * 100 / mem_total))
    local swap_total=$(free -m | awk '/^Swap:/{print $2}')
    local swap_used=$(free -m | awk '/^Swap:/{print $3}')
    
    if [ $mem_usage -gt 90 ]; then
        echo -e "${RED}• Memory Usage:${NC} ${mem_used}MB/${mem_total}MB (${mem_usage}%) - High memory usage!"
        recommendations+=("High memory usage detected. Consider increasing swap space or reducing application memory usage.")
        has_warnings=1
    elif [ $mem_usage -gt 70 ]; then
        echo -e "${YELLOW}• Memory Usage:${NC} ${mem_used}MB/${mem_total}MB (${mem_usage}%)"
    else
        echo -e "${GREEN}• Memory Usage:${NC} ${mem_used}MB/${mem_total}MB (${mem_usage}%)"
    fi
    
    if [ $swap_total -gt 0 ]; then
        local swap_usage=$((swap_used * 100 / swap_total))
        if [ $swap_usage -gt 50 ]; then
            echo -e "${YELLOW}• Swap Usage:${NC} ${swap_used}MB/${swap_total}MB (${swap_usage}%)"
            if [ $swap_usage -gt 80 ]; then
                echo -e "  ${RED}Warning: High swap usage detected! This can significantly degrade performance.${NC}"
                recommendations+=("High swap usage detected. Consider increasing physical memory or reducing application memory requirements.")
                has_warnings=1
            fi
        else
            echo -e "${GREEN}• Swap Usage:${NC} ${swap_used}MB/${swap_total}MB (${swap_usage}%)"
        fi
    else
        echo -e "${YELLOW}• Swap:${NC} Not configured"
        if [ $mem_total -lt 4096 ]; then
            recommendations+=("Consider adding swap space for better performance: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile")
        fi
    fi
    
    # 3. Disk Usage
    echo -e "\n${BLUE}3. Disk Usage:${NC}"
    df -h | grep -v '^tmpfs\|^udev\|^/dev/loop' | awk 'NR==1 || /\/$/ || /\/home$/' | while read -r line; do
        local fs=$(echo $line | awk '{print $1}')
        local size=$(echo $line | awk '{print $2}')
        local used=$(echo $line | awk '{print $3}')
        local avail=$(echo $line | awk '{print $4}')
        local use_pct=$(echo $line | awk '{print $5}' | tr -d '%')
        local mount=$(echo $line | awk '{print $6}')
        
        if [ $use_pct -gt 90 ]; then
            echo -e "${RED}• $mount (${fs}):${NC} ${used}/${size} used, ${avail} available (${use_pct}%)"
            recommendations+=("Disk space on $mount is critically low (${use_pct}% used). Free up space or expand storage.")
            has_warnings=1
        elif [ $use_pct -gt 75 ]; then
            echo -e "${YELLOW}• $mount (${fs}):${NC} ${used}/${size} used, ${avail} available (${use_pct}%)"
            recommendations+=("Monitor disk space on $mount (${use_pct}% used). Consider cleaning up unnecessary files.")
        else
            echo -e "${GREEN}• $mount (${fs}):${NC} ${used}/${size} used, ${avail} available (${use_pct}%)"
        fi
    done
    
    # 4. Service Status
    echo -e "\n${BLUE}4. Service Status:${NC}"
    
    # Check if service is running
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${GREEN}• Compendium Service:${NC} Running"
        
        # Get service status and uptime
        local status_output=$(systemctl --user status compendium.service --no-pager)
        local uptime=$(echo "$status_output" | grep -oP '(?<=; ).*?(?=; )' | head -1)
        local memory=$(echo "$status_output" | grep -oP '(?<=Memory: ).*' || echo "N/A")
        
        echo -e "  ${GREEN}Uptime:${NC} $uptime"
        [ "$memory" != "N/A" ] && echo -e "  ${GREEN}Memory:${NC} $memory"
        
        # Check for recent errors in logs (last 20 lines)
        local log_errors=$(journalctl --user -u compendium.service -n 20 --no-pager | grep -i -E 'error|fail|exception|warning' | grep -v -i 'deprecation' | head -5)
        if [ -n "$log_errors" ]; then
            echo -e "  ${YELLOW}Recent log entries with errors/warnings:${NC}"
            echo "$log_errors" | sed 's/^/  /'
            has_warnings=1
        else
            echo -e "  ${GREEN}No recent errors in logs${NC}"
        fi
    else
        echo -e "${RED}• Compendium Service:${NC} Not running"
        has_errors=1
        
        # Try to get the reason for failure
        local service_status=$(systemctl --user status compendium.service --no-pager 2>&1 || true)
        local failed_reason=$(echo "$service_status" | grep -oP '(?<=error: ).*' | head -1)
        
        if [ -n "$failed_reason" ]; then
            echo -e "  ${RED}Error:${NC} $failed_reason"
        fi
        
        # Check logs for errors
        local log_errors=$(journalctl --user -u compendium.service -n 20 --no-pager | grep -i -E 'error|fail|exception' | head -5)
        if [ -n "$log_errors" ]; then
            echo -e "  ${RED}Recent error logs:${NC}"
            echo "$log_errors" | sed 's/^/  /'
        fi
        
        recommendations+=("The Compendium service is not running. Check logs with: journalctl --user -u compendium.service -n 50 --no-pager")
    fi
    
    # 5. Network and Connectivity
    echo -e "\n${BLUE}5. Network and Connectivity:${NC}"
    
    # Check network interfaces
    local default_iface=$(ip route | grep default | awk '{print $5}' | head -1)
    if [ -n "$default_iface" ]; then
        local ip_addr=$(ip -4 addr show $default_iface | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
        local mac_addr=$(ip link show $default_iface | grep -oP '(?<=link/ether\s)[^\s]+' | head -1)
        local link_speed=$(cat /sys/class/net/$default_iface/speed 2>/dev/null || echo "N/A")
        
        echo -e "${GREEN}• Network Interface ($default_iface):${NC}"
        echo -e "  ${GREEN}IP Address:${NC} $ip_addr"
        echo -e "  ${GREEN}MAC Address:${NC} $mac_addr"
        [ "$link_speed" != "N/A" ] && echo -e "  ${GREEN}Link Speed:${NC} $link_speed Mbps"
        
        # Check for connectivity
        if ping -c 1 -W 2 8.8.8.8 &> /dev/null; then
            echo -e "  ${GREEN}Internet Connectivity:${NC} OK"
        else
            echo -e "  ${RED}Internet Connectivity:${NC} Failed to reach 8.8.8.8"
            recommendations+=("No internet connectivity detected. Check network connection and DNS settings.")
            has_warnings=1
        fi
    else
        echo -e "${RED}• No active network interface found${NC}"
        recommendations+=("No active network interface found. Check network cables and configuration.")
        has_warnings=1
    fi
    
    # Check VPS connectivity if configured
    if [ -n "$VPS_HOST" ]; then
        echo -e "\n${BLUE}6. VPS Connectivity:${NC}"
        
        # Check if we can resolve the VPS hostname
        if host "$VPS_HOST" &> /dev/null; then
            echo -e "${GREEN}• VPS DNS Resolution:${NC} Success"
            
            # Try to connect to VPS on port 443 (HTTPS)
            if nc -z -w 2 "$VPS_HOST" 443 &> /dev/null; then
                echo -e "${GREEN}• VPS Connection (HTTPS):${NC} Port 443 is open"
                
                # Check if we can establish a WebSocket connection
                if command -v curl &> /dev/null; then
                    local ws_url="wss://$VPS_HOST"
                    local ws_test=$(timeout 5 curl -s -I -X GET -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Host: $VPS_HOST" -H "Origin: https://$VPS_HOST" "$ws_url" 2>&1 || true)
                    
                    if echo "$ws_test" | grep -q "101 Switching Protocols"; then
                        echo -e "  ${GREEN}WebSocket Connection:${NC} Success"
                    else
                        echo -e "  ${YELLOW}WebSocket Connection:${NC} Failed (check VPS configuration)"
                        recommendations+=("WebSocket connection to VPS failed. Check if the VPS is configured to accept WebSocket connections on port 443.")
                        has_warnings=1
                    fi
                fi
            else
                echo -e "${RED}• VPS Connection:${NC} Cannot connect to $VPS_HOST:443"
                recommendations+=("Cannot connect to VPS on port 443. Check firewall rules and network connectivity.")
                has_warnings=1
            fi
        else
            echo -e "${RED}• VPS DNS Resolution:${NC} Failed to resolve $VPS_HOST"
            recommendations+=("Failed to resolve VPS hostname. Check DNS settings and network connectivity.")
            has_warnings=1
        fi
    fi
    
    # 7. Raspberry Pi Specific Checks
    if [ "$IS_RASPBERRY_PI" = true ]; then
        echo -e "\n${BLUE}7. Raspberry Pi Specific Checks:${NC}"
        
        # Check power supply
        if [ -f "/sys/class/power_supply/"*"type" ]; then
            local power_source
            power_source=$(grep -l "Mains" /sys/class/power_supply/*/type 2>/dev/null | xargs dirname | xargs basename || true)
            if [ -n "$power_source" ]; then
                if [ -f "/sys/class/power_supply/$power_source/online" ] && 
                   [ "$(cat "/sys/class/power_supply/$power_source/online" 2>/dev/null)" = "1" ]; then
                    echo -e "${GREEN}• Power Supply:${NC} Mains power connected"
                else
                    echo -e "${YELLOW}• Power Supply:${NC} Running on battery power"
                    recommendations+=("Running on battery power. Connect to mains power for optimal performance.")
                    has_warnings=1
                fi
            fi
        fi
        
        # Check for throttling on Raspberry Pi
        if command -v vcgencmd &> /dev/null; then
            local throttled=$(vcgencmd get_throttled)
            echo -e "${GREEN}• Throttle Status:${NC} $throttled"
            
            # Check for under-voltage
            if [[ "$throttled" == *"0x50000"* ]] || [[ "$throttled" == *"0x50005"* ]]; then
                echo -e "  ${RED}Warning: Under-voltage detected! This can cause instability.${NC}"
                recommendations+=("Under-voltage detected. Use a high-quality power supply (at least 3A for Raspberry Pi 4/5).")
                has_warnings=1
            fi
            
            # Check for throttling
            if [[ "$throttled" == *"0x1"* ]] || [[ "$throttled" == *"0x5"* ]]; then
                echo -e "  ${YELLOW}Warning: CPU throttling detected due to high temperature or low voltage${NC}"
                recommendations+=("CPU throttling detected. Check cooling and power supply.")
                has_warnings=1
            fi
        fi
        
        # Check for firmware updates
        if command -v rpi-eeprom-update &> /dev/null; then
            local fw_status=$(rpi-eeprom-update 2>&1 | grep -i "update available" || true)
            if [ -n "$fw_status" ]; then
                echo -e "${YELLOW}• Firmware Update:${NC} $fw_status"
                recommendations+=("Raspberry Pi firmware update available. Consider updating with: sudo rpi-eeprom-update -a")
                has_warnings=1
            else
                echo -e "${GREEN}• Firmware:${NC} Up to date"
            fi
        fi
    fi
    
    # 8. System Updates
    if [ -f "/etc/os-release" ] && grep -q "Raspbian\|Debian" /etc/os-release; then
        echo -e "\n${BLUE}8. System Updates:${NC}"
        if command -v apt-get >/dev/null; then
            if [ "$(id -u)" -eq 0 ]; then
                apt-get update >/dev/null 2>&1
                local updates=$(apt-get -s upgrade | grep -c '^Inst' || true)
                if [ "$updates" -gt 0 ]; then
                    echo -e "${YELLOW}• System Updates:${NC} $updates updates available"
                    recommendations+=("$updates system updates available. Consider updating with: sudo apt update && sudo apt upgrade -y")
                    has_warnings=1
                else
                    echo -e "${GREEN}• System Updates:${NC} System is up to date"
                fi
            else
                echo -e "${YELLOW}• System Updates:${NC} Run as root to check for updates"
                recommendations+=("Run as root to check for system updates: sudo apt update && sudo apt upgrade -y")
            fi
        fi
    fi
    
    # Summary and Recommendations
    echo -e "\n${BLUE}=== Health Check Summary ===${NC}"
    
    # Show recommendations if any
    if [ ${#recommendations[@]} -gt 0 ]; then
        echo -e "\n${YELLOW}Recommendations:${NC}"
        for ((i=0; i<${#recommendations[@]}; i++)); do
            echo -e "  $((i+1)). ${recommendations[$i]}"
        done
    fi
    
    # Final status
    if [ $has_errors -gt 0 ]; then
        echo -e "\n${RED}✗ Health check completed with errors${NC}" >&2
        return 1
    elif [ $has_warnings -gt 0 ] || [ ${#recommendations[@]} -gt 0 ]; then
        echo -e "\n${YELLOW}⚠ Health check completed with warnings${NC}"
        return 0
    else
        echo -e "\n${GREEN}✓ Health check completed successfully - No issues found${NC}"
        return 0
    fi
}

# Generate and register keys with VPS
generate_and_register_keys() {
    echo -e "${BLUE}Setting up key-based authentication...${NC}"
    
    # Create keys directory if it doesn't exist
    mkdir -p "$KEYS_DIR"
    
    # Check if node is installed
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}Node.js is required for key generation. Installing Node.js...${NC}"
        install_dependencies
    fi
    
    # Create a temporary script to generate and register keys
    local key_script="${KEYS_DIR}/key-setup.js"
    
    # Create the key setup script
    cat > "$key_script" << 'EOL'
import { getOrCreateKeyPair, registerPublicKeyWithVPS } from './src/state/keyPair.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set the key file paths
const KEYS_DIR = process.env.HOME ? path.join(process.env.HOME, '.compendium/keys') : '/etc/compendium/keys';
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'private-key');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'public-key');

// Set environment variables for the key paths
process.env.COMPENDIUM_PRIVATE_KEY_FILE = PRIVATE_KEY_PATH;
process.env.COMPENDIUM_PUBLIC_KEY_FILE = PUBLIC_KEY_PATH;

// Ensure the keys directory exists
if (!fs.existsSync(KEYS_DIR)) {
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
}

async function setupKeys() {
  try {
    console.log('Generating key pair...');
    const keyPair = getOrCreateKeyPair();
    
    if (!keyPair || !keyPair.publicKey) {
      throw new Error('Failed to generate key pair');
    }
    
    console.log('Key pair generated successfully');
    
    // Get VPS URL from environment
    const vpsHost = process.env.VPS_HOST || 'compendiumnav.com';
    const vpsProtocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const vpsPort = process.env.NODE_ENV === 'production' ? '443' : (process.env.VPS_WS_PORT || '3009');
    const vpsPath = process.env.VPS_PATH || '/relay';
    const vpsUrl = `${vpsProtocol}://${vpsHost}:${vpsPort}${vpsPath}`;
    
    console.log(`Registering public key with VPS at ${vpsUrl}...`);
    const success = await registerPublicKeyWithVPS(vpsUrl);
    
    if (!success) {
      throw new Error('Failed to register public key with VPS');
    }
    
    console.log('Successfully registered public key with VPS');
    console.log('Private key stored at:', PRIVATE_KEY_PATH);
    console.log('Public key stored at:', PUBLIC_KEY_PATH);
    process.exit(0);
  } catch (error) {
    console.error('Error during key setup:', error);
    process.exit(1);
  }
}

setupKeys();
EOL
    
    # Prepare key scripts and package.json in the keys directory
    mkdir -p "${KEYS_DIR}/src/state"
    cp "${APP_DIR}/src/state/keyPair.js" "${KEYS_DIR}/src/state/"
    cp "${APP_DIR}/src/state/uniqueAppId.js" "${KEYS_DIR}/src/state/"
    
    cat > "${KEYS_DIR}/package.json" << 'EOL'
{
  "name": "compendium-keys",
  "version": "1.0.0",
  "description": "Key management for Compendium Navigation Server",
  "type": "module",
  "dependencies": {
    "node-forge": "^1.3.1",
    "node-fetch": "^2.6.7"
  }
}
EOL
    
    # Install required dependencies
    echo -e "${BLUE}Installing required Node.js dependencies...${NC}"
    (cd "$KEYS_DIR" && npm install --no-package-lock --no-save)
    
    # Run the key setup script
    echo -e "${BLUE}Generating and registering keys...${NC}"
    if ! (cd "$KEYS_DIR" && node key-setup.js); then
        echo -e "${RED}Error: Failed to generate or register keys${NC}" >&2
        return 1
    fi
    
    # Copy the generated keys to the app directory
    if [ -f "${KEYS_DIR}/.private-key" ] && [ -f "${KEYS_DIR}/.public-key" ]; then
        cp "${KEYS_DIR}/.private-key" "${APP_DIR}/"
        cp "${KEYS_DIR}/.public-key" "${APP_DIR}/"
        chown "$APP_USER:" "${APP_DIR}/.private-key" "${APP_DIR}/.public-key"
        chmod 600 "${APP_DIR}/.private-key"
        chmod 644 "${APP_DIR}/.public-key"
        echo -e "${GREEN}Keys successfully generated and registered${NC}"
    else
        echo -e "${YELLOW}Warning: Keys were not generated correctly${NC}" >&2
        return 1
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
    # Generate and register keys if they don't exist
    if [ ! -f "${APP_DIR}/.private-key" ] || [ ! -f "${APP_DIR}/.public-key" ]; then
        echo -e "${YELLOW}No existing keys found. Generating new keys...${NC}"
        generate_and_register_keys || {
            echo -e "${YELLOW}Key generation/registration failed, but continuing with update...${NC}"
            echo -e "${YELLOW}The application will attempt to generate keys on first run if needed.${NC}"
        }
    fi
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
