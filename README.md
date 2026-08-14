# Manga Translator

แปลมังงะญี่ปุ่นเป็นไทยอัตโนมัติขณะอ่านบน Chrome — ไม่ต้อง screenshot ไม่ต้อง crop ไม่ต้องกดแปลทีละหน้า

> **สถานะ:** กำลังพัฒนา · `spike/` ใช้งานได้แล้ว · `extension/` กำลังสร้าง
> ดูงานที่เหลือได้ที่ [docs/03-work-queue.md](docs/03-work-queue.md)

---

## ปัญหาที่แก้

ตัวหนังสือในมังงะเป็นส่วนหนึ่งของ**รูปภาพ** เครื่องมือแปลของเบราว์เซอร์จึงอ่านไม่เห็น
ทางแก้เดิมคือเอามือถือส่อง Google Translate Camera ที่หน้าจอคอม ซึ่งอ่านยาวๆ ไม่ไหว

## วิธีทำงาน

```
รูปในหน้าเว็บ
  → หาตำแหน่งข้อความ   PP-OCRv4 ในเบราว์เซอร์ (~120 ms, ฟรี)
  → รวมเป็น bubble      union-find + จัดลำดับอ่าน
  → อ่าน + แปล          Gemini · ทั้งหน้าใน 1 request
  → วางคำแปลทับ         Shadow DOM overlay
  → cache               ไม่ทำงานซ้ำเมื่อย้อนกลับ
```

**ทำไมแยกเป็นสองส่วนแบบนี้:** การหาตำแหน่งทำในเครื่องได้เร็วและฟรี ส่วนการอ่านตัวอักษรญี่ปุ่นในเบราว์เซอร์วัดได้ **5.27 วินาทีต่อ bubble** ซึ่งช้าเกินใช้จริงราว 10 เท่า แต่ Gemini เป็น multimodal จึงอ่านและแปลรวดเดียวได้ใน ~2.5 วินาทีต่อหน้า

เหตุผลเต็มพร้อมตัวเลขที่วัดจริงอยู่ใน [ADR-001](docs/decisions/ADR-001-ocr-runtime.md)

---

## เริ่มใช้งาน

### ส่วนขยาย Chrome

ดู [extension/INSTALL.md](extension/INSTALL.md) *(กำลังสร้าง)*

ต้องมี **Gemini API key** ของตัวเอง — ขอฟรีที่ [aistudio.google.com/apikey](https://aistudio.google.com/apikey) ไม่ต้องผูกบัตร

### เครื่องมือทดสอบบนเว็บ (`spike/`)

ลากรูปมังงะมาวาง แล้วดูผลแปลทับบนภาพ พร้อมเวลาแต่ละขั้นตอน

```bash
cd spike && npm install && npm run models && npm run dev
```

รายละเอียดใน [spike/README.md](spike/README.md)

---

## เอกสาร

| ไฟล์ | เนื้อหา |
|---|---|
| [docs/00-technical-design.md](docs/00-technical-design.md) | สถาปัตยกรรม · ข้อมูลจริงของแต่ละเว็บ · ระบบพิกัด · cache |
| [docs/01-implementation-plan.md](docs/01-implementation-plan.md) | milestone M0–M7 |
| [docs/02-local-model-selection.md](docs/02-local-model-selection.md) | โมเดล Ollama สำหรับเครื่อง 6 GB VRAM |
| [docs/03-work-queue.md](docs/03-work-queue.md) | คิวงาน + กับดักที่แก้ไปแล้ว |
| [docs/decisions/](docs/decisions/) | **ทุกการตัดสินใจพร้อมเหตุผล** และวิธีย้อนกลับ |

---

## เว็บที่รองรับ

| เว็บ | สถานะ | หมายเหตุ |
|---|---|---|
| MangaDex | ✅ | รูปเป็น `blob:` — อ่านจาก content script |
| imhentai | ✅ | CDN ข้าม origin — ดึงผ่าน service worker · เดาหน้าถัดไปได้ |
| เว็บทั่วไปที่ใช้ `<img>` | ✅ | ใช้ heuristic |
| Shonen Jump+ (Giga Viewer) | ⏳ | วาดลง canvas ที่อ่าน pixel ไม่ได้ ต้องใช้ screenshot |

---

## ขอบเขตที่ไม่ข้าม

- **ไม่ถอดรหัสมาตรการป้องกันของเว็บ** — เว็บที่สับ tile รูปเพื่อกันคัดลอก จะอ่านได้เฉพาะสิ่งที่แสดงบนจอแล้ว (หลักการเดียวกับ screen reader)
- **ไม่ยิงเซิร์ฟเวอร์รัว** — โหลดล่วงหน้าทีละคำขอ เว้นระยะ และ "โหลดทั้งตอน" ต้องกดเอง
- **ไม่ใช้ endpoint ภายในของบริการแปล** — เรียกเฉพาะ API ทางการ
- **ไม่ฝัง API key ของผู้พัฒนา** — ทุกคนใช้คีย์ของตัวเอง

## License

Apache-2.0 · โมเดลทั้งหมดที่ใช้เป็น Apache-2.0 ([manga-ocr](https://github.com/kha-white/manga-ocr), [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)) เพื่อให้แจกจ่ายต่อได้โดยไม่ติดข้อผูกมัด
