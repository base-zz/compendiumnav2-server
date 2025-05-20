#!/bin/bash
# compendium-deploy.sh - Deployment script for Compendium Navigation Server

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
APP_DIR="/home/$APP_USER/compendiumnav2"
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

# Ensure running as root
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}This script must be run as root. Use sudo.${NC}" >&2
        exit 1
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
    )
    
    if ! apt-get install -y "${packages[@]}"; then
        echo -e "${RED}Failed to install required packages${NC}" >&2
        return 1
    fi
    
    # Install Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${BLUE}Installing Node.js...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
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

# Setup repository
setup_repository() {
    echo -e "${BLUE}Setting up repository...${NC}"
    
    if [ ! -d "$APP_DIR" ]; then
        # Clone the repository
        echo -e "${BLUE}Cloning repository...${NC}"
        if ! git clone --branch "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"; then
            echo -e "${RED}Failed to clone repository${NC}" >&2
            return 1
        fi
    else
        # Update existing repository
        echo -e "${BLUE}Updating repository...${NC}"
        cd "$APP_DIR" || return 1
        if ! git fetch --all; then
            echo -e "${RED}Failed to fetch updates${NC}" >&2
            return 1
        fi
    fi
    
    # Checkout specific version if specified
    if [ "$TARGET_VERSION" != "latest" ]; then
        echo -e "${BLUE}Checking out version $TARGET_VERSION...${NC}"
        cd "$APP_DIR" || return 1
        if ! git checkout "$TARGET_VERSION"; then
            echo -e "${RED}Failed to checkout version $TARGET_VERSION${NC}" >&2
            return 1
        fi
    fi
    
    return 0
}

# Configure environment variables
configure_environment() {
    echo -e "${BLUE}Configuring environment...${NC}"
    local env_file="$APP_DIR/.env.server"
    
    # Create or update .env.server
    if [ ! -f "$env_file" ]; then
        echo -e "${YELLOW}Creating new .env.server file${NC}"
        touch "$env_file"
        chown $APP_USER:$APP_USER "$env_file"
        chmod 600 "$env_file"
    fi

    # Backup existing config
    cp "$env_file" "${env_file}.bak"
    echo -e "${YELLOW}Backed up existing .env.server to .env.server.bak${NC}"

    # Update or add required variables
    set_env_var "PORT" "$HTTP_PORT" "$env_file"
    set_env_var "DIRECT_WS_PORT" "$WS_PORT" "$env_file"
    set_env_var "NODE_ENV" "production" "$env_file"
    
    # Set default values for required variables if they don't exist
    set_env_var "VPS_HOST" "compendiumnav.com" "$env_file"
    set_env_var "VPS_WS_PORT" "443" "$env_file"
    set_env_var "VPS_PATH" "/relay" "$env_file"
    set_env_var "TOKEN_SECRET" "$(openssl rand -hex 32)" "$env_file"
    
    echo -e "${GREEN}Environment configuration complete${NC}"
}

# Helper function to set or update an environment variable
set_env_var() {
    local var_name=$1
    local var_value=$2
    local env_file=$3
    
    if grep -q "^$var_name=" "$env_file"; then
        # Variable exists, update it
        sed -i "s/^$var_name=.*/$var_name=$var_value/" "$env_file"
    else
        # Variable doesn't exist, add it
        echo "$var_name=$var_value" >> "$env_file"
    fi
}

# Setup systemd service
setup_systemd_service() {
    echo -e "${BLUE}Setting up systemd service...${NC}"
    local service_file="/etc/systemd/system/compendium.service"
    
    # Create service file
    cat > "$service_file" << EOF
[Unit]
Description=Compendium Navigation Server
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env.server
ExecStart=/usr/bin/node $APP_DIR/src/server/mainServer.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=compendium

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd and enable service
    systemctl daemon-reload
    systemctl enable compendium.service
    systemctl restart compendium.service
    
    echo -e "${GREEN}Systemd service configured${NC}"
}

# Configure firewall
configure_firewall() {
    echo -e "${BLUE}Configuring firewall...${NC}"
    
    if ! command -v ufw &> /dev/null; then
        echo -e "${YELLOW}ufw not installed, skipping firewall configuration${NC}"
        return 0
    fi
    
    # Allow SSH
    ufw allow OpenSSH
    
    # Allow HTTP/HTTPS
    ufw allow $HTTP_PORT/tcp
    
    # Allow WebSocket
    ufw allow $WS_PORT/tcp
    
    # Enable firewall
    echo "y" | ufw enable
    
    echo -e "${GREEN}Firewall configured${NC}"
}

# Health check
health_check() {
    echo -e "${BLUE}Running health checks...${NC}"
    
    # Check if service is running
    if ! systemctl is-active --quiet compendium.service; then
        echo -e "${RED}Service is not running${NC}" >&2
        return 1
    fi
    
    # Check if ports are accessible
    if ! nc -z 127.0.0.1 $HTTP_PORT; then
        echo -e "${RED}HTTP port $HTTP_PORT is not accessible${NC}" >&2
        return 1
    fi
    
    if ! nc -z 127.0.0.1 $WS_PORT; then
        echo -e "${RED}WebSocket port $WS_PORT is not accessible${NC}" >&2
        return 1
    fi
    
    echo -e "${GREEN}✓ All health checks passed${NC}"
    return 0
}

# Main installation function
install() {
    echo -e "${GREEN}=== Starting Compendium Installation ===${NC}"
    
    # Check if running as root
    check_root
    
    # Initialize ports
    initialize_ports
    
    # Validate configuration
    validate_config
    
    # Backup existing installation
    backup_existing
    
    # Install dependencies
    if ! install_dependencies; then
        echo -e "${RED}Failed to install dependencies${NC}" >&2
        exit 1
    fi
    
    # Setup repository
    if ! setup_repository; then
        echo -e "${RED}Failed to setup repository${NC}" >&2
        exit 1
    fi
    
    # Configure environment
    if ! configure_environment; then
        echo -e "${RED}Failed to configure environment${NC}" >&2
        exit 1
    fi
    
    # Setup systemd service
    if ! setup_systemd_service; then
        echo -e "${RED}Failed to setup systemd service${NC}" >&2
        exit 1
    fi

    # Get IP address
    local ip_address
    ip_address=$(hostname -I | awk '{print $1}')
    
    # Print completion message
    echo -e "\n${GREEN}=== Installation Complete! ===${NC}"
    echo -e "Your Compendium Navigation Server is now running."
    echo -e ""
    echo -e "${YELLOW}Access Information:${NC}"
    echo -e "  - Local URL:    http://localhost:$HTTP_PORT"
    echo -e "  - Network URL:  http://$ip_address:$HTTP_PORT"
    echo -e "  - WebSocket:    ws://$ip_address:$WS_PORT"
    echo -e ""
    echo -e "${YELLOW}Management Commands:${NC}"
    echo -e "  Start:    systemctl start compendium"
    echo -e "  Stop:     systemctl stop compendium"
    echo -e "  Restart:  systemctl restart compendium"
    echo -e "  Status:   systemctl status compendium"
    echo -e "  Logs:     journalctl -u compendium -f"
    echo -e ""
    echo -e "${YELLOW}Next Steps:${NC}"
    echo -e "  1. Open your browser to http://$ip_address:$HTTP_PORT"
    echo -e "  2. Check logs if you encounter any issues"
    echo -e "  3. Configure your firewall to allow traffic on ports $HTTP_PORT and $WS_PORT"
}

# Update function
update() {
    echo -e "${GREEN}=== Updating Compendium ===${NC}"
    
    # Check if running as root
    check_root
    
    # Backup existing installation
    backup_existing
    
    # Update repository
    if ! setup_repository; then
        echo -e "${RED}Failed to update repository${NC}" >&2
        exit 1
    fi
    
    # Install dependencies
    if ! install_dependencies; then
        echo -e "${RED}Failed to install dependencies${NC}" >&2
        exit 1
    fi
    
    # Restart service
    if ! systemctl restart compendium.service; then
        echo -e "${RED}Failed to restart service${NC}" >&2
        exit 1
    fi
    
    echo -e "${GREEN}✓ Update completed successfully${NC}"
}

# Uninstall function
uninstall() {
    echo -e "${YELLOW}=== Uninstalling Compendium ===${NC}"
    
    # Check if running as root
    check_root
    
    # Stop and disable service
    if systemctl is-active --quiet compendium.service; then
        echo -e "${BLUE}Stopping service...${NC}"
        systemctl stop compendium.service
    fi
    
    if systemctl is-enabled --quiet compendium.service; then
        echo -e "${BLUE}Disabling service...${NC}"
        systemctl disable compendium.service
    fi
    
    # Remove service file
    if [ -f "/etc/systemd/system/compendium.service" ]; then
        echo -e "${BLUE}Removing service file...${NC}"
        rm -f "/etc/systemd/system/compendium.service"
        systemctl daemon-reload
    fi
    
    # Remove application directory
    if [ -d "$APP_DIR" ]; then
        echo -e "${BLUE}Removing application files...${NC}"
        rm -rf "$APP_DIR"
    fi
    
    echo -e "${GREEN}✓ Uninstallation completed${NC}"
}

# Show help
show_help() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  install     Install Compendium Navigation Server"
    echo "  update      Update to the latest version"
    echo "  uninstall   Remove Compendium and all its components"
    echo "  help        Show this help message"
    echo ""
    echo "Environment variables:"
    echo "  COMPENDIUM_USER    User to run the service as (default: compendium)"
    echo "  COMPENDIUM_VERSION Version to install (default: latest)"
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
    help|--help|-h|"")
        show_help
        ;;
    *)
        echo -e "${RED}Error: Unknown command '$1'${NC}" >&2
        show_help
        exit 1
        ;;
esac

exit 0