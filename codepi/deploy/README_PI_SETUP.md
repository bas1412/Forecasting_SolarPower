# Pi allcode latest

This package contains the current Raspberry Pi uploader for the Solar Dashboard.

Current image mode:
- Camera: Pi Camera Module 3 Wide
- Add-on lens: removed
- Capture size: 1280 x 960
- JPEG quality: 90
- Image enhancement: disabled
- Dataset phase: bare_camera3_wide_collection
- Cloud coverage: experimental OpenCV HSV blue-sky-mask indicator

Copy `allcode.py` to `/home/raspberrypi/Desktop/work/allcode.py`, then restart the service.

```bash
cd /home/raspberrypi/Desktop/work/pi-allcode-latest
bash stop_old_allcode.sh
cp allcode.py /home/raspberrypi/Desktop/work/allcode.py
cd /home/raspberrypi/Desktop/work
source venv/bin/activate
python allcode.py --target-ip 192.168.1.41 --once
sudo systemctl start solar-monitor.service
journalctl -u solar-monitor.service -f
```

Expected test log:
- `HW OK ...`
- `TX D OK ...`
- `TX F OK ...`
- `IMG D OK ...`
- `IMG F OK ...`
- No `IMG ENH OK` because enhancement is intentionally disabled.

