# นโยบายความเป็นส่วนตัว — Manga Translator

ปรับปรุงล่าสุด: 8 ตุลาคม 2026

**สรุปสั้น:** เราไม่มีเซิร์ฟเวอร์ ไม่เก็บข้อมูลของคุณ และไม่เห็นข้อมูลอะไรของคุณเลย
ภาพที่จะแปลถูกส่งตรงจากเบราว์เซอร์ของคุณไปที่ Google Gemini ผ่าน API key **ของคุณเอง**

## สิ่งที่ส่วนเสริมส่งออกไปนอกเครื่อง

| ส่งอะไร | ไปที่ไหน | เมื่อไร |
|---|---|---|
| ภาพส่วนที่มีตัวหนังสือ (ตัดมาเฉพาะกรอบข้อความ ไม่ใช่ทั้งหน้า) และภาษาที่เลือก | Google Gemini API (`generativelanguage.googleapis.com`) | เมื่อคุณสั่งแปล หรือเปิดแปลอัตโนมัติไว้กับเว็บนั้น |
| API key ของคุณ | Google Gemini API ไปพร้อมกับคำขอ | ทุกคำขอแปล |

ส่วนเสริมนี้ไม่ส่งข้อมูลไปที่อื่นนอกจากนี้ ไม่มี analytics ไม่มีตัวติดตาม และไม่มีเซิร์ฟเวอร์ของผู้พัฒนา

การส่งข้อมูลให้ Google อยู่ภายใต้[ข้อกำหนดของ Gemini API](https://ai.google.dev/gemini-api/terms) ซึ่งตกลงกันระหว่างคุณกับ Google โดยตรง
**โปรดทราบ:** ถ้าใช้ free tier ข้อกำหนดของ Google อนุญาตให้ Google นำข้อมูลที่ส่งไปใช้ปรับปรุงผลิตภัณฑ์ได้

## สิ่งที่เก็บไว้ในเครื่องของคุณ

| ข้อมูล | เก็บที่ | ลบอย่างไร |
|---|---|---|
| API key และการตั้งค่า | `chrome.storage.local` ของเบราว์เซอร์ (ไม่ sync ข้ามเครื่อง) | ลบในหน้าตั้งค่า หรือถอนส่วนเสริม |
| ผลแปลที่แคชไว้ (ตำแหน่งกล่องกับข้อความ **ไม่เก็บรูป**) | IndexedDB ของส่วนเสริม | ปุ่มล้างแคชในหน้าตั้งค่า หรือถอนส่วนเสริม |
| รายชื่อเว็บที่เปิดแปลอัตโนมัติ | `chrome.storage.local` | เอาออกในหน้าตั้งค่า |

API key ถูกเก็บแบบไม่เข้ารหัส ใครที่ใช้เครื่องหรือโปรไฟล์เบราว์เซอร์นี้ได้ก็อ่านได้
แนะนำให้ใช้ key ที่ไม่ได้ผูกบัตรหรือบิล

## ทำไมต้องขอสิทธิ์เข้าถึงทุกเว็บ

- **อ่านรูปในหน้าที่คุณเปิด** รูปมังงะหลายเว็บมาจากโดเมนอื่น (CDN) ถ้าไม่มีสิทธิ์นี้ส่วนเสริมจะอ่านรูปนั้นไม่ได้
- **ส่งคำขอไปที่ Gemini API**

ส่วนเสริมจะสแกนเฉพาะเว็บที่คุณเปิดแปลอัตโนมัติไว้ หรือรูปที่คุณคลิกขวาสั่งแปลเท่านั้น
และไม่อ่านหรือบันทึกประวัติการท่องเว็บ

## ติดต่อ

แจ้งปัญหาหรือถามเรื่องความเป็นส่วนตัวได้ที่ GitHub Issues ของโปรเจกต์ (ลิงก์จะใส่เมื่อเปิดรีโปเป็นสาธารณะ)

---

## English summary (for store listings)

Manga Translator has no server and collects no data. When you ask it to translate, it sends cropped text regions of the image directly from your browser to the Google Gemini API using **your own** API key; nothing is sent anywhere else, and there is no analytics or tracking. Your API key, settings and cached translations (box positions and text only, never images) stay in your browser's local extension storage and are removed when you clear them or uninstall. The all-sites permission exists only so it can read manga images served from other domains and reach the Gemini API; it scans only sites you have switched on, or an image you right-click. Data sent to Google is governed by the Gemini API terms between you and Google; on the free tier those terms allow Google to use it to improve its products.
