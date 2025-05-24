#!/bin/bash
# deploy-to-pi.sh - Local script to deploy Compendium to Raspberry Pi
# This script runs on your local machine and deploys to the Pi

# Configuration
PI_HOSTNAME="compendium.local"
PI_FALLBACK_IP="192.168.68.66"
PI_USER="pi"
PI_APP_DIR="~/compendium"
REPO_OWNER="base-zz"
REPO_NAME="compendiumnav2-server"
USE_GITHUB_RELEASE=true  # Set to false to use direct deployment instead

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Compendium deployment to Raspberry Pi...${NC}"

# Step 1: Pull latest changes locally
echo -e "${YELLOW}Pulling latest changes from GitHub...${NC}"
git pull

# Check if we should use GitHub releases
if [ "$USE_GITHUB_RELEASE" = true ]; then
  echo -e "${YELLOW}Checking for latest GitHub release...${NC}"
  
  # Get the latest release info
  RELEASE_INFO=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest")
  
  # Check if we got a valid response
  if [ -z "$RELEASE_INFO" ] || [[ "$RELEASE_INFO" == *"Not Found"* ]]; then
    echo -e "${YELLOW}No GitHub release found, falling back to direct deployment${NC}"
    USE_GITHUB_RELEASE=false
  else
    # Extract release information
    RELEASE_TAG=$(echo "$RELEASE_INFO" | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
    RELEASE_URL=$(echo "$RELEASE_INFO" | grep -o '"browser_download_url": "[^"]*' | cut -d'"' -f4)
    
    if [ -z "$RELEASE_URL" ]; then
      echo -e "${YELLOW}No download URL found in the release, falling back to direct deployment${NC}"
      USE_GITHUB_RELEASE=false
    else
      echo -e "${GREEN}Found release: $RELEASE_TAG${NC}"
      
      # Create a temporary directory for the release
      TEMP_DIR=$(mktemp -d)
      
      # Download the release
      echo -e "${YELLOW}Downloading release package...${NC}"
      curl -L -o "$TEMP_DIR/compendium-deploy.tar.gz" "$RELEASE_URL"
      
      # Extract the package
      echo -e "${YELLOW}Extracting package...${NC}"
      tar -xzf "$TEMP_DIR/compendium-deploy.tar.gz" -C "$TEMP_DIR"
    fi
  fi
fi

# Step 2: Resolve Pi hostname
echo -e "${YELLOW}Resolving Raspberry Pi hostname...${NC}"
PI_IP=$(avahi-resolve-host-name $PI_HOSTNAME 2>/dev/null | awk '{print $2}' || echo "")

if [ -z "$PI_IP" ]; then
  echo -e "${YELLOW}Could not resolve $PI_HOSTNAME - using fallback IP $PI_FALLBACK_IP${NC}"
  PI_IP=$PI_FALLBACK_IP
else
  echo -e "${GREEN}Resolved $PI_HOSTNAME to $PI_IP${NC}"
fi

# Step 3: Get sensitive values from .env.secret
echo -e "${YELLOW}Reading sensitive values...${NC}"
if [ -f ".env.secret" ]; then
  TOKEN_SECRET=$(grep '^TOKEN_SECRET=' ".env.secret" | cut -d= -f2)
  VITE_TOKEN_SECRET=$(grep '^VITE_TOKEN_SECRET=' ".env.secret" | cut -d= -f2)
  echo -e "${GREEN}Found sensitive values in .env.secret${NC}"
else
  echo -e "${YELLOW}No .env.secret file found, using placeholder values${NC}"
  TOKEN_SECRET="placeholder_token_secret_to_be_replaced"
  VITE_TOKEN_SECRET="placeholder_vite_token_secret_to_be_replaced"
fi

# If not using GitHub release, create .env file manually
if [ "$USE_GITHUB_RELEASE" = false ]; then
  echo -e "${YELLOW}Creating .env file...${NC}"
  cat > .env.deploy << EOF
NODE_ENV=production
PORT=3001
INTERNAL_PORT=3002
AUTH_PORT=3003
FRONTEND_URL=http://$PI_IP:3000
DEBUG=false
REQUIRE_AUTH=false
TOKEN_EXPIRY=86400
VPS_WS_PORT=443
VPS_PATH=/relay
VPS_HOST=compendiumnav.com
DIRECT_WS_PORT=3009
DIRECT_WS_HOST=0.0.0.0
SIGNALK_URL=http://openplotter.local:3000/signalk
SIGNALK_TOKEN=
SIGNALK_ADAPTER=
RECONNECT_DELAY=3000
MAX_RECONNECT_ATTEMPTS=10
UPDATE_INTERVAL=5000
VPS_HOST=compendiumnav.com
VPS_PATH=/relay
VPS_WS_PORT=3002
RELAY_ENV_PATH=.env.server
VPS_PING_INTERVAL=25000
VPS_CONNECTION_TIMEOUT=30000
MAX_RETRIES=5
MOCK_MODE=false
FALLBACK_TO_MOCK=true
ALLOWED_ORIGINS=*
# Using key-based authentication (no TOKEN_SECRET needed)
DATABASE_PATH=./signalk_dev.db
EOF
  echo -e "${GREEN}Created .env file with required parameters${NC}"
else
  # If using GitHub release, update the .env file with sensitive values
  echo -e "${YELLOW}Updating .env file with sensitive values...${NC}"
  cp "$TEMP_DIR/.env" .env.deploy
  
  # Remove any TOKEN_SECRET entries to use key-based authentication
  sed -i "/^TOKEN_SECRET=/d" .env.deploy
  sed -i "/^VITE_TOKEN_SECRET=/d" .env.deploy
  echo -e "${GREEN}Removed TOKEN_SECRET to enable secure key-based authentication${NC}"
  
  echo -e "${GREEN}Updated .env file with sensitive values${NC}"
fi

# Step 4: Test SSH connection
echo -e "${YELLOW}Testing SSH connection to $PI_IP...${NC}"
if ssh -o ConnectTimeout=5 $PI_USER@$PI_IP "echo SSH connection successful" > /dev/null 2>&1; then
  echo -e "${GREEN}SSH connection successful${NC}"
else
  echo -e "${RED}SSH connection failed. Please check if the Pi is reachable and SSH is enabled.${NC}"
  exit 1
fi

# Step 5: Copy .env file to Pi
echo -e "${YELLOW}Copying .env file to Pi...${NC}"
scp .env.deploy $PI_USER@$PI_IP:$PI_APP_DIR/.env

# Step 6: Deploy to Pi
echo -e "${YELLOW}Deploying to Raspberry Pi...${NC}"

if [ "$USE_GITHUB_RELEASE" = true ]; then
  # Create a deployment package
  echo -e "${YELLOW}Creating deployment package...${NC}"
  DEPLOY_PACKAGE="compendium-deploy.tar.gz"
  tar -czf "$DEPLOY_PACKAGE" -C "$TEMP_DIR" .
  
  # Copy the deployment package to the Pi
  echo -e "${YELLOW}Copying deployment package to Pi...${NC}"
  scp "$DEPLOY_PACKAGE" $PI_USER@$PI_IP:/tmp/
  
  # Extract and install on the Pi
  ssh $PI_USER@$PI_IP "
    echo 'Extracting deployment package...'
    mkdir -p $PI_APP_DIR
    cd $PI_APP_DIR
    
    # Backup current .env if it exists
    if [ -f .env ]; then
      cp .env .env.backup
    fi
    
    # Extract the package
    tar -xzf /tmp/$DEPLOY_PACKAGE
    
    # Copy the new .env file
    mv /tmp/.env.deploy .env
    
    # Install dependencies
    npm install
    
    # Restart the service
    systemctl --user restart compendium
  "
  
  # Clean up
  rm -f "$DEPLOY_PACKAGE"
  rm -rf "$TEMP_DIR"
else
  # Use direct deployment
  ssh $PI_USER@$PI_IP "
    cd $PI_APP_DIR
    git pull
    npm install
    systemctl --user restart compendium
  "
fi

echo -e "${GREEN}Deployment completed successfully!${NC}"
echo -e "${YELLOW}Checking service status...${NC}"
ssh $PI_USER@$PI_IP "systemctl --user status compendium"
