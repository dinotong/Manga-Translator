# Work Queue

> อัปเดต 2026-08-15 · **ทำจากบนลงล่าง** · ติ๊ก `[x]` เมื่อเสร็จ
> เป้าหมายที่เจ้าของโปรเจกต์ยืนยัน: **เอา extension ไปอ่านมังงะได้จริง**

## การตัดสินใจที่ยืนยันแล้ว (2026-08-15)

| หัวข้อ | ค่า |
|---|---|
| Extension v1 รองรับ | **MangaDex + imhentai + generic `<img>`** — ยังไม่เอา Shonen Jump+ (Giga Viewer / screenshot) |
| ลำดับความสำคัญ | **Extension ใช้งานได้จริง มาก่อน** การจูนคุณภาพใน harness |
| ปุ่มดาวน์โหลด | **PNG ทั้งตอนรวดเดียว** (batch) — คำแปลฝังอยู่บนภาพ |
| Recognizer | **Gemini vision** (`gemini-flash-lite-latest`) — manga-ocr ในเบราว์เซอร์ตกรอบแล้ว (53 วิ/หน้า) |

---

## A. Harness — ปิดให้จบ (ประมาณครึ่งวัน)

- [ ] **A1. ปุ่มดาวน์โหลด PNG ทั้งตอน** ← *เจ้าของขอ*
  - เรนเดอร์ `<img>` + overlay ลง `OffscreenCanvas` แล้ว `convertToBlob({type:'image/png'})`
  - วาดข้อความด้วย `ctx.fillText` เอง (html2canvas ไม่ต้อง — เรารู้พิกัดทุกกล่องอยู่แล้ว)
  - ต้องทำ word-wrap เอง: วัดด้วย `ctx.measureText` แล้วตัดบรรทัด (ไทยไม่มีช่องว่าง → ตัดทีละตัวอักษร)
  - ปุ่ม "ดาวน์โหลดทั้งหมด" → วนทุกหน้าที่รันแล้ว → ดาวน์โหลดทีละไฟล์ เว้น ~300 ms กันเบราว์เซอร์บล็อก
  - ตั้งชื่อไฟล์ `<original-name>-th.png`
  - ⚠️ ต้องใช้ฟอนต์ไทยที่โหลดเสร็จแล้ว — `await document.fonts.ready` ก่อนวาด

- [ ] **A2. จูน `dilateRatio`** — ตอนนี้ `0.01` ให้ 10 blocks/หน้า ควรได้ ~6–7
  - ลอง `0.015` แล้ว `0.02` ที่ `spike/src/ocr/PpOcrDetector.ts`
  - เกณฑ์: เศษอย่าง "นิชิ" / "มาร์ท" ต้องหายไป แต่ 2 bubble ต้องไม่รวมกัน
  - เพิ่มเป็น dropdown ใน UI จะจูนได้เร็วกว่าแก้โค้ด

- [ ] **A3. unit test ของ `dilate()`** — ผิดกฎที่ตั้งไว้ว่า `core/` ต้องมี test
  - เคส: จุดเดี่ยวขยายเป็นสี่เหลี่ยม · 2 จุดใกล้กันเชื่อมกัน · 2 จุดไกลกันไม่เชื่อม · radius 0 = no-op · ไม่ล้นขอบ

- [ ] **A4. NMS / dedupe กล่องซ้อน** — ใช้ `iou()` ที่มี test แล้ว ตัดอันที่ score ต่ำกว่าเมื่อ IoU > 0.6

- [ ] **A5. ไล่โหมด manga-ocr ที่ให้ 0 blocks** — ดู console log ใหม่ (`[pipeline] dropped N/M blocks`) ว่าเป็น `empty output` หรือ `degenerate`

---

## B. Extension MVP — เป้าหมายหลัก 🎯

> ยกของจาก `spike/` มาเกือบทั้งหมด: `core/` ทั้งโฟลเดอร์ (81 tests), `PpOcrDetector`, `GeminiVisionReader`, `pipeline.ts`
> เขียนเป็น pure/portable ไว้ตั้งแต่ต้นเพื่อขั้นนี้โดยเฉพาะ

### B1. โครงสร้าง
- [ ] `extension/` ด้วย **WXT** + TypeScript strict + Biome + Vitest
- [ ] `manifest`: `permissions: ["offscreen","storage","contextMenus","activeTab"]`, `host_permissions: ["<all_urls>"]`
- [ ] CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`
- [ ] ย้าย `core/` + tests มาทั้งก้อน (ต้องผ่าน 81 tests เหมือนเดิม)
- [ ] `shared/messages.ts` — typed message contract (design §10.2)
  - ⚠️ `LangCode` เป็น parameter ตั้งแต่บรรทัดแรก **ห้าม hardcode `'ja'`/`'th'`**

### B2. Acquisition — 2 path เท่าเทียมกัน (design §4.2)
- [ ] `blob:` / `data:` / same-origin → **content script** `fetch` + `createImageBitmap` → ส่ง `ArrayBuffer` transferable
- [ ] cross-origin ที่ canvas tainted → **SW `fetch`** ข้าม CORS ด้วย `host_permissions`
- [ ] ทั้งสองจบที่ `sha256(bytes)` → hash เดียวกัน
- [ ] `core/resolution.ts` — det 1600 / rec 2048 **ห้าม upscale**

### B3. ML host
- [ ] **Offscreen document** (`reasons: ['WORKERS','BLOBS']`) — SW รัน ONNX ไม่ได้
- [ ] `PpOcrDetector` ย้ายมา · โหลดโมเดลเข้า **Cache Storage** ไม่ bundle ลง .crx
- [ ] 🔴 **Pre-warm ตอนกด toggle** — WebGPU cold start 1.7–2.0 วิ (ADR-001) ถ้า lazy-load หน้าแรกจะช้ากว่าหน้าอื่น 15 เท่า
- [ ] ปิด offscreen เมื่อไม่มี job ครบ 5 นาที

### B4. Translation
- [ ] `GeminiVisionReader` ย้ายมา · fetch อยู่ใน **SW** (content script จะติด CSP ของเว็บ)
- [ ] `safetySettings: BLOCK_NONE` ครบ 4 หมวด
- [ ] error path: `PROVIDER_REFUSED` (retry แยกทีละ block) / `QUOTA_EXCEEDED` / `INVALID_KEY` / `OFFLINE`
- [ ] 🔴 **ห้าม pin เวอร์ชันโมเดล** — ใช้ alias `-latest` (2.5-flash-lite โดนปิดแล้ว → 404)

### B5. Overlay
- [ ] Custom element + **closed Shadow DOM** ที่ `document.body` — ห้ามแตะ DOM ของเว็บ
- [ ] กล่อง `%` + `container-type: size` + font `cqw` → responsive โดยไม่ใช้ JS
- [ ] สูตรฟอนต์: `s = √(W·H / (1.2·N))` โดย **H ต้องแปลงผ่าน aspect ratio** (ดู `spike/src/ui/render.ts`)
- [ ] 🔴 **ผูก overlay กับ `imageHash` ไม่ใช่ element** — imhentai สลับ `src` บน `<img id="gimg">` ตัวเดิม ถ้าผูก element คำแปลหน้าเก่าจะค้างทับหน้าใหม่
- [ ] `computeContentBox()` รองรับ `object-fit: contain` (MangaDex ใช้จริง)
- [ ] rAF sync แบบ dirty-flag + `transform` (ไม่ใช่ `left/top`)

### B6. Cache
- [ ] IndexedDB **2 store แยกกัน**: `ocr` (key=`det@v:rec@v:hash`) และ `translation` (key=`provider@model:from-to:sha1`)
- [ ] LRU 200 MB + ปุ่ม Clear
- [ ] ⚠️ ห้ามใช้ `chrome.storage.local` เก็บ OCR result

### B7. Trigger
- [ ] **คลิกขวา → "แปลรูปนี้"** ให้ทำงานก่อน (ตัดตัวแปรออก ดีบั๊กง่าย)
- [ ] แล้วค่อยเพิ่ม auto: IntersectionObserver `rootMargin: '200% 0 100% 0'` + MutationObserver + navigation
  - ⚠️ **scroll event ใช้เป็นตัวขับไม่ได้** — เว็บเป้าหมายเป็น paged reader
- [ ] `PagedReader` — ดักเปลี่ยนหน้า 4 ทาง: URL / `src` attribute / IntersectionObserver / คลิก nav
- [ ] Prefetch lookahead 3 หน้า, ≤1 req พร้อมกัน, เว้น ≥500 ms, หยุดเมื่อ tab ไม่ active

### B8. Site profiles
- [ ] `mangadex.ts` — `.md--page img.img`, `acquire: 'content-script'`, preload รูป rect 0×0
- [ ] `imhentai.ts` — `#gimg`, `acquire: 'sw-fetch'`, `/view/{id}/{n}/`, prefetch ได้
- [ ] `default.ts` — heuristic scoring (design §2.1)

### B9. UI
- [ ] **Popup**: toggle · โหมด · ภาษาต้นทาง · สถานะคิว
- [ ] **Options**: Gemini API key + Test · display · cache · **ช่อง Ollama ใส่ใน schema เลยแม้ยัง disabled** (กัน migration ตอน M6)
- [ ] `Settings.version` + migration · เก็บใน `chrome.storage.local` เท่านั้น
- [ ] เตือนตรงๆ ว่า API key ใน extension storage ไม่ถือเป็นความลับ

### B10. ส่งมอบ ← *เจ้าของขอ*
- [ ] `npm run build` → `dist/`
- [ ] **`INSTALL.md` ภาษาไทย**: ขอ API key ฟรี → เปิด `chrome://extensions` → Developer mode → Load unpacked → ปักหมุด → ใส่ key → เปิดหน้ามังงะ
- [ ] **`USAGE.md`**: วิธีใช้ · โหมดต่างๆ · ปุ่มลัด · แก้ปัญหาที่พบบ่อย
- [ ] **Diagnostics page** — ปุ่มเดียวเช็ค WebGPU / โมเดล / API key / cache พร้อมวิธีแก้ต่อบรรทัด
- [ ] LICENSE (Apache-2.0) + NOTICE

---

## C. หลัง MVP

- [ ] EN→TH (`PpOcrLatin` + auto-detect ภาษา) — design §5.2.1
- [ ] Webtoon slicing + overlap dedupe
- [ ] Shonen Jump+ / Giga Viewer (screenshot path)
- [ ] Local LLM (Ollama) — ดู `02-local-model-selection.md`
- [ ] Local Service sidecar (Python + manga-ocr + CUDA) สำหรับโหมด offline
- [ ] RTL XY-cut reading order

---

## กับดักที่เสียเวลาไปแล้ว — อย่าเหยียบซ้ำ

| อาการ | สาเหตุ |
|---|---|
| ORT โหลด wasm ไม่ได้ | วางไฟล์ใน `public/` แล้ว **Vite ปฏิเสธเสิร์ฟผ่าน `import()`** → ใช้ `?url` import จาก node_modules (ไม่มี prefix `dist/`) |
| โหลดโมเดลจาก HF พัง `ERR_HTTP2_PROTOCOL_ERROR` | COEP `require-corp` → ใช้ `credentialless` + เสิร์ฟโมเดลเอง |
| manga-ocr ตาย `43 vs 197 patches` | `preprocessor_config.json` ใช้ `"size": 224` scalar → ต้องเป็น `{height,width}` |
| แก้ config แล้วไม่มีผล | transformers.js cache config ใน Cache Storage → ต้องล้างก่อน |
| กดปุ่มแล้วไม่มีอะไรเกิดขึ้น | engine setup โยน error นอก try/catch → `running` ค้าง true |
| ตัวอักษรเล็กมาก | `cqw` อิงความกว้างล้วน → ความสูงต้องแปลงผ่าน aspect ratio |
| detector ได้ตัวอักษรทีละตัว | ต้อง **dilate mask ก่อน** connected components |
| Gemini 404 | `gemini-2.5-flash-lite` ปิดสำหรับผู้ใช้ใหม่ → ใช้ `-latest` |
