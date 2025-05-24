#!/bin/bash
# pi-update.sh - Script to run on the Raspberry Pi to fetch and deploy the latest package
# This script should be set up as a cron job to run periodically

# Configuration
REPO_OWNER="base-zz"
REPO_NAME="compendiumnav2-server"
APP_DIR="$HOME/compendium"
GITHUB_TOKEN="$GITHUB_TOKEN" # Set this as an environment variable on the Pi

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Checking for updates...${NC}"

# Create app directory if it doesn't exist
mkdir -p "$APP_DIR"
cd "$APP_DIR" || exit 1

# Get the current version if it exists
CURRENT_VERSION=""
if [ -f "$APP_DIR/VERSION" ]; then
  CURRENT_VERSION=$(cat "$APP_DIR/VERSION")
  echo -e "${YELLOW}Current version: $CURRENT_VERSION${NC}"
fi

# Get the latest release from GitHub
echo -e "${YELLOW}Fetching latest release information...${NC}"
if [ -z "$GITHUB_TOKEN" ]; then
  RELEASE_INFO=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest")
else
  RELEASE_INFO=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest")
fi

# Check if we got a valid response
if [ -z "$RELEASE_INFO" ] || [[ "$RELEASE_INFO" == *"Not Found"* ]]; then
  echo -e "${RED}Failed to fetch release information${NC}"
  exit 1
fi

# Extract release information
RELEASE_TAG=$(echo "$RELEASE_INFO" | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
RELEASE_URL=$(echo "$RELEASE_INFO" | grep -o '"browser_download_url": "[^"]*' | cut -d'"' -f4)

echo -e "${YELLOW}Latest release: $RELEASE_TAG${NC}"

# Check if we need to update
if [ -n "$CURRENT_VERSION" ] && [[ "$CURRENT_VERSION" == *"$RELEASE_TAG"* ]]; then
  echo -e "${GREEN}Already running the latest version${NC}"
  exit 0
fi

# Download the latest release
echo -e "${YELLOW}Downloading latest release...${NC}"
TEMP_DIR=$(mktemp -d)
curl -L -o "$TEMP_DIR/compendium-deploy.tar.gz" "$RELEASE_URL"

# Extract the package
echo -e "${YELLOW}Extracting package...${NC}"
tar -xzf "$TEMP_DIR/compendium-deploy.tar.gz" -C "$TEMP_DIR"

# Backup the current .env file if it exists
if [ -f "$APP_DIR/.env" ]; then
  echo -e "${YELLOW}Backing up current .env file...${NC}"
  cp "$APP_DIR/.env" "$APP_DIR/.env.backup"
fi

# Save sensitive values from .env.secret if it exists
if [ -f "$APP_DIR/.env.secret" ]; then
  echo -e "${YELLOW}Preserving sensitive environment variables...${NC}"
  TOKEN_SECRET=$(grep '^TOKEN_SECRET=' "$APP_DIR/.env.secret" | cut -d= -f2)
  VITE_TOKEN_SECRET=$(grep '^VITE_TOKEN_SECRET=' "$APP_DIR/.env.secret" | cut -d= -f2)
fi

# Copy the new files, preserving the .env file
echo -e "${YELLOW}Installing new files...${NC}"
rsync -av --exclude='.git' --exclude='node_modules' "$TEMP_DIR/" "$APP_DIR/"

# Update the .env file with preserved sensitive values
if [ -f "$APP_DIR/.env" ]; then
  echo -e "${YELLOW}Updating .env with sensitive values...${NC}"
  
  if [ -n "$TOKEN_SECRET" ]; then
    sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=$TOKEN_SECRET|" "$APP_DIR/.env"
  fi
  
  if [ -n "$VITE_TOKEN_SECRET" ]; then
    sed -i "s|^VITE_TOKEN_SECRET=.*|VITE_TOKEN_SECRET=$VITE_TOKEN_SECRET|" "$APP_DIR/.env"
  fi
fi

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
cd "$APP_DIR" || exit 1
npm install

# Restart the service
echo -e "${YELLOW}Restarting service...${NC}"
systemctl --user restart compendium

# Clean up
rm -rf "$TEMP_DIR"

echo -e "${GREEN}Update completed successfully!${NC}"
echo -e "${YELLOW}New version: $(cat "$APP_DIR/VERSION")${NC}"
