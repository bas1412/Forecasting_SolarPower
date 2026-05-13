# โครงสร้าง Repository สำหรับอ้างอิงในเล่ม

Repository นี้ถูกจัดโครงสร้างเพื่อให้อธิบายได้ง่ายทั้งใน GitHub และในภาคผนวกของเล่ม โดยแบ่งเป็น 3 ส่วนหลักดังนี้

## 1. หน้าบ้าน (Frontend)
อยู่ในโฟลเดอร์ `frontend/`

หน้าที่หลัก:
- แสดงข้อมูลเซ็นเซอร์แบบเรียลไทม์
- แสดงข้อมูลย้อนหลังในหน้า History
- แสดงภาพท้องฟ้าและผลการประมวลผลภาพ
- แสดงผลพยากรณ์กำลังไฟฟ้าล่วงหน้า

ไฟล์สำคัญ:
- `frontend/src/pages/Dashboard.tsx`
- `frontend/src/pages/History.tsx`

## 2. หลังบ้าน (Backend)
อยู่ในโฟลเดอร์ `backend/`

หน้าที่หลัก:
- รับข้อมูลจาก Raspberry Pi ผ่าน API
- ตรวจสอบและจัดรูปแบบข้อมูล
- จัดเก็บข้อมูลแบบ time series
- รองรับการประมวลผลและเรียกใช้แบบจำลองพยากรณ์

โฟลเดอร์สำคัญ:
- `backend/fastapi_service/`
- `backend/server/`
- `backend/ml/`
- `backend/shared/`
- `backend/drizzle/`

## 3. โค้ดของ Raspberry Pi (CodePi)
อยู่ในโฟลเดอร์ `codepi/`

หน้าที่หลัก:
- อ่านค่า PZEM-004T และเซ็นเซอร์สภาพแวดล้อม
- บันทึกภาพจาก Raspberry Pi Camera Module 3
- ประทับเวลาและซิงโครไนซ์ข้อมูล
- ส่งข้อมูลไปยัง FastAPI

ไฟล์สำคัญ:
- `codepi/allcode.py`
- `codepi/solar-monitor.service`
- `codepi/deploy/`

## ลิงก์ Repository
- Repository URL: `https://github.com/bas1412/Forecasting_SolarPower`

ไฟล์นี้สามารถคัดลอกเนื้อหาไปใช้ในภาคผนวก ก หรือใช้เป็นคำอธิบายในหน้าแรกของ GitHub repository ได้
