#!/bin/bash
# Double-click this file in Finder to launch Studio.
# First run installs dependencies automatically (needs Node.js from nodejs.org).
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then run this again."
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (one-time, ~1 min)..."
  npm install
fi

npm start
