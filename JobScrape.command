#!/bin/bash
# Double-click launcher for the interactive wizard.
cd "$(dirname "$0")"
/opt/homebrew/bin/node --env-file-if-exists=.env src/index.ts
echo; read -p "Press Enter to close…"
