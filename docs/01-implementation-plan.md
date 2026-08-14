# Implementation Plan — Manga Translator

> อ่าน [00-technical-design.md](./00-technical-design.md) ก่อน
> หลักการ: **ทุก milestone ต้องรันได้จริงและเห็นผลด้วยตา** ไม่มี milestone ที่เป็นแค่โค้ดที่ยังไม่ได้ใช้

---

## ภาพรวม

```
M0  Spike & Benchmark        ← GATE ตัดสินสถาปัตยกรรม  ⚠️ ห้ามข้าม
M1  Vertical Slice           ← คลิกขวา 1 รูป → เห็นข้อความญี่ปุ่น
M2  Overlay & Coordinates    ← เห็นกล่องทับตรงตำแหน่ง ย่อขยายไม่หลุด
M3  Translation + Cache      ← เห็นภาษาไทย · เปิดซ้ำแล้วขึ้นทันที
M4  Auto Translate (visibility) ← 🎯 เป้าหมายหลักของโปรเจกต์สำเร็จตรงนี้
M5  English + Robustness     ← EN→TH, lazy load, webtoon, canvas
M6  Local LLM + Router + UX  ← คุณภาพ + privacy + settings
M7  Shareable Build          ← onboarding, diagnostics, แจกเพื่อน
```

**M0→M4 คือ MVP** · M5–M6 คือส่วนต่อยอด
ประเมินคร่าวๆ: M0 ~1–2 วัน, M1–M4 อย่างละ ~2–4 วัน ขึ้นกับว่า M0 ให้ผลอย่างไร

---

## M0 — Spike & Benchmark ⚠️ GATE

> **ยังไม่แตะ Chrome extension เลย** เป็นหน้า HTML + Vite ธรรมดาใน `spike/`
> เหตุผล: ถ้า OCR ช้าเกิน สถาปัตยกรรมทั้งหมดต้องเปลี่ยน — รู้ก่อนดีกว่ารู้ทีหลัง

### สิ่งที่ต้องเตรียม
- หน้ามังงะจริง **10 หน้า** ลงใน `spike/samples/` (ไม่ commit — อยู่ใน .gitignore)
  ต้องมีความหลากหลาย: บทพูดเยอะ, ตัวหนังสือบนพื้นดำ, ข้อความนอก bubble, เสียงประกอบตัวใหญ่, webtoon 1 แถบ
- เขียนคำตอบที่ถูกต้อง (ground truth) ของ ~50 bubble ลง `spike/groundtruth.json`

### งาน
1. `spike/index.html` — ลากรูปใส่ได้ แสดง: ภาพ + bbox ที่ detect + ข้อความที่อ่านได้ + เวลาแต่ละ stage
2. โหลด **PP-OCRv5 det ONNX** ผ่าน `onnxruntime-web` → วาด bbox
3. เขียน `groupLinesIntoBlocks()` เวอร์ชันแรก → วาดกล่อง block
4. โหลด **manga-ocr ONNX** ผ่าน `transformers.js` → อ่านแต่ละ block
5. วัด 4 ค่านี้ต่อหน้า:
   - เวลาโหลดโมเดลครั้งแรก / ครั้งต่อไป (cached)
   - เวลา detection
   - เวลา recognition **ต่อ bubble** และ **ต่อหน้า**
   - RAM peak
6. รันเทียบ 3 แบบ: `wasm (1 thread)` / `wasm (multi-thread)` / `webgpu`
7. ทดสอบ **quantize int8** ของ encoder+decoder แล้ววัดว่าเร็วขึ้นเท่าไร / แม่นลดลงเท่าไร
8. บันทึกผลลง `docs/decisions/ADR-001-ocr-runtime.md`

> M0 วัดเฉพาะ **ญี่ปุ่น** ซึ่งเป็นเคสที่ยากและช้าที่สุด — ถ้า JA ผ่าน EN ผ่านแน่นอน (design §5.2.1)

### เกณฑ์ผ่าน (Go/No-Go)

| ผลลัพธ์ | การตัดสินใจ |
|---|---|
| ≤ 5 วิ/หน้า | ✅ WASM เป็น default · ไปต่อ M1 |
| 5–10 วิ/หน้า | ⚠️ WASM default + preload margin กว้าง + แสดง progress · ไปต่อ M1 |
| > 10 วิ/หน้า | 🔴 สร้าง Local Service ก่อน แล้วให้ WASM เป็นทางเลือกรอง |
| Detection recall < 85% | 🔴 เปลี่ยน detector — ประเมิน comic-text-detector (ยอมรับ GPL ถ้าใช้เองเครื่องเดียว) |
| OCR accuracy < 70% | 🔴 ทบทวน crop padding / preprocessing / ขนาด input ก่อนโทษโมเดล |

**ส่งมอบ:** ตาราง benchmark + ADR-001 + ตัดสินใจ runtime ที่ล็อกแล้ว

---

## M1 — Vertical Slice (extension ตัวจริงตัวแรก)

> เป้าหมาย: พิสูจน์ว่า **ท่อทั้ง 4 context ต่อกันติด** ยังไม่สนใจความสวย
> UX ชั่วคราว: **คลิกขวาที่รูป → "แปลรูปนี้"** (manual trigger) — ตัดตัวแปร detector/scroll ออกไปก่อน

### งาน
1. ตั้ง WXT + TypeScript strict + Biome + Vitest
2. `manifest`: `host_permissions: ["<all_urls>"]`, `permissions: ["offscreen","storage","contextMenus","activeTab"]`, CSP `wasm-unsafe-eval`
3. `shared/messages.ts` + `shared/types.ts` — contract ครบก่อนเขียน logic
   ⚠️ **`from`/`to` เป็น `LangCode` ตั้งแต่บรรทัดแรก ห้าม hardcode `'ja'`/`'th'` ที่ไหนเลย**
   (ต้นทุนของ multi-language เกือบทั้งหมดอยู่ตรงนี้ — design §5.2.1)
4. Context menu → content script ส่ง `TRANSLATE_IMAGE`
5. **`acquire.ts` — decision tree ครบทั้ง 2 ทางตั้งแต่ต้น** (design §4.2)
   - `blob:`/`data:`/same-origin → **content script** fetch/`createImageBitmap` → ส่ง `ArrayBuffer` transferable
   - cross-origin tainted → **SW `fetch`** ข้าม CORS
   - ทั้งสองทางจบที่ `sha256(bytes)` → hash เดียวกัน
6. `core/resolution.ts` — downscale เป็น `detBitmap` 1600px + `recBitmap` 2048px แล้วปล่อยต้นฉบับ
7. `offscreen-manager.ts` — สร้าง/ปิด offscreen document
8. Offscreen: ย้ายโค้ด M0 เข้ามาหลัง `OCRProvider` interface
9. ผลกลับมา → `console.table()` ใน content script

### Definition of Done
- คลิกขวารูปมังงะ → console แสดงข้อความญี่ปุ่นพร้อม normalized bbox
- ✅ **ทำงานบน MangaDex จริง** (เคส `blob:` — พิสูจน์ว่า content-script path ถูก)
- ✅ ทำงานบนเว็บที่รูปเป็น cross-origin CDN ที่ canvas tainted (พิสูจน์ว่า SW-fetch path ถูก)
- รูป 3496×4960 ไม่ทำให้ RAM พุ่ง (ตรวจใน Task Manager — ต้องไม่ค้างที่ 69 MB/หน้า)
- เรียกซ้ำรูปเดิม → offscreen ไม่โหลดโมเดลใหม่

---

## M2 — Overlay & Coordinate System

> เป้าหมาย: **ความถูกต้องของพิกัด** ยังใช้ข้อความญี่ปุ่นเป็นตัวทดสอบ (ยังไม่แปล)
> เหตุผลที่แยกเป็น milestone: ถ้าพิกัดเพี้ยน จะดีบั๊กยากมากเมื่อมีตัวแปรอื่นปนเข้ามา

### งาน
1. `core/geometry.ts` + test — `NormRect`, `computeContentBox()` (รองรับ `object-fit`)
2. `overlay/host.ts` — custom element + closed Shadow DOM ที่ `document.body`
3. `overlay/layer.ts` — 1 layer/รูป, `transform` sync ผ่าน rAF แบบ dirty-flag
4. `overlay/render.ts` — กล่อง `%` + `container-type: size` + font ด้วย `cqw`
5. `core/text-fit.ts` — ประมาณขนาดฟอนต์จาก (จำนวนตัวอักษร, สัดส่วนกล่อง) แล้ว shrink ถ้าล้น
6. โหมด debug: กด `Alt+D` → แสดง bbox ดิบ + confidence + index

### Definition of Done
- กล่องทับข้อความญี่ปุ่นตรงตำแหน่ง ทั้งรูปแนวตั้ง แนวนอน และรูปที่โดน `object-fit: contain`
- **ย่อ/ขยายหน้าต่างจาก 1920 → 800 px → กล่องยังตรง โดยไม่มี JS ทำงาน** (พิสูจน์ผ่าน Performance panel)
- scroll ยาวๆ → ไม่มี layout thrashing (Performance panel ไม่มี forced reflow แดง)
- ปิด extension → DOM กลับสภาพเดิม (ตรวจด้วย `document.body.children.length`)

---

## M3 — Translation + Cache

### งาน
1. `cache/db.ts` — IndexedDB 2 store (`ocr`, `translation`) + versioned schema
2. เสียบ cache เข้า pipeline: ตรวจ `ocr` ก่อน → ตรวจ `translation` ต่อข้อความ
3. `TranslationProvider` interface + **`GeminiProvider`** (`gemini-2.5-flash-lite`, batch ทั้งหน้า = 1 req, structured output, BYO key)
4. `prompts.ts` + JSON schema validation + retry 1 ครั้ง (โค้ดชุดนี้จะถูก `LocalLLMProvider` ใช้ซ้ำใน M6)
5. **Options page ตัวจริง** — `shared/settings.ts` ตาม schema §15.5.1 + migration + `chrome.storage.local`
   - Gemini API key + ปุ่ม Test + แสดง req ที่ใช้วันนี้ (โควตา 1,000/วัน)
   - **ช่อง Ollama ใส่ครบตั้งแต่ตอนนี้** (baseUrl / model / numCtx) แต่ disabled พร้อมป้าย "M6"
     → เขียน schema ครั้งเดียวจบ ไม่ต้อง migrate settings ตอน M6
   - เตือนตรงๆ ว่า API key ใน extension storage ไม่ถือเป็นความลับ
6. Router v0 — โหมด `cloud` อย่างเดียว · **แต่ dropdown ใน options ต้องมีช่อง "Ollama (เร็วๆ นี้)" แบบ disabled ไว้แล้ว**
7. **Error path ครบ** — `PROVIDER_REFUSED` / `QUOTA_EXCEEDED` / `INVALID_KEY` / `OFFLINE` (design §11.2.1)
   ตั้ง `safetySettings` ทุกหมวดเป็น `BLOCK_NONE` · ถ้าโดนปฏิเสธทั้ง batch ให้ retry แยกทีละ block
8. `cache/eviction.ts` — LRU + ปุ่ม Clear cache แสดงขนาด

### Definition of Done
- คลิกขวา → เห็น **ภาษาไทยแนวนอน** ทับ bubble
- ทั้งหน้า (10–20 bubble) ใช้ **1 API request** ไม่ใช่ 20
- รีเฟรชหน้า แล้วคลิกขวารูปเดิม → ขึ้นภายใน 200 ms และ **ไม่มี network request ออกเลย**
- ประโยคซ้ำข้ามหน้า (เช่น ชื่อตัวละคร) → hit translation cache
- ตัด API key ทิ้ง → error message บอกชัดว่าต้องทำอะไร ไม่ใช่ fail เงียบ

---

## M4 — Auto Translate on Visibility Change 🎯

> หัวใจของโปรเจกต์ตาม handoff §2
> **เปลี่ยนชื่อจาก "on Scroll"** เพราะเว็บเป้าหมายทั้งสองเป็น paged reader (design §3.2, §4.4)
> ตัวขับคือ **IntersectionObserver + navigation/src change** ไม่ใช่ scroll event

### งาน
1. `detector/scan.ts` + `scoring.ts` + `site-profiles/registry.ts`
2. **`readers/`** — `StripReader` + **`PagedReader`** หลัง `ReaderAdapter` interface เดียวกัน (design §3.2.3)
   - ดักการเปลี่ยนหน้า **ครบ 4 ทาง**: URL (`navigation` + patch `pushState`/`popstate`) · `src` attribute · IntersectionObserver · คลิก nav
   - 🔴 **`src` เปลี่ยนบน element เดิม → `invalidateImmediately()` ทันที** ไม่งั้นคำแปลหน้าเก่าจะค้างทับหน้าใหม่
3. **Site profiles 2 ตัว** (ครอบ acquisition path เกือบทั้งหมดที่มีจริง)
   - `mangadex.ts` — `blob:` + content-script + preload รูป rect 0×0
   - `imhentai.ts` — cross-origin CDN + SW fetch + `/view/{id}/{n}/` + prefetch
4. 🔴 **Pre-warm โมเดลตอนกด toggle** — วัดแล้วว่า WebGPU cold start = **~1.7–2.0 วิ** (shader compilation)
   ถ้า lazy-load ตอนเจอรูปแรก หน้าแรกที่ผู้ใช้เห็นจะช้ากว่าหน้าอื่น **15 เท่า** → รัน dummy inference ทันทีที่เปิด (ADR-001)
5. **Prefetch สำหรับ paged reader** — lookahead 3 หน้า, `MAX_CONCURRENT_PREFETCH=1`, เว้น ≥ 500 ms, หยุดเมื่อ tab ไม่ active
   ปุ่ม "โหลดทั้งตอน" แยกต่างหาก **ต้องให้ผู้ใช้กดเอง**
5. `scheduler.ts` — priority queue, `MAX_CONCURRENT=1`, dedupe 3 ชั้น, cancel เมื่อหลุดจอ
6. Port ระยะยาว content ↔ SW (กัน SW ตาย + ส่ง progress)
7. Skeleton/spinner บนกล่องระหว่างรอ
8. Popup: toggle + สถานะ + **เลือกภาษาต้นทางด้วยมือ** (จำต่อ gallery/series)

### Definition of Done
- **imhentai:** กด "หน้าถัดไป" → คำแปลขึ้น **ทันที (< 200 ms)** เพราะ prefetch ไว้แล้ว
- **imhentai:** กดหน้าถัดไปเร็วกว่า OCR จะเสร็จ → overlay หน้าเก่า **หายทันที** ไม่ค้างทับ
- **MangaDex paged:** กดหน้าถัดไป → คำแปลขึ้นทันที (preload จาก rect 0×0)
- **MangaDex long strip:** scroll อ่านปกติ คำแปลตามมาเอง
- อ่าน 20 หน้า แล้วย้อนกลับ → log ยืนยัน **OCR ซ้ำ 0 ครั้ง**
- กดเปลี่ยนหน้ารัวๆ 30 ครั้ง → ไม่มี job ค้าง, ไม่ leak, ไม่หนืด
- prefetch ไม่ยิงเกิน 2 req/วินาที (ดูใน Network panel)
- ปิด toggle → overlay หายหมด, observer disconnect หมด

**เมื่อจบ M4 = MVP ตาม handoff §17 สำเร็จ**

---

## M5 — English support + Robustness

> 🎯 **EN→TH ลงที่นี่** — ของบางส่วนถูกวางไว้ตั้งแต่ M1 แล้ว (LangCode เป็น parameter)

### 5A — Multi-language (design §5.2.1)
1. `TextRecognizer` interface + แยก `MangaOcrJa` ออกจาก `TextDetector`
2. **`PpOcrLatin.ts`** — PP-OCR rec latin (~10 MB) → รองรับ **EN**
   → EN จะเร็วกว่า JA มาก เพราะเป็น CRNN forward pass เดียว ไม่มี autoregressive decode
3. `lang-packs.ts` — `LanguagePack` registry (recognizer + direction + reading order + grouping threshold)
4. **`lang-detect.ts`** — auto-detect: รัน PP-OCR latin บน 3 block ใหญ่สุด → ASCII+confidence สูง = `en` (ใช้ผลได้เลย) / ขยะ = `ja` (โหลด manga-ocr)
   จำผลต่อ `setId` (galleryId / seriesId) — จ่ายครั้งเดียวต่อเรื่อง
5. Reading order ตาม `LanguagePack`: `ja → rtl`, `en → ltr`
6. Popup: เลือกภาษาต้นทาง (Auto / 日本語 / English) + ปลายทาง (ไทย)

**DoD:** เปิด gallery ภาษาอังกฤษบน imhentai → **ไม่ต้องโหลด manga-ocr 400 MB เลย** และแปลได้เร็วกว่า JA ชัดเจน · สลับ gallery JA/EN สลับไปมาแล้ว auto-detect ถูกทุกครั้ง

### 5B — Robustness
7. **Lazy load** — `data-src → src`, `img.decode()`, virtual list ที่ recycle DOM
8. **Webtoon long strip** — `core/slicing.ts` + overlap dedupe ด้วย IoU
9. **CSS background-image** — parse + map พิกัดตาม `background-size/position`
10. **Canvas** — `toBlob()` + จับ `SecurityError`
11. **Screenshot fallback** — `capture.ts` + throttle 600 ms + **ซ่อน overlay ก่อนแคป**
12. **Error UX** — badge บอกสาเหตุ (โมเดลโหลดไม่ได้ / key ผิด / โควตาหมด / ถูกปฏิเสธ / เว็บบล็อก)
13. E2E fixtures: reader 5 แบบ (paged-url / paged-src-swap / strip / lazy / canvas)

---

## M6 — Quality & UX

1. `LocalLLMProvider` (Ollama) — ใช้ `prompts.ts` + validator ที่เขียนไว้แล้วใน M3
   → เลือกโมเดลตาม [02-local-model-selection.md](./02-local-model-selection.md) (`qwen3.5-abliterated:4b` หรือ `gemma-4-E4B-heretic`)
   ⚠️ ระวัง VRAM ชนกับ WebGPU OCR บนการ์ด 6 GB — ดูตารางแผน A/B/C ในเอกสารนั้น
2. Onboarding `OLLAMA_ORIGINS=chrome-extension://*` + ปุ่ม Test connection ที่บอก error ชัด
3. `TranslationRouter` mode `auto` = Gemini ก่อน → fallback Ollama (quota/offline/validation fail) ตาม §11.4
4. `reading-order.ts` → อัปเกรดเป็น **RTL XY-cut** (ใช้จัดลำดับ context ให้ LLM)
5. Context window 3–5 bubble ก่อนหน้า + glossary ต่อเรื่อง
6. Settings ครบตาม handoff §7: Auto on/off, Mode (cloud/local/auto), Display (ไทยล้วน / ไทย+ญี่ปุ่นตอน hover), Performance preset
7. ปรับ typography ไทย: ฟอนต์, line-height, `text-wrap: balance`, ขอบขาวรอบตัวอักษร
8. **Benchmark ภาษาไทยของโมเดล local** บน eval set 30 bubble — โมเดลเล็กหลายตัวภาษาไทยแย่มาก ต้องวัดเอง

---

## M7 — Shareable Build (ทำเมื่อพร้อมแจกเพื่อน)

> ไม่ใช่ MVP แต่ต้องออกแบบรองรับไว้ตั้งแต่ M3 (ดู design §16.3)

1. **Onboarding wizard** — ใส่ Gemini API key ของตัวเอง (ลิงก์ไป AI Studio) · ห้ามฝัง key ของ dev
2. **First-run model download** — progress bar, ขนาดชัดเจน, resume ได้
3. **Diagnostics page** — เช็คในคลิกเดียว: WebGPU / โมเดลครบไหม / API key ใช้ได้ / Ollama ต่อได้
4. **License audit script** — fail build ถ้า default bundle มีอะไรที่ไม่ใช่ Apache-2.0/MIT
5. README + LICENSE + NOTICE
6. Publish **unlisted** บน Chrome Web Store ($5 ครั้งเดียว) — สบายกว่าให้เพื่อนโหลด unpacked มาก

---

## หลังจากนั้น (ยังไม่ใช่ตอนนี้)

- Character memory / speaking style (handoff §11) — **ห้ามทำก่อน M6 เสร็จ**
- Text inpainting เพื่อลบข้อความต้นฉบับ
- ภาษาต้นทาง/ปลายทางเพิ่ม
- Panel detection จริงเพื่อ reading order ที่แม่นขึ้น

---

## กฎการทำงานระหว่างพัฒนา

1. **`core/` ต้องมี unit test ก่อน merge** — ตรรกะยากทั้งหมดอยู่ที่นั่นและ test ได้โดยไม่ต้องเปิด browser
2. **ทุก milestone จบด้วยการเปิดเว็บมังงะจริงแล้วดูด้วยตา** ไม่ใช่แค่ test เขียว
3. **วัดก่อนแก้** — เจอช้า/เพี้ยน ให้ log เวลาแต่ละ stage ก่อน ห้ามเดา
4. **ห้ามใส่ selector ของเว็บใดเว็บหนึ่งลง core** — ไปอยู่ที่ `site-profiles/` เท่านั้น
5. **ห้ามข้าม abstraction เพื่อความเร็ว** — `OCRProvider` และ `TranslationProvider` คือประกันความเสี่ยงของโปรเจกต์นี้
