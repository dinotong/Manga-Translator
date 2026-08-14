# Manga Translator — Chrome Extension (JA → TH)

Chrome Extension (MV3) ที่แปลมังงะญี่ปุ่นเป็นไทยแบบอัตโนมัติขณะ scroll อ่าน
โดยไม่ต้อง screenshot / crop / กด Translate ทีละหน้า

## เอกสารหลัก — อ่านก่อนเสมอ

- [manga-translator-project-handoff.md](manga-translator-project-handoff.md) — เจตนาและข้อกำหนดจากเจ้าของโปรเจกต์
- [docs/00-technical-design.md](docs/00-technical-design.md) — สถาปัตยกรรมที่ตัดสินใจแล้ว + assumption ที่แก้จาก handoff
- [docs/01-implementation-plan.md](docs/01-implementation-plan.md) — milestone M0–M7 และ definition of done
- [docs/02-local-model-selection.md](docs/02-local-model-selection.md) — โมเดล Ollama สำหรับ RTX 3060 6GB (ใช้ตอน M6)

> ถ้าจะเปลี่ยนอะไรที่ขัดกับ `00-technical-design.md` ให้เขียน ADR ใน `docs/decisions/` ก่อน

## สถานะปัจจุบัน

**M0 (Spike & Benchmark) — ยังไม่เริ่ม** ยังไม่มีโค้ดในโปรเจกต์
M0 เป็น gate: ผลลัพธ์ความเร็ว OCR เป็นตัวตัดสินว่า default runtime คือ WASM หรือ Local Service

## Pipeline

```
Discover → Acquire → Detect → Group → Recognize → Order → Translate → Layout → Render → Cache
```

## การตัดสินใจที่ล็อกแล้ว (อย่ารื้อโดยไม่มีเหตุผลใหม่)

| หัวข้อ | ตัดสินใจ |
|---|---|
| Detection | **PP-OCRv4 det ในเบราว์เซอร์** (Apache-2.0, 4.7 MB) — วัดแล้ว WebGPU 120 ms/หน้า · ห้ามให้ LLM เดา bbox |
| Recognition | 🔴 **manga-ocr ในเบราว์เซอร์ = 5.27 วิ/bubble ใช้ไม่ได้** (ADR-001) → default คือ **Gemini vision อ่าน+แปลรวดเดียว** |
| Gemini 2 โหมด | **vision** = ส่ง crop (เร็ว ไม่ต้อง OCR) · **text** = OCR ในเครื่องแล้วส่งข้อความ (token ต่ำ รอ sidecar) · ทั้งคู่ **1 request/หน้า** |
| Vertical reconstruction | recognizer อ่านทั้ง bubble ใน pass เดียว → **ไม่ต้องเขียน algorithm เรียงตัวอักษร** |
| Pre-warm | 🔴 บังคับ — WebGPU cold start 1.7–2.0 วิ (shader compile) ต้องรัน dummy inference ตอนเปิด toggle |
| ML runtime host | **Offscreen Document** (SW รัน ONNX ไม่ได้ — ไม่มี DOM + ถูก terminate) |
| Image acquisition | **2 ทาง เท่าเทียมกัน** — `blob:`/same-origin → content script · cross-origin tainted → SW fetch |
| เว็บเป้าหมาย #1 | **MangaDex** — `blob:` (SW fetch ไม่ได้), ไม่ tainted, 3496×4960, `object-fit: contain`, paged + long strip |
| เว็บเป้าหมาย #2 | **imhentai** — cross-origin CDN (canvas tainted → **ต้อง SW fetch**), **`<img id="gimg">` ตัวเดียวสลับ src**, URL `/view/{id}/{n}/` คาดเดาได้ → prefetch ได้ |
| Trigger | **IntersectionObserver + URL/src change** ไม่ใช่ scroll event — เว็บเป้าหมายทั้งคู่เป็น paged reader |
| Overlay binding | 🔴 ผูกกับ **`imageHash`** ไม่ใช่ element — imhentai สลับ `src` บน element เดิม ถ้าผูก element คำแปลจะค้างทับหน้าใหม่ |
| ภาษา | **ja→th (M0–M4)** · **en→th (M5)** · ko/zh อนาคต — PP-OCR det เป็น language-agnostic เปลี่ยนแค่ recognizer |
| Resolution | downscale เป็น det 1600px + rec 2048px ก่อน OCR · hash จาก bytes ต้นฉบับเสมอ |
| NSFW | ตั้ง `safetySettings: BLOCK_NONE` · `PROVIDER_REFUSED` เป็น error path ชั้นหนึ่ง · retry แยกทีละ block |
| Coordinate canonical space | **Normalized image space `[0,1]`** — ห้ามเก็บ pixel ที่ไหนใน cache |
| Overlay | Shadow DOM ที่ `document.body` + `%` + `cqw` → responsive โดยไม่ใช้ JS |
| Cache | IndexedDB **แยก 2 store**: `ocr` (key=imageHash) และ `translation` (key=sha1(ja)) |
| Reading order | ไม่ใช่ MVP — overlay วางตามพิกัด ลำดับใช้เฉพาะ LLM context |
| Translation default | **Gemini `gemini-flash-lite-latest`** — ฟรี ไม่ต้องผูกบัตร · batch ทั้งหน้า = 1 req<br>🔴 **ห้าม pin เวอร์ชัน** — `gemini-2.5-flash-lite` โดนปิดสำหรับผู้ใช้ใหม่แล้ว (404) ใช้ alias `-latest` เสมอ |
| Translation local | Ollama (ผู้ใช้มี NVIDIA RTX) — ใช้ prompt/validator ชุดเดียวกับ Gemini |
| License | ต้องเป็น **Apache-2.0 ล้วน** เพราะจะแจกให้เพื่อน · `TextDetector` และ `OCRProvider` ต้อง pluggable |
| Hardware baseline | NVIDIA RTX/GTX → WebGPU น่าจะไหว, CUDA sidecar เป็น fallback ที่ดี |

## กฎเหล็ก

- ❌ **ห้าม** OCR ทุก scroll event — ใช้ IntersectionObserver + scheduler + debounce
- ❌ **ห้าม** ใส่ CSS selector ของเว็บใดเว็บหนึ่งลงใน `core/` หรือ `detector/scan.ts` → ไปที่ `site-profiles/`
- ❌ **ห้าม** ห่อ/แก้ DOM ของเว็บ — overlay ต้องอยู่ใน Shadow DOM ของเราเท่านั้น
- ❌ **ห้าม** ใช้ `googletrans` / `translate_a/single` / endpoint ภายในของ Google Translate — ผิด ToS + โดนแบน IP
- ❌ **ห้าม** ฝัง API key ของ developer ลง extension — ผู้ใช้ทุกคนใส่ key ของตัวเอง
- ❌ **ห้าม** ใช้โมเดล GPL/AGPL (comic-text-detector, YOLOv8) ใน default bundle เพราะจะแจกจ่าย
- ❌ **ห้าม** ส่ง base64 ระหว่าง context — ใช้ `ArrayBuffer` transferable
- ❌ **ห้าม** เก็บ OCR result ใน `chrome.storage.local` — ใช้ IndexedDB
- ❌ **ห้าม** hardcode `'ja'` / `'th'` ที่ไหนเลย — ใช้ `LangCode` เป็น parameter เสมอ (`from`/`to` เข้า cache key ด้วย)
- ❌ **ห้าม** ผูก overlay กับ DOM element — ผูกกับ `imageHash` เท่านั้น
- ❌ **ห้าม** prefetch รัวๆ — ≤ 1 req พร้อมกัน, เว้น ≥ 500 ms, lookahead default 3 หน้า
- ✅ ตรรกะยากทั้งหมดต้องอยู่ใน `core/` เป็น **pure function + unit test**
- ✅ ทุก milestone ต้องพิสูจน์บนเว็บมังงะจริง ไม่ใช่แค่ test ผ่าน

## Settings surfaces (design §15.5)

- **Popup** = toggle/โหมด/ภาษาเรื่องนี้ · **Options** = API key, Ollama, OCR runtime, display, cache · **Diagnostics** = ปุ่มเดียวเช็คทุกอย่าง
- เก็บใน **`chrome.storage.local`** เท่านั้น (ไม่ใช้ `sync` — API key ไม่ควรวิ่งข้ามเครื่อง + เพดาน 8 KB)
- `Settings.version` + migration ตั้งแต่ M3 · **เขียนช่อง Ollama ลง schema ตั้งแต่ M3** แม้ยัง disabled จะได้ไม่ต้อง migrate ตอน M6

## Stack

TypeScript (strict) · WXT + Vite · onnxruntime-web + transformers.js · Preact (popup/options เท่านั้น) · idb · Vitest · Playwright · Biome

## คำสั่ง

ยังไม่มี — จะเพิ่มเมื่อเริ่ม M0

## ภาษา

ตอบผู้ใช้เป็น **ภาษาไทย** · เอกสารเป็นไทยผสมศัพท์เทคนิคอังกฤษ · โค้ด/คอมเมนต์/commit message เป็นอังกฤษ
