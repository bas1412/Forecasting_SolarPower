#!/usr/bin/env bash
set -euo pipefail

cd /home/raspberrypi/Desktop/work
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements-pi.txt

echo "Pi Python environment ready."
echo "Next: python test_i2c_sensortemp.py && python scan_pzem.py && python scan_wind.py"
