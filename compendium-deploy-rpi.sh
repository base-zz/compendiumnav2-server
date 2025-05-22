#!/bin/bash
# compendium-deploy-rpi.sh - Enhanced deployment script for Compendium Navigation Server with Raspberry Pi optimizations

set -euo pipefail
IFS=$'\n\t'

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
DEFAULT_APP_USER="compendium"
CURRENT_USER=$(whoami)
APP_USER="${COMPENDIUM_USER:-$CURRENT_USER}"
# Use system hostname by default, fallback to 'compendium'
BACKUP_DIR="/home/$APP_USER/compendium-backups"
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

# Ensure running as root
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}This script must be run as root. Use sudo.${NC}" >&2
        exit 1
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
    
    # Update package lists
    if ! apt-get update; then
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
    
    if ! apt-get install -y "${packages[@]}"; then
        echo -e "${RED}Failed to install required packages${NC}" >&2
        return 1
    fi
    
    # Install Node.js with ARM architecture detection
    if ! command -v node &> /dev/null; then
        echo -e "${BLUE}Installing Node.js...${NC}"
        
        # Check architecture
        local arch=$(uname -m)
        if [[ "$arch" == "armv"* || "$arch" == "aarch64" ]]; then
            echo -e "${BLUE}ARM architecture detected: $arch${NC}"
            # Use the ARM-specific NodeSource setup
            curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
        else
            # Fallback to standard setup
            curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
        fi
        
        if ! apt-get install -y nodejs; then
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
    
    if [ ! -d ".git" ]; then
        echo -e "${RED}Error: Not a git repository. Please run this script from the compendiumnav2 directory.${NC}" >&2
        return 1
    fi
    
    # Ensure we have the latest version
    echo -e "${BLUE}Updating repository...${NC}"
    git pull
    
    # Checkout specific version if specified
    if [ -n "$COMPENDIUM_VERSION" ] && [ "$COMPENDIUM_VERSION" != "latest" ]; then
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
    
    # Set environment variables
    set_env_var "PORT" "$HTTP_PORT"
    set_env_var "VPS_WS_PORT" "$WS_PORT"
    set_env_var "NODE_ENV" "production"
    set_env_var "FRONTEND_URL" "http://$(hostname -I | awk '{print $1}'):$(echo -e "${HTTP_PORT}")"
    
    # mDNS configuration
    set_env_var "MDNS_ENABLED" "true"
    set_env_var "MDNS_NAME" "$(hostname)"
    set_env_var "MDNS_DOMAIN" "local"
    set_env_var "MDNS_SERVICE" "_compendium._tcp"
    
    # Log level
    set_env_var "LOG_LEVEL" "info"
    
    # Data directory
    local data_dir="/home/$APP_USER/compendium-data"
    mkdir -p "$data_dir"
    set_env_var "DATA_DIR" "$data_dir"
    
    # Raspberry Pi specific settings
    if [ "$IS_RASPBERRY_PI" = true ]; then
        # Memory limit for Node.js
        local mem_total=$(free -m | awk '/^Mem:/{print $2}')
        local max_memory="512M"
        if [ "$mem_total" -lt 1024 ]; then
            max_memory="256M"
        fi
        set_env_var "NODE_OPTIONS" "--max-old-space-size=${max_memory%M}"
    fi
    
    echo -e "${GREEN}Environment configured${NC}"
    return 0
}

# Configure memory management for Raspberry Pi
configure_memory_management() {
    if [ "$IS_RASPBERRY_PI" != true ]; then
        echo -e "${BLUE}Skipping memory management (not a Raspberry Pi)${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Configuring memory management for Raspberry Pi...${NC}"
    
    # Create a swap file if memory is low
    local mem_total=$(free -m | awk '/^Mem:/{print $2}')
    local should_create_swap=false
    
    if [ "$CREATE_SWAP" = "yes" ]; then
        should_create_swap=true
    elif [ "$CREATE_SWAP" = "auto" ] && [ "$mem_total" -lt 2048 ] && [ ! -f /swapfile ]; then
        should_create_swap=true
    fi
    
    if [ "$should_create_swap" = true ]; then
        echo -e "${YELLOW}Creating swap file...${NC}"
        
        # Create 1GB swap file
        dd if=/dev/zero of=/swapfile bs=1M count=1024
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        
        # Make swap permanent
        if ! grep -q "/swapfile" /etc/fstab; then
            echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
        fi
        
        echo -e "${GREEN}Swap file created and enabled${NC}"
    fi
    
    echo -e "${GREEN}Memory management configured${NC}"
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

# Setup systemd service with mDNS support
setup_systemd_service() {
    echo -e "${BLUE}Setting up systemd service...${NC}"
    
    # Ensure /etc/hosts has both hostnames
    if ! grep -q "127.0.1.1.*compendium" /etc/hosts; then
        echo -e "${BLUE}Updating /etc/hosts to include compendium hostname...${NC}"
        if grep -q "127\.0\.1\.1" /etc/hosts; then
            # Append to existing line if it exists
            sed -i "/127\.0\.1\.1/s/$/ compendium/" /etc/hosts
        else
            # Add new line if it doesn't exist
            echo "127.0.1.1       compendium" | tee -a /etc/hosts > /dev/null
        fi
    fi
    
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
    
    # Create systemd service directory if it doesn't exist
    mkdir -p /etc/systemd/system
    
    # Create systemd service file
    local service_file="/etc/systemd/system/compendium.service"
    echo -e "${BLUE}Creating service file at $service_file${NC}"
    
    cat > "$service_file" << EOF
[Unit]
Description=Compendium Navigation Server
After=network.target avahi-daemon.service
Wants=avahi-daemon.service

[Service]
Type=simple
User=root
WorkingDirectory=$(pwd)
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
    
    # Set correct permissions
    chmod 644 "$service_file"
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable and start the service
    systemctl enable compendium.service
    
    echo -e "${GREEN}Systemd service configured${NC}"
    echo -e "${YELLOW}Starting Compendium service...${NC}"
    
    if systemctl start compendium.service; then
        echo -e "${GREEN}Compendium service started successfully${NC}"
        echo -e "${BLUE}Service status:${NC}"
        systemctl status compendium.service --no-pager
    else
        echo -e "${RED}Failed to start Compendium service${NC}" >&2
        journalctl -u compendium -n 20 --no-pager
        return 1
    fi
    
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

# Configure firewall
configure_firewall() {
    echo -e "${BLUE}Configuring firewall...${NC}"
    
    # Check if ufw is installed
    if command_exists ufw; then
        # Allow HTTP and WebSocket ports
        ufw allow $HTTP_PORT/tcp
        ufw allow $WS_PORT/tcp
        
        # Allow Avahi mDNS
        ufw allow 5353/udp
        
        echo -e "${GREEN}Firewall configured with ufw${NC}"
    # Check if firewalld is installed
    elif command_exists firewall-cmd; then
        # Allow HTTP and WebSocket ports
        firewall-cmd --permanent --add-port=$HTTP_PORT/tcp
        firewall-cmd --permanent --add-port=$WS_PORT/tcp
        
        # Allow Avahi mDNS
        firewall-cmd --permanent --add-port=5353/udp
        
        # Reload firewall
        firewall-cmd --reload
        
        echo -e "${GREEN}Firewall configured with firewalld${NC}"
    else
        echo -e "${YELLOW}No firewall detected, skipping firewall configuration${NC}"
    fi
    
    return 0
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

# Health check
health_check() {
    echo -e "${BLUE}Performing health check...${NC}"
    
    # Wait for service to start
    sleep 5
    
    # Check if service is running
    if ! systemctl is-active --quiet compendium; then
        echo -e "${RED}Service is not running${NC}" >&2
        systemctl status compendium
        return 1
    fi
    
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
    
    echo -e "${GREEN}Health check passed${NC}"
    return 0
}

# Main installation function
install() {
    echo -e "${BLUE}Starting installation...${NC}"
    
    # Verify we're in the right directory
    verify_repository || return 1
    
    # Check system requirements
    check_root
    check_raspberry_pi
    initialize_ports
    validate_config
    
    # Install system dependencies
    install_dependencies
    
    # Configure environment
    configure_environment
    
    # Install npm dependencies
    echo -e "${BLUE}Installing npm dependencies...${NC}"
    npm install || {
        echo -e "${RED}Failed to install npm dependencies${NC}" >&2
        return 1
    }
    
    # Setup systemd service
    setup_systemd_service
    
    # Configure firewall
    configure_firewall
    
    echo -e "\n${GREEN}Installation completed successfully!${NC}"
    echo -e "${YELLOW}The Compendium Navigation Server should now be running.${NC}"
    echo -e "${YELLOW}Access it at: http://$(hostname -I | awk '{print $1}'):$(echo -e "${HTTP_PORT}")${NC}"
    return 0
    echo -e "${GREEN}Compendium Navigation Server has been successfully installed!${NC}"
    echo -e "${GREEN}You can access it at http://$HOSTNAME.$DOMAIN:$HTTP_PORT${NC}"
}

# Update function
update() {
    check_root
    
    echo -e "${BLUE}Updating Compendium Navigation Server...${NC}"
    
    # Stop service
    systemctl stop compendium
    
    # Backup existing installation
    backup_existing
    
    # Update repository
    setup_repository
    
    # Update environment
    configure_environment
    
    # Update dependencies
    cd "$APP_DIR" || exit 1
    echo -e "${BLUE}Updating npm dependencies...${NC}"
    su -c "npm install --no-optional --production" - "$APP_USER"
    
    # Restart service
    systemctl start compendium
    
    health_check
    monitor_temperature
    
    echo -e "${GREEN}Compendium Navigation Server has been successfully updated!${NC}"
    echo -e "${GREEN}You can access it at http://$HOSTNAME.$DOMAIN:$HTTP_PORT${NC}"
}

# Uninstall function
uninstall() {
    check_root
    
    echo -e "${BLUE}Uninstalling Compendium Navigation Server...${NC}"
    
    # Confirm uninstall
    read -p "Are you sure you want to uninstall Compendium Navigation Server? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}Uninstall cancelled${NC}"
        return 0
    fi
    
    # Stop and disable service
    systemctl stop compendium || true
    systemctl disable compendium || true
    
    # Remove service file
    rm -f /etc/systemd/system/compendium.service
    systemctl daemon-reload
    
    # Remove Avahi service
    rm -f /etc/avahi/services/compendium.service
    systemctl restart avahi-daemon
    
    # Backup existing installation
    backup_existing
    
    # Remove application directory
    rm -rf "$APP_DIR"
    
    echo -e "${GREEN}Compendium Navigation Server has been successfully uninstalled${NC}"
    echo -e "${YELLOW}Backups are still available at $BACKUP_DIR${NC}"
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
