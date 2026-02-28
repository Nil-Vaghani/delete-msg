#!/usr/bin/env bash
# Render build script: installs Node dependencies
# Puppeteer will download its own bundled Chromium during npm install

set -e

# Install Node dependencies
npm install
