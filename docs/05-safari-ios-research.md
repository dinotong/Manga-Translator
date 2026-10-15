# Safari / iOS — ทำได้ไหม และต้องแลกอะไร

> วิจัย 2026-10-08 · ยังไม่ได้ลองบนเครื่องจริงเลย ทุกข้อเป็นข้อมูลจากเอกสาร/รายงานของคนอื่น
> คำถาม: เอาส่วนเสริมนี้ไปอ่านมังงะบน iPhone ได้ไหม

## สรุปสั้น

**ทำได้ในทางหลักการ แต่ไม่ใช่การ "แปลงไฟล์แล้วจบ"** — ต้องรื้อส่วนที่หนักที่สุดของสถาปัตยกรรม
(ที่รันโมเดลตรวจกล่อง) และมีค่าใช้จ่ายรายปีกับเครื่อง Mac เป็นเงื่อนไขขั้นต่ำ

## Safari extension ทำกันยังไง

- Safari ใช้มาตรฐาน WebExtension เดียวกับ Chrome แต่**ต้องห่อเป็นแอป** — ส่วนเสริมอยู่ในแอป iOS/macOS แล้วผู้ใช้เปิดใช้ในตั้งค่า Safari
- เครื่องมือหลักคือ `xcrun safari-web-extension-converter` (มากับ Xcode) แปลงโฟลเดอร์ส่วนเสริม Chrome เป็นโปรเจกต์ Xcode และ**รายงานว่าฟีเจอร์ไหนใช้ไม่ได้**
- Apple มีตัวแพ็กผ่านเว็บ App Store Connect ที่อ้างว่าไม่ต้องมี Mac แต่มีรายงานจากนักพัฒนาว่าอัปโหลด build ของ Chrome แล้วติด error ที่แก้ได้ด้วย Xcode บน Mac เท่านั้น
- แจกต้องผ่าน App Store → ต้องสมัคร **Apple Developer Program ประมาณ 99 USD/ปี** · ไอคอนต้องมี 512 และ 1024 px เพิ่ม
- WXT (ตัว build ที่เราใช้) build เป้าหมาย Safari ได้ แต่ขั้นห่อเป็นแอปยังต้องใช้ Xcode

## ชนกับสถาปัตยกรรมเราตรงไหน

| ส่วนของเรา | บน Safari iOS | ผลกระทบ |
|---|---|---|
| **Offscreen Document** รันโมเดลตรวจกล่อง | ไม่พบหลักฐานว่า Safari มี `chrome.offscreen` | 🔴 **ต้องย้ายที่รันโมเดล** — ไปอยู่ใน content script หรือหน้าในส่วนเสริม |
| Service worker เป็นศูนย์กลางคิว/แคช/ยิง Gemini | iOS จำกัดหน่วยความจำของ background เข้มมาก มีรายงานว่า worker ถูกฆ่าแล้วไม่กลับมาจนกว่าจะปิด-เปิดส่วนเสริมใหม่ (iOS 17.4–17.6) | 🔴 ห้ามถือ ONNX/wasm ไว้ใน background · ต้องรับมือ worker หายกลางคัน |
| WebGPU | **มีใน Safari 26 (iOS 26)** แล้ว | 🟢 ตัวตรวจกล่องอาจเร็วพอ — ต้องวัดบนเครื่องจริง |
| คลิกขวา "แปลรูปนี้" (`contextMenus`) | มือถือไม่มีคลิกขวา | 🟠 ใช้แปลอัตโนมัติอย่างเดียว หรือทำปุ่มในหน้า |
| ชี้เมาส์เพื่อจางกล่อง | จอสัมผัสไม่มี hover | 🟠 ต้องเปลี่ยนเป็นแตะค้าง/แตะ |
| สิทธิ์ทุกเว็บ | Safari ให้ผู้ใช้อนุญาตทีละเว็บ | 🟢 ไม่เสีย — เราทำงานแยกรายเว็บอยู่แล้ว |
| **site profile เว็บผู้ใหญ่** | App Store เข้มเรื่องเนื้อหาผู้ใหญ่กว่า Chrome Web Store มาก | 🔴 **ขัดกับที่ตัดสินไว้ว่าจะเก็บ profile นี้** — มีโอกาสสูงที่รีวิวไม่ผ่าน |

## ทางเลือก เรียงจากถูกไปแพง

1. **ลองผ่านเบราว์เซอร์ Orion (Kagi) บน iOS ก่อน** — Orion บน iPhone ติดตั้งส่วนเสริม Chrome ได้ (รองรับ API บางส่วน) **ไม่ต้องมี Mac ไม่ต้องจ่ายค่า Apple** ใช้เป็นการทดลองว่าตัวตรวจกล่อง + overlay รันบน iPhone ไหวไหม ก่อนลงทุนจริง · ต้องตรวจเองว่า Orion รองรับ offscreen หรือไม่ ซึ่งเป็นไปได้สูงว่าไม่
2. **Safari บน Mac ก่อน iOS** — ถ้ามี Mac ใช้ทดสอบเรื่อง offscreen/การย้ายโมเดลได้ง่ายกว่า แล้วค่อยลง iPhone
3. **พอร์ตเต็มไป Safari iOS** — Mac + Xcode + 99 USD/ปี + รื้อส่วน offscreen + ปรับ UI จอสัมผัส + ตัดสินใจเรื่อง site profile ผู้ใหญ่สำหรับ App Store

## งานที่ต้องทำในโค้ดถ้าจะไปทางนี้ (ประเมินคร่าวๆ)

- แยก "ที่รันโมเดล" ออกเป็น interface ที่เลือกได้: Offscreen (Chrome) / content script (Safari) — ตรรกะใน `core/` ไม่ต้องแตะ เพราะเป็น pure function อยู่แล้ว
- ทำให้ background ทนการถูกฆ่า: คิวกับสถานะต้องฟื้นจาก storage ได้
- ทริกเกอร์แบบแตะสำหรับจอสัมผัส
- ทดสอบหน่วยความจำบน iPhone จริงที่ RAM น้อย (simulator ไม่จำลองการถูกฆ่า)

## ที่ยังไม่รู้ และวิธีหาคำตอบ

- Safari รองรับ offscreen หรือไม่ — เอกสาร Apple หน้า "Assessing your Safari web extension's browser compatibility" ดึงเนื้อหามาอ่านไม่ได้ · วิธีที่แน่นอนคือรัน converter แล้วดูรายงาน
- onnxruntime-web WebGPU บน iPhone ใช้ได้จริงไหม และกินหน่วยความจำเท่าไร — ไม่พบรายงานใครทดสอบ
- CSP ของเว็บมังงะจะกันการคอมไพล์ wasm ใน content script ไหม (ถ้าย้ายโมเดลไปที่นั่น)

## แหล่งข้อมูล

- [Chrome extension → Safari web extension packager (Apple Developer Forums)](https://developer.apple.com/forums/thread/802966)
- [Converting Chrome Extensions to Safari](https://rxliuli.com/blog/convert-chrome-extension-to-safari)
- [How to quickly convert Chrome extensions to Safari — Evil Martians](https://evilmartians.com/chronicles/how-to-quickly-and-weightlessly-convert-chrome-extensions-to-safari)
- [Converting a Chrome extension to Safari — Pieces](https://pieces.app/blog/converting-a-dart-google-chrome-extension-to-a-safari-extension)
- [Meet Safari Web Extensions (WWDC20 notes)](https://wwdcnotes.com/notes/wwdc20/10665/)
- [Chrome offscreen API reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [WebGPU is now supported in major browsers — web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
- [WebGPU in iOS 26 — App Developer Magazine](https://appdevelopermagazine.com/webgpu-in-ios-26/)
- [Safari Extension Service Worker permanently killed on iOS 17.4–17.6](https://developer.apple.com/forums/thread/758346)
- [Service worker killed under memory pressure (Apple Developer Forums)](https://developer.apple.com/forums/thread/721222)
- [iOS Safari Extension memory limit (Apple Developer Forums)](https://developer.apple.com/forums/thread/687642)
- [Apple now charges Safari extension developers for distribution — Computerworld](https://www.computerworld.com/article/2933694/apple-now-charges-safari-extension-developers-for-distribution.html)
