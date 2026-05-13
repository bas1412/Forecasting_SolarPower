#!/usr/bin/env bash
set -euo pipefail

echo "Stopping old solar-monitor.service if running..."
sudo systemctl stop solar-monitor.service || true

echo "Stopping manually started allcode.py processes if any..."
pkill -f "/home/raspberrypi/Desktop/work/allcode.py" || true
pkill -f "python allcode.py" || true

echo "Current allcode.py processes:"
ps aux | grep "[a]llcode.py" || echo "No allcode.py process is running."

echo "Done. It is now safe to copy the new allcode.py."
