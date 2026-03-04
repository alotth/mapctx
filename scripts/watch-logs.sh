#!/bin/bash
# Script para monitorar logs em tempo real
# Usage: ./scripts/watch-logs.sh [log-file]

LOG_FILE="${1:-.logs/extension.log}"

if [ ! -f "$LOG_FILE" ]; then
    echo "Log file not found: $LOG_FILE"
    echo "Creating log directory..."
    mkdir -p .logs
    touch "$LOG_FILE"
    echo "Waiting for logs... (Press Ctrl+C to exit)"
fi

echo "Watching log file: $LOG_FILE"
echo "Press Ctrl+C to exit"
echo "----------------------------------------"

tail -f "$LOG_FILE"


