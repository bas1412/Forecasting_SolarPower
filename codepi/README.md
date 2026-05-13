# CodePi (โค้ดของ Raspberry Pi)

This folder contains the code that runs directly on the Raspberry Pi field device.

## Main purpose
- read sensor values from the installed hardware
- capture sky images from Raspberry Pi Camera Module 3
- estimate cloud-related features
- send data to the backend API

## Included
- `allcode.py` main Raspberry Pi runtime
- `solar-monitor.service` service template for automatic startup
- `deploy/` helper files for deployment and environment setup on Raspberry Pi

## Notes
This folder is the **Raspberry Pi runtime / โค้ดของ Pi** part of the project.

Current backend target IP configured in this package: `192.168.1.39`
