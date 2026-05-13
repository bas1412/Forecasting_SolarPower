#!/usr/bin/env bash
set -euo pipefail

TARGET_IP="${1:-192.168.1.41}"
WORK_DIR="/home/raspberrypi/Desktop/work"
PYTHON_BIN="$WORK_DIR/venv/bin/python"
APP_FILE="$WORK_DIR/allcode.py"
SERVICE_FILE="/etc/systemd/system/solar-monitor.service"

echo "Solar service installer"
echo "Target Notebook IP: $TARGET_IP"
echo "Work directory: $WORK_DIR"

if [[ ! -f "$APP_FILE" ]]; then
  echo "ERROR: missing $APP_FILE"
  echo "Copy allcode.py and the Pi transfer package files into $WORK_DIR first."
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "ERROR: missing executable Python venv at $PYTHON_BIN"
  echo "Run: cd $WORK_DIR && python3 -m venv venv && source venv/bin/activate && pip install -r requirements-pi.txt"
  exit 1
fi

cat > /tmp/solar-monitor.service <<SERVICE
[Unit]
Description=Solar Monitoring Uploader
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=raspberrypi
WorkingDirectory=$WORK_DIR
ExecStart=$PYTHON_BIN -u $APP_FILE --target-ip $TARGET_IP
Restart=always
RestartSec=5

StandardOutput=append:$WORK_DIR/solar_runtime.log
StandardError=append:$WORK_DIR/solar_runtime.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo cp /tmp/solar-monitor.service "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable solar-monitor.service
sudo systemctl restart solar-monitor.service

echo
echo "Installed service:"
sudo systemctl status solar-monitor.service --no-pager
echo
echo "Follow logs with:"
echo "journalctl -u solar-monitor.service -f"

