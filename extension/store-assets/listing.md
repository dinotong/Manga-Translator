# Chrome Web Store listing — ข้อความสำหรับคัดลอกวาง

ภาษาหลักของหน้าร้าน: **ไทย** (ผู้สั่งงานตัดสิน 2026-10-09) · ภาษาที่สอง: อังกฤษ
ห้ามเอ่ยชื่อเว็บผู้ใหญ่ในหน้าร้าน (CHROMEWEBSTORE.md) · ภาพหน้าจอใช้หน้าตัวอย่างของเราเองเท่านั้น

## ไทย

**ชื่อ:** Manga Translator

**สรุปสั้น** (≤132 ตัวอักษร):

> แปลมังงะญี่ปุ่นและอังกฤษเป็นไทยบนหน้าเว็บที่อ่านอยู่ วางคำแปลทับบอลลูนเดิม ไม่ต้องแคปหน้าจอหรือกดแปลทีละหน้า

**คำอธิบาย:**

> อ่านมังงะภาษาญี่ปุ่นหรืออังกฤษบนเว็บได้เป็นภาษาไทย โดยไม่ต้องแคปหน้าจอ ไม่ต้องครอปรูป และไม่ต้องกดแปลทีละหน้า
>
> เปิดสวิตช์ครั้งเดียวต่อเว็บ แล้วเลื่อนอ่านตามปกติ ส่วนเสริมจะหาบอลลูนคำพูดในรูป แปล แล้ววางคำแปลไทยทับตำแหน่งเดิมให้เอง
>
> ทำอะไรได้บ้าง
> • แปลอัตโนมัติแยกเป็นรายเว็บ หรือคลิกขวาที่รูปแล้วเลือก "แปลรูปนี้" ได้ทุกเว็บ
> • แปลหน้าถัดไปรอไว้ล่วงหน้าบนเว็บที่เปลี่ยนหน้าแบบคาดเดาได้
> • ตรวจภาษาต้นทางเองจากตัวอักษรในรูป
> • ชี้เมาส์ที่กล่องคำแปลเพื่อให้จางลงและเห็นภาพเดิม
> • ปรับขนาดตัวอักษรและความทึบของกล่องได้
> • หน้าที่เคยแปลแล้วเปิดซ้ำขึ้นทันทีจากแคชในเครื่อง
>
> ใช้งานอย่างไร
> ส่วนเสริมใช้ Google Gemini ในการอ่านและแปล คุณต้องใส่ API key ของตัวเอง ซึ่งขอได้ฟรีที่ Google AI Studio ไม่ต้องผูกบัตร หน้าตั้งค่าจะเปิดขึ้นมาให้ใส่ตั้งแต่ติดตั้งเสร็จ
>
> ความเป็นส่วนตัว
> • การหาตำแหน่งบอลลูนทำในเครื่องของคุณ
> • ส่วนที่ส่งออกไปมีแค่ภาพส่วนที่มีข้อความ ส่งตรงไป Google Gemini ด้วย key ของคุณ และเฉพาะตอนแปลเท่านั้น
> • ผู้พัฒนาไม่มีเซิร์ฟเวอร์และไม่เก็บข้อมูลใดๆ ของคุณ
> • key ตั้งค่า และแคช อยู่ในเครื่องของคุณเท่านั้น
>
> โอเพนซอร์ส (Apache-2.0): https://github.com/dinotong/Manga-Translator
> แจ้งปัญหา: https://github.com/dinotong/Manga-Translator/issues

## English

**Summary** (≤132 chars):

> Translates Japanese and English manga into Thai on the page, over the original speech bubbles. No screenshots, no per-page clicks.

**Description:**

> Read Japanese or English manga on the web in Thai, without taking screenshots, cropping, or pressing Translate on every page.
>
> Switch it on once per site and keep reading. The extension finds the speech bubbles in each image, translates them, and draws the Thai text over the originals.
>
> Features
> • Automatic translation per site, or right-click any image and choose "Translate this image" on any site
> • Translates upcoming pages ahead of time on sites with predictable page URLs
> • Detects the source language from the text in the image
> • Hover a translation to fade it and see the art underneath
> • Adjustable text size and panel opacity
> • Pages translated before reopen instantly from a local cache
>
> How it works
> Reading and translation use Google Gemini with your own API key, free from Google AI Studio with no card required. The settings page opens on install so you can add it.
>
> Privacy
> • Bubble detection runs on your device
> • Only the image regions that contain text are sent, directly to Google Gemini with your key, and only when translating
> • The developer runs no server and collects nothing
> • Your key, settings and cache stay on your device
>
> Open source (Apache-2.0): https://github.com/dinotong/Manga-Translator
> Issues: https://github.com/dinotong/Manga-Translator/issues

## ไฟล์ภาพ (อัปโหลดตามลำดับนี้)

| ช่อง | ไฟล์ |
|---|---|
| ไอคอน 128×128 | `../public/icon/128.png` |
| ภาพหน้าจอ 1 | `screenshot-1-1280x800.png` — หน้ามังงะที่แปลแล้ว |
| ภาพหน้าจอ 2 | `screenshot-2-1280x800.png` — เปิดสวิตช์ต่อเว็บจาก popup |
| ภาพหน้าจอ 3 | `screenshot-3-1280x800.png` — ใส่ key ของตัวเองในหน้าตั้งค่า |
| Small promo tile 440×280 | `promo-small-440x280.png` |

ทุกภาพถ่ายบนหน้าตัวอย่างที่วาดเอง (`sample-page.html`) · label ของ key ในภาพ 3 เปลี่ยนเป็น "key 1-3" เฉพาะบนจอตอนถ่าย ไม่ได้บันทึก

## ช่องอื่นในฟอร์ม

- หมวดหมู่: Productivity
- ภาษา: ไทย
- เว็บไซต์ทางการ: https://github.com/dinotong/Manga-Translator
- URL ช่วยเหลือ: https://github.com/dinotong/Manga-Translator/issues
- นโยบายความเป็นส่วนตัว: https://github.com/dinotong/Manga-Translator/blob/main/docs/privacy.md
- ข้อความในฟอร์ม Privacy practices: ดู [../CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md)
