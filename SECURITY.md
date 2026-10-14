# Security Policy / นโยบายความปลอดภัย

## แจ้งช่องโหว่ (Reporting a vulnerability)

กรุณาแจ้งปัญหาด้านความปลอดภัย**แบบส่วนตัว** ผ่าน GitHub:
แท็บ **Security → Report a vulnerability** (Private vulnerability reporting เปิดไว้แล้ว)
หรือเข้าตรงที่ <https://github.com/dinotong/Manga-Translator/security/advisories/new>

**อย่าเปิด public Issue** สำหรับช่องโหว่ เพราะคนอื่นจะเห็นก่อนที่จะแก้ทัน

Please report security issues privately via GitHub's "Report a vulnerability" (Security tab,
private vulnerability reporting) at the link above, not through public issues.

## เวอร์ชันที่รองรับ (Supported versions)

เฉพาะ [รุ่นล่าสุด](https://github.com/dinotong/Manga-Translator/releases/latest) เท่านั้น
Only the latest release receives fixes.

## ขอบเขต (Scope notes)

- API key ของ Gemini เป็นของผู้ใช้เอง และเก็บใน `chrome.storage.local` **แบบไม่เข้ารหัส** โดยการออกแบบ
  (ส่วนเสริมไม่มีเซิร์ฟเวอร์ และไม่ฝัง key ของผู้พัฒนา) — เรื่องนี้ไม่นับเป็นช่องโหว่
  แต่ถ้าพบวิธีที่ทำให้ key รั่วออกนอกเครื่อง (เช่น ติดไปกับ log, diagnostics, หรือคำขอที่ไม่ใช่ Gemini) ถือว่าอยู่ในขอบเขต
- The user's own Gemini API key is stored unencrypted in `chrome.storage.local` by design
  (no server, no developer key bundled). That alone is not a vulnerability; any path that leaks the key
  off the machine (logs, diagnostics, requests to anything other than Gemini) is in scope.
