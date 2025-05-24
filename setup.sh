#!/bin/bash
# setup.sh - Script to set up the Compendium Navigation Server

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
VPS_URL="https://compendiumnav.com"

echo -e "${GREEN}Compendium Navigation Server Setup${NC}"
echo -e "${YELLOW}This script will help you set up your environment${NC}"

# Check if .env file already exists
if [ -f .env ]; then
  echo -e "${YELLOW}An .env file already exists. Do you want to overwrite it? (y/n)${NC}"
  read -r overwrite
  if [[ ! $overwrite =~ ^[Yy]$ ]]; then
    echo -e "${GREEN}Setup cancelled. Your existing .env file was not modified.${NC}"
    exit 0
  fi
fi

# Copy example file as a starting point
echo -e "${YELLOW}Creating .env file from template...${NC}"
cp .env.example .env

echo -e "${GREEN}.env file created successfully!${NC}"
echo -e "${YELLOW}You may need to edit this file to customize settings for your environment.${NC}"
echo -e "${YELLOW}The following variables are required for the application to work:${NC}"
echo -e "  - SIGNALK_URL: URL of your SignalK server"
echo -e "  - RECONNECT_DELAY: Delay before reconnecting (default: 3000)"
echo -e "  - MAX_RECONNECT_ATTEMPTS: Maximum reconnection attempts (default: 10)"
echo -e "  - UPDATE_INTERVAL: Update interval in milliseconds (default: 5000)"

# Prompt for editing
echo -e "${YELLOW}Do you want to edit the .env file now? (y/n)${NC}"
read -r edit
if [[ $edit =~ ^[Yy]$ ]]; then
  if command -v nano &> /dev/null; then
    nano .env
  elif command -v vim &> /dev/null; then
    vim .env
  else
    echo -e "${RED}No editor found. Please edit the .env file manually.${NC}"
  fi
fi

# Generate key pair for secure authentication
echo -e "${YELLOW}Generating cryptographic key pair for secure authentication...${NC}"
node -e "import('./src/state/keyPair.js').then(({getOrCreateKeyPair}) => getOrCreateKeyPair())" || {
  echo -e "${RED}Failed to generate key pair. This will be done automatically on first run.${NC}"
}

# Register public key with VPS
echo -e "${YELLOW}Would you like to register your public key with the VPS now? (y/n)${NC}"
read -r register_key
if [[ $register_key =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}Registering public key with VPS...${NC}"
  node -e "import('./src/state/keyPair.js').then(({registerPublicKey}) => registerPublicKey('${VPS_URL}').then(result => console.log(result)))" || {
    echo -e "${RED}Failed to register public key. You can do this later by running:${NC}"
    echo -e "  node -e \"import('./src/state/keyPair.js').then(({registerPublicKey}) => registerPublicKey('${VPS_URL}'))\"" 
  }
fi

echo -e "${GREEN}Setup complete!${NC}"
echo -e "${YELLOW}You can now start the application with:${NC}"
echo -e "  npm start"
