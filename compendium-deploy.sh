#!/bin/bash
# compendium-deploy.sh - Deployment script for Compendium Navigation Server with mDNS support

set -euo pipefail
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
SERVICE_NAME="compendium"

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

# Ports (will be checked for availability)
DEFAULT_HTTP_PORT=8080
DEFAULT_WS_PORT=3009
HTTP_PORT=$DEFAULT_HTTP_PORT
WS_PORT=$DEFAULT_WS_PORT

# Detect if running on Raspberry Pi
if [ -f /etc/rpi-issue ] || grep -q 'Raspberry Pi' /etc/os-release 2>/dev/null; then
    IS_RASPBERRY_PI=true
else
    IS_RASPBERRY_PI=false
fi

# Check if running as root for operations that need it
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${YELLOW}Warning: Some operations require root privileges. Using sudo when needed.${NC}"
        return 1
    fi
    return 0
}

# Run a command with sudo if not root
run_with_sudo() {
    if [ "$(id -u)" -ne 0 ]; then
        sudo "$@"
    else
        "$@"
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
    if ! command -v nc &> /dev/null; then
        echo -e "${YELLOW}✗ netcat (nc) not found, port checking disabled${NC}" >&2
        return 0
    fi
    
    if nc -z 127.0.0.1 "$port" &>/dev/null; then
        echo -e "${YELLOW}Port ${port} is in use${NC}" >&2
        return 1
    fi
    
    # Check if port is privileged (requires root)
    if [ "$port" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
        echo -e "${YELLOW}Port ${port} requires root privileges${NC}" >&2
        return 1
    fi
    
    return 0
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
    
    echo -e "${GREEN}✅ Ports configured - HTTP: $HTTP_PORT, WebSocket: $WS_PORT${NC}"
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

# Configure environment variables with mDNS settings
configure_environment() {
    echo -e "${BLUE}Configuring environment with mDNS support...${NC}"
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

    # Set hostname if not already set
    if [ -z "$(hostname)" ] || [ "$(hostname)" = "localhost" ]; then
        hostnamectl set-hostname "$HOSTNAME"
    else
        HOSTNAME=$(hostname)
    fi

    # Update or add required variables
    set_env_var "PORT" "$HTTP_PORT" "$env_file"
    set_env_var "DIRECT_WS_PORT" "$WS_PORT" "$env_file"
    set_env_var "NODE_ENV" "production" "$env_file"
    
    # mDNS configuration
    set_env_var "MDNS_ENABLED" "true" "$env_file"
    set_env_var "MDNS_HOSTNAME" "$HOSTNAME" "$env_file"
    set_env_var "MDNS_DOMAIN" "$DOMAIN" "$env_file"
    
    # Network configuration
    set_env_var "VPS_HOST" "$HOSTNAME.$DOMAIN" "$env_file"
    set_env_var "VPS_WS_PORT" "$WS_PORT" "$env_file"
    set_env_var "VPS_PATH" "/relay" "$env_file"
    set_env_var "TOKEN_SECRET" "$(openssl rand -hex 32)" "$env_file"
    
    # Set avahi-daemon configuration
    configure_avahi
    
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

# Configure Avahi (mDNS) service
export HOSTNAME DOMAIN SERVICE_NAME

configure_avahi() {
    echo -e "${BLUE}Configuring Avahi (mDNS) service...${NC}"
    
    # Check if we can configure Avahi
    if [ ! -w "/etc/avahi/services" ]; then
        echo -e "${YELLOW}Root access required to configure Avahi${NC}"
        if ! run_with_sudo true; then
            echo -e "${YELLOW}Skipping Avahi configuration - run with sudo to enable mDNS service discovery${NC}"
            return 0
        fi
    fi
    
    # Ensure avahi-daemon is running
    if ! systemctl is-active --quiet avahi-daemon; then
        echo -e "${YELLOW}Starting avahi-daemon...${NC}"
        run_with_sudo systemctl enable --now avahi-daemon
    fi
    
    # Create Avahi service file in a temporary location first
    local temp_avahi_file="/tmp/compendium-avahi.$$.service"
    local avahi_service_file="/etc/avahi/services/${SERVICE_NAME}.service"
    
    # Get the hostname
    local hostname=$(hostname)
    
    cat > "$temp_avahi_file" << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>Compendium Navigation Server</name>
  <service>
    <type>_http._tcp</type>
    <port>$HTTP_PORT</port>
    <txt-record>path=/</txt-record>
  </service>
  <service>
    <type>_compendium._tcp</type>
    <port>$WS_PORT</port>
    <txt-record>path=/ws</txt-record>
  </service>
</service-group>
EOF
    
    # Move the file to the Avahi services directory
    if ! run_with_sudo cp "$temp_avahi_file" "$avahi_service_file"; then
        echo -e "${RED}Failed to create Avahi service file${NC}" >&2
        rm -f "$temp_avahi_file"
        return 1
    fi
    rm -f "$temp_avahi_file"
    
    # Set correct permissions
    run_with_sudo chmod 644 "$avahi_service_file"
    
    echo -e "${GREEN}Avahi service configured at $avahi_service_file${NC}"
    
    # Restart avahi to apply changes
    if run_with_sudo systemctl restart avahi-daemon; then
        echo -e "${GREEN}mDNS service is now advertising:${NC}"
        echo -e "  - HTTP:     http://${hostname}.local:$HTTP_PORT"
        echo -e "  - WebSocket: ws://${hostname}.local:$WS_PORT"
    else
        echo -e "${YELLOW}Failed to restart Avahi daemon. Changes may not take effect immediately.${NC}"
    fi
}

# Setup user systemd service
setup_systemd_service() {
    echo -e "${BLUE}Setting up user systemd service...${NC}"
    
    # Create user systemd directory if it doesn't exist
    USER_SYSTEMD_DIR="${USER_HOME}/.config/systemd/user"
    mkdir -p "${USER_SYSTEMD_DIR}"
    
    # Enable lingering for the user to allow user services to run at boot
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q Linger=yes; then
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
        echo -e "${YELLOW}Warning: Main server file not found at $main_server_file${NC}"
        read -p "Enter the path to mainServer.js: " main_server_file
        if [ ! -f "$main_server_file" ]; then
            echo -e "${YELLOW}Could not find main server file at $main_server_file${NC}" >&2
            echo -e "${YELLOW}You'll need to configure the service manually.${NC}"
            return 1
        fi
    else
        # Convert to absolute path
        main_server_file="$(pwd)/$main_server_file"
    fi
    
    # Create user systemd service file
    local service_file="${USER_SYSTEMD_DIR}/compendium.service"
    run_with_sudo mkdir -p /etc/systemd/system
    
    # Create systemd service file in a temporary location first
    local temp_service_file="/tmp/compendium.service.$$"
    echo -e "${BLUE}Creating service file...${NC}"
    
    # Get the current working directory
    local app_dir=$(pwd)
    
    # Create the service file in a temporary location
    cat > "$temp_service_file" << EOF
[Unit]
Description=Compendium Navigation Server
After=network.target avahi-daemon.service
Wants=avahi-daemon.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$app_dir
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
    
    # Move the service file to the system directory with sudo if needed
    local service_file="/etc/systemd/system/compendium.service"
    if ! run_with_sudo cp "$temp_service_file" "$service_file"; then
        echo -e "${RED}Failed to create systemd service file${NC}" >&2
        rm -f "$temp_service_file"
        return 1
    fi
    rm -f "$temp_service_file"
    
    # Set correct permissions
    run_with_sudo chmod 644 "$service_file"
    
    # Reload systemd
    if ! run_with_sudo systemctl daemon-reload; then
        echo -e "${RED}Failed to reload systemd${NC}" >&2
        return 1
    fi
    
    # Enable and start the service
    if ! run_with_sudo systemctl enable compendium.service; then
        echo -e "${YELLOW}Failed to enable compendium service${NC}" >&2
    fi
    
    echo -e "${GREEN}Systemd service configured${NC}"
    
    # Only try to start the service if we're running as root or with sudo
    if [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null; then
        echo -e "${YELLOW}Starting Compendium service...${NC}"
        
        if run_with_sudo systemctl start compendium.service; then
            echo -e "${GREEN}Compendium service started successfully${NC}"
            echo -e "${BLUE}Service status:${NC}"
            run_with_sudo systemctl status compendium.service --no-pager || true
        else
            echo -e "${RED}Failed to start Compendium service${NC}" >&2
            run_with_sudo journalctl -u compendium -n 20 --no-pager || true
            return 1
        fi
    else
        echo -e "${YELLOW}Run the following commands to start the service:${NC}"
        echo "  sudo systemctl start compendium.service"
        echo "  sudo systemctl status compendium.service"
    fi
    
    return 0
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
    run_with_sudo ufw allow $HTTP_PORT/tcp
    
    # Allow WebSocket
    run_with_sudo ufw allow $WS_PORT/tcp
    
    # Enable firewall
    echo "y" | run_with_sudo ufw enable
    
    echo -e "${GREEN}Firewall configured${NC}"
    echo -e "${YELLOW}Firewall status:${NC}"
    run_with_sudo ufw status
}

# Health check
health_check() {
    echo -e "${BLUE}Running health checks...${NC}"
    local all_checks_passed=true
    
    # Check if service is running (only if we have permission)
    if systemctl is-active --quiet compendium.service 2>/dev/null || \
       run_with_sudo systemctl is-active --quiet compendium.service 2>/dev/null; then
        echo -e "${GREEN}✓ Service is running${NC}"
    else
        echo -e "${YELLOW}⚠ Service status unknown (run with sudo to check)${NC}"
        all_checks_passed=false
    fi
    
    # Check if ports are accessible
    if command -v nc &> /dev/null; then
        if nc -z 127.0.0.1 $HTTP_PORT 2>/dev/null; then
            echo -e "${GREEN}✓ HTTP port $HTTP_PORT is accessible${NC}"
        else
            echo -e "${YELLOW}⚠ HTTP port $HTTP_PORT is not accessible (is the service running?)${NC}" >&2
            all_checks_passed=false
        fi
        
        if nc -z 127.0.0.1 $WS_PORT 2>/dev/null; then
            echo -e "${GREEN}✓ WebSocket port $WS_PORT is accessible${NC}"
        else
            echo -e "${YELLOW}⚠ WebSocket port $WS_PORT is not accessible (is the service running?)${NC}" >&2
            all_checks_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ netcat (nc) not found, skipping port checks${NC}"
        all_checks_passed=false
    fi
    
    if [ "$all_checks_passed" = true ]; then
        echo -e "${GREEN}✓ All health checks passed${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠ Some health checks did not pass${NC}" >&2
        return 1
    fi
}

# Main installation function
install() {
    echo -e "${BLUE}Starting installation...${NC}"
    echo -e "${YELLOW}This installation will run without root access where possible.${NC}"
    
    # Create necessary directories
    echo -e "${BLUE}Setting up directories...${NC}"
    mkdir -p "$APP_DIR" "$BACKUP_DIR" "$DATA_DIR" "$LOG_DIR"
    chmod 755 "$APP_DIR" "$BACKUP_DIR" "$DATA_DIR" "$LOG_DIR"
    
    # Verify we're in the right directory
    verify_repository || return 1
    
    # Check system requirements
    check_root
    initialize_ports
    validate_config
    
    # Install system dependencies (may need root)
    install_dependencies || {
        echo -e "${YELLOW}Some dependencies might not have been installed. Continuing anyway...${NC}"
    }
    
    # Configure environment
    configure_environment
    
    # Install npm dependencies
    echo -e "${BLUE}Installing npm dependencies...${NC}"
    if ! npm install; then
        echo -e "${RED}Failed to install npm dependencies${NC}" >&2
        return 1
    fi
    
    # Setup systemd service (user mode)
    setup_systemd_service
    
    # Configure firewall (just informs user about required ports)
    configure_firewall
    
    # Get network info
    local ip_address
    ip_address=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    local hostname
    hostname=$(hostname 2>/dev/null || echo "localhost")
    
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
    echo -e "${BLUE}Updating Compendium Navigation Server...${NC}"
    
    # Stop service if running
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${BLUE}Stopping compendium service...${NC}"
        systemctl --user stop compendium.service
    fi
    
    # Backup existing installation
    backup_existing
    
    # Update repository
    echo -e "${BLUE}Updating repository...${NC}"
    if ! git pull; then
        echo -e "${YELLOW}Warning: Failed to update repository. Continuing with existing files...${NC}"
    fi
    
    # Update dependencies
    echo -e "${BLUE}Updating dependencies...${NC}"
    if ! npm install; then
        echo -e "${YELLOW}Warning: Failed to update some dependencies. The application might not work correctly.${NC}"
    fi
    
    # Start service
    echo -e "${BLUE}Starting compendium service...${NC}"
    if ! systemctl --user start compendium.service; then
        echo -e "${YELLOW}Warning: Failed to start the service automatically.${NC}"
        echo -e "${YELLOW}You can try starting it manually with: systemctl --user start compendium.service${NC}"
    fi
    
    # Show service status
    echo -e "\n${BLUE}Service status:${NC}"
    systemctl --user status compendium.service --no-pager || true
    
    echo -e "\n${GREEN}Update completed!${NC}"
    echo -e "${YELLOW}The Compendium Navigation Server has been updated.${NC}"
    
    return 0
}

# Uninstall function
uninstall() {
    echo -e "${BLUE}Uninstalling Compendium Navigation Server...${NC}"
    
    # Stop and disable user service
    if systemctl --user is-active --quiet compendium.service; then
        echo -e "${BLUE}Stopping compendium user service...${NC}"
        systemctl --user stop compendium.service
    fi
    
    if systemctl --user is-enabled --quiet compendium.service; then
        echo -e "${BLUE}Disabling compendium user service...${NC}"
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
    
    echo -e "\n${GREEN}Uninstallation completed successfully!${NC}"
    echo -e "${YELLOW}Note: User data and backups have been preserved in:${NC}"
    echo -e "- Data: $DATA_DIR"
    echo -e "- Logs: $LOG_DIR"
    echo -e "- Backups: $BACKUP_DIR"
    
    echo -e "\n${YELLOW}To completely remove all traces, you can run:${NC}"
    echo -e "  rm -rf \"$DATA_DIR\" \"$LOG_DIR\" \"$BACKUP_DIR\""
    
    return 0
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