# Raspberry Pi Setup Guide - Solarcell Dashboard

## วิธีการรัน Raspberry Pi เพื่อเก็บข้อมูลและส่งไปยังเว็บ

---

## 📋 ขั้นตอนการตั้งค่า

### 1. **ติดตั้ง Dependencies บน Raspberry Pi**

```bash
# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install Python 3 and pip
sudo apt-get install python3 python3-pip -y

# Install required Python packages
pip3 install requests pillow

# For camera support (optional)
pip3 install picamera2
```

---

## 🚀 วิธีการรันสคริปต์

### **Option 1: ส่งข้อมูลเซนเซอร์จำลอง (Mock Data)**

ใช้สำหรับทดสอบระบบโดยไม่ต้องมีเซนเซอร์จริง

```bash
# Copy ไฟล์ไปยัง Raspberry Pi
scp mock_sensor_data.py pi@<raspberry-pi-ip>:/home/pi/

# SSH เข้า Raspberry Pi
ssh pi@<raspberry-pi-ip>

# รันสคริปต์ (ส่งข้อมูลทุก 5 วินาที เป็นเวลา 5 นาที)
python3 mock_sensor_data.py \
  --url http://<your-dashboard-url> \
  --interval 5 \
  --duration 300
```

**ผลลัพธ์:**
```
======================================================================
Solar Panel Mock Sensor Data Generator
======================================================================
API URL: http://your-dashboard-url
Interval: 5 seconds
Duration: 300 seconds
Start time: 2026-03-21 17:30:00
======================================================================

✓ [17:30:05] Sensor reading sent: Power=348.5W, Voltage=228.4V, Current=7.24A, Temp=21.3°C, Humidity=68%, Pressure=1013.25hPa, Wind=1.9m/s
✓ [17:30:10] Cloud detection sent: Coverage=65%
✓ [17:30:10] Sensor reading sent: Power=356.2W, Voltage=229.1V, Current=7.31A, Temp=21.5°C, Humidity=67%, Pressure=1013.20hPa, Wind=2.1m/s
```

---

### **Option 2: อัปโหลดรูปท้องฟ้า (Sky Images)**

ใช้สำหรับอัปโหลดรูปท้องฟ้าพร้อมข้อมูลปกคลุมเมฆ

```bash
# Copy ไฟล์ไปยัง Raspberry Pi
scp upload_sky_image.py pi@<raspberry-pi-ip>:/home/pi/

# SSH เข้า Raspberry Pi
ssh pi@<raspberry-pi-ip>

# ตัวเลือก A: ใช้กล้อง Raspberry Pi Camera Module 3
python3 upload_sky_image.py \
  --url http://<your-dashboard-url>

# ตัวเลือก B: ใช้รูปจากไฟล์
python3 upload_sky_image.py \
  --url http://<your-dashboard-url> \
  --image-file /path/to/sky-image.jpg \
  --cloud-coverage 45

# ตัวเลือก C: ใช้รูปทดสอบ
python3 upload_sky_image.py \
  --url http://<your-dashboard-url> \
  --test \
  --cloud-coverage 65
```

---

## 🔄 การตั้งค่า Cron Job (ทำให้ทำงานอัตโนมัติ)

### **ส่งข้อมูลเซนเซอร์ทุก 5 นาที**

```bash
# เปิด crontab editor
crontab -e

# เพิ่มบรรทัดนี้ (ส่งข้อมูลทุก 5 นาที)
*/5 * * * * python3 /home/pi/mock_sensor_data.py --url http://<your-dashboard-url> --interval 5 --duration 280 >> /home/pi/sensor_logs.txt 2>&1

# หรือส่งข้อมูลทุกชั่วโมง
0 * * * * python3 /home/pi/mock_sensor_data.py --url http://<your-dashboard-url> --interval 60 --duration 3600 >> /home/pi/sensor_logs.txt 2>&1
```

### **อัปโหลดรูปท้องฟ้าทุก 10 นาที**

```bash
# เพิ่มบรรทัดนี้ใน crontab
*/10 * * * * python3 /home/pi/upload_sky_image.py --url http://<your-dashboard-url> >> /home/pi/image_logs.txt 2>&1
```

### **ตรวจสอบ Cron Logs**

```bash
# ดูบันทึก
tail -f /home/pi/sensor_logs.txt
tail -f /home/pi/image_logs.txt

# ดู cron jobs ที่ทำงาน
grep CRON /var/log/syslog
```

---

## 🔌 การเชื่อมต่อเซนเซอร์จริง

### **PZEM-004T (AC Power Monitor)**
- Pin 1 (5V) → Raspberry Pi 5V
- Pin 2 (GND) → Raspberry Pi GND
- Pin 3 (TX) → Raspberry Pi RX (GPIO 15)
- Pin 4 (RX) → Raspberry Pi TX (GPIO 14)

### **AHT20 + BMP280 (I2C Sensors)**
- VCC → Raspberry Pi 3.3V
- GND → Raspberry Pi GND
- SDA → Raspberry Pi GPIO 2 (SDA)
- SCL → Raspberry Pi GPIO 3 (SCL)

### **RS-FSA-N01 (Wind Speed - RS485)**
- 5V → Raspberry Pi 5V
- GND → Raspberry Pi GND
- A → RS485 Converter A
- B → RS485 Converter B

---

## 📊 ตรวจสอบข้อมูลบน Dashboard

1. เปิด Dashboard: `http://<your-dashboard-url>`
2. ไปที่ **Dashboard** tab เพื่อดูข้อมูลเซนเซอร์เรียลไทม์
3. ไปที่ **History** tab เพื่อดูข้อมูลย้อนหลัง
4. ไปที่ **Analytics** tab เพื่อดูการวิเคราะห์
5. ไปที่ **Settings** tab เพื่อตั้งค่า Alert thresholds

---

## 🐛 Troubleshooting

### **ข้อผิดพลาด: Connection refused**
```
✗ Error sending request: [Errno 111] Connection refused
```
**วิธีแก้:**
- ตรวจสอบว่า Dashboard URL ถูกต้อง
- ตรวจสอบว่า Raspberry Pi สามารถเข้าถึง Dashboard URL ได้
- ลองใช้ IP address แทน hostname

```bash
# ทดสอบการเชื่อมต่อ
curl -X POST http://<your-dashboard-url>/api/trpc/sensors.create \
  -H "Content-Type: application/json" \
  -d '{"json":{"powerWatts":100,"voltageAC":220}}'
```

### **ข้อผิดพลาด: Module not found**
```
ModuleNotFoundError: No module named 'requests'
```
**วิธีแก้:**
```bash
pip3 install requests
```

### **ข้อผิดพลาด: Camera not available**
```
⚠️  picamera2 not available. Using test image instead.
```
**วิธีแก้:**
```bash
# ติดตั้ง picamera2
pip3 install picamera2

# หรือใช้ --test flag
python3 upload_sky_image.py --url http://<your-dashboard-url> --test
```

---

## 📝 ตัวอย่างการใช้งาน

### **ตัวอย่าง 1: ส่งข้อมูลทุก 10 วินาที เป็นเวลา 1 ชั่วโมง**

```bash
python3 mock_sensor_data.py \
  --url http://192.168.1.100:3000 \
  --interval 10 \
  --duration 3600
```

### **ตัวอย่าง 2: อัปโหลดรูปท้องฟ้าพร้อมข้อมูลปกคลุมเมฆ**

```bash
python3 upload_sky_image.py \
  --url http://192.168.1.100:3000 \
  --image-file /home/pi/sky.jpg \
  --cloud-coverage 35
```

### **ตัวอย่าง 3: ตั้งค่า Cron Job เพื่อทำงานอัตโนมัติ**

```bash
# ส่งข้อมูลเซนเซอร์ทุก 5 นาที ตั้งแต่ 6:00 ถึง 18:00 ทุกวัน
*/5 6-18 * * * python3 /home/pi/mock_sensor_data.py --url http://192.168.1.100:3000 --interval 5 --duration 280
```

---

## 🎯 สรุป

| ขั้นตอน | คำสั่ง | ผลลัพธ์ |
|--------|--------|--------|
| 1. ส่งข้อมูลเซนเซอร์ | `python3 mock_sensor_data.py --url <URL>` | ข้อมูลปรากฏใน Dashboard |
| 2. อัปโหลดรูปท้องฟ้า | `python3 upload_sky_image.py --url <URL>` | รูปปรากฏใน History |
| 3. ตั้งค่า Cron Job | `crontab -e` | ทำงานอัตโนมัติตามกำหนดการ |
| 4. ตรวจสอบ Dashboard | เปิด URL ใน Browser | เห็นข้อมูลเรียลไทม์ |

---

## 📞 ติดต่อ

หากมีปัญหา โปรดตรวจสอบ:
- Logs: `/home/pi/sensor_logs.txt` และ `/home/pi/image_logs.txt`
- Dashboard Health: ไปที่ Settings → System Status
- API Status: `curl http://<your-dashboard-url>/api/health`
