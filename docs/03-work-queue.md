# Work Queue

> อัปเดต 2026-08-15 · **ทำจากบนลงล่าง** · ติ๊ก `[x]` เมื่อเสร็จ
> เป้าหมายที่เจ้าของโปรเจกต์ยืนยัน: **เอา extension ไปอ่านมังงะได้จริง**

## สถานะ ณ ตอนนี้ — อ่านตรงนี้ก่อน

**Extension ติดตั้งแล้วแปลมังงะได้จริง** ทดสอบในเบราว์เซอร์จริงผ่าน CDP ไม่ใช่แค่อ่านโค้ด

| | สถานะ |
|---|---|
| A. Harness | ✅ ปิดครบทั้ง A1–A5 · 97 tests |
| B1–B6, B8–B10 | ✅ เสร็จและพิสูจน์แล้ว · build 27 MB |
| **B7 trigger** | ✅ **ครบแล้วทั้ง 3 ทาง** — คลิกขวา · auto · prefetch · 231 tests |
| C. หลัง MVP | ยังไม่เริ่ม |

**ทดสอบแล้วว่าใช้ได้จริง:** คลิกขวา → 9 กล่องใน 3.1 วิ · MangaDex (`blob:`) ✅ · imhentai (SW fetch) ✅ · สอง path ให้ hash ตรงกันจนใช้ cache ร่วมกันได้ · เปิดซ้ำขึ้นทันที · Diagnostics เขียวครบรวม WebGPU

**🔴 เรื่องติดตั้งที่ต้องรู้:** Chrome บนเครื่องนี้ล็อก Developer mode ด้วย policy และเมิน `--load-extension` แบบเงียบ → **ใช้ Edge แทน ทดสอบแล้วว่าได้** ดู [INSTALL.md](../extension/INSTALL.md) ขั้นที่ 3ข และ [D-021](decisions/DECISIONS.md)

**โหมดอัตโนมัติ — พิสูจน์แล้วบนเว็บจริงทั้งสองเว็บ** (ก่อนหน้านี้ทุกการทดสอบรันตอนสวิตช์ปิด จึงไม่เคยมีหลักฐานเลย):
เปิดหน้าแล้วแปลเองโดยไม่ต้องแตะอะไร (imhentai 3.3 วิ · MangaDex 1.9 วิ) · เปลี่ยนหน้าแล้วแปลหน้าใหม่ (1.8–2.5 วิ) ·
**สุ่มตรวจ 111 ครั้งระหว่างเปลี่ยนหน้า ไม่เจอคำแปลหน้าเก่าค้างเลยสักครั้ง** · ย้อนกลับ = แคช 0 คำขอ · ปิดสวิตช์แล้วหยุดสนิทจริง
เจอบั๊ก 5 ตัวจากการทดสอบนี้ แก้ครบแล้ว ([D-023](decisions/DECISIONS.md) – [D-025](decisions/DECISIONS.md))

**prefetch — วัดที่ความเร็วอ่านจริงแล้ว** ([D-026](decisions/DECISIONS.md), [D-027](decisions/DECISIONS.md))
วิธีวัด: กดเปลี่ยนหน้าด้วยเมาส์จริงทุก **2–4 วินาที** (ไม่ใช่รอให้ prefetch เสร็จก่อนแล้วค่อยกด — วิธีเดิมที่ทำให้ได้เลข 96 ms ที่เชื่อไม่ได้)

| | prefetch ปิด | prefetch เปิด | + จำ URL→hash (D-027) |
|---|---|---|---|
| กดเปลี่ยนหน้า → คำแปลขึ้น (median 8 ครั้ง) | 3,526 ms | 1,155 ms | **95 ms** |
| เห็นป้าย “กำลัง…” | 8/8 ครั้ง | 7/8 ครั้ง | **2/8 ครั้ง** |
| **คำขอ Gemini ต่อหน้า** | 1.00 | **1.00** | **1.00** |

นับคำขอด้วยพร็อกซีที่ยืนแทน `generativelanguage.googleapis.com` (DevTools ไม่รายงาน fetch ของ service worker ให้) — อ่านครบเล่ม 9 หน้า = **9 คำขอพอดี ไม่มีซ้ำ**
เดินหน้า 1→9 แล้วถอยกลับ 9→1 รวม 16 ครั้ง: **src 9 แบบ ↔ hash 9 แบบ ไม่สลับกันเลย · ขากลับ 61–73 ms · 0 คำขอเพิ่ม**
กติกาความสุภาพ ✅ ครบ: ≤ 1 คำขอเดาพร้อมกัน (0 ครั้งที่ทับซ้อน) · ห่างกันน้อยสุด **931 ms** · เดาไม่เกินเล่ม (lookahead 10 บนเล่ม 9 หน้า → หยุดที่หน้า 9) · **แท็บถูกซ่อน 30 วินาที = 0 คำขอ** แล้วเริ่มใหม่เมื่อกลับมา

**hover-to-peek — ผ่านครบ ไม่กินคลิก** ([D-027](decisions/DECISIONS.md))
คลิกทับกล่องคำแปลตรงๆ **6/6 ครั้งเปลี่ยนหน้าได้ ไม่มีคลิกตายเลย** (`elementFromPoint` ใต้กล่องคืน `IMG#gimg` ของเว็บเอง) ·
ชี้แล้วจางเผยรูป **45/45 ถูกกล่อง** · เอาเมาส์ออกแล้วคืนสภาพ **45/45** · บริเวณที่กล่องซ้อนกันจริง **8 จุด — เผยแค่กล่องบนสุดกล่องเดียวทุกจุด**

**หลาย API key เรียงลำดับ — ทดสอบบนเบราว์เซอร์จริงแล้ว 4 กรณี**

| กรณี | ผล | เป็นของจริงแค่ไหน |
|---|---|---|
| 429 **ต่อนาที** | ดึง body จริงจาก Gemini มาเทียบ — `quotaId`, `quotaValue`, `RetryInfo` **ตรงกับที่ `core/quota.ts` เขียนไว้เป๊ะ** | **ของจริง** (ยิง 18 คำขอรวดจนติดเพดาน 15/นาที) |
| 429 **ต่อวัน** | key แรกถูกทำเครื่องหมาย `exhaustedOn` แล้ว**ข้ามไป key ถัดไปทันที ไม่ retry** → แปลสำเร็จ | **จำลอง** — ยิง 1,000 คำขอไม่ไหว · `quotaId` ที่ใช้ (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) ยืนยันจากรายงานของคนอื่นใน gemini-cli issue #9248 |
| key ผิด | ได้ 400 `API key not valid` → เก็บเป็น **`invalid` พร้อมเหตุผล ไม่ใช่ `exhaustedOn`** → ข้ามไป key ถัดไป | **ของจริง** |
| key หมดทุกอัน | ป้ายบอกผู้ใช้ว่า *“ใช้ครบทุก key แล้ว · โควตาจะรีเซ็ตอีกครั้ง 16 ส.ค. 14:00 น. (เที่ยงคืนเวลาแปซิฟิก)”* — เวลาไทยถูกต้อง | **ของจริง** (ทั้งสอง key ถูกจำลองว่าหมด) |

**migration v1→v2 รอดจริง:** เขียน storage แบบ v1 (`translation.gemini.apiKey`) แล้ว extension **ใช้ key นั้นยิงจริง** (พร็อกซีเห็นค่าเดียวกัน) และมันกลายเป็น**รายการที่หนึ่ง** `id=legacy-1`

⚠️ **ยังไม่ได้ทดสอบซ้ำบน MangaDex** — วันที่วัดรอบนี้ `mangadex.org` **ต่อไม่ติดจากเครื่องนี้** (`ERR_CONNECTION_TIMED_OUT` ทั้งในเบราว์เซอร์และจาก Node)
การแก้ D-027 อยู่ใน content script ที่ใช้ร่วมกันทั้งสองเว็บ — วิเคราะห์แล้วว่าไม่น่ากระทบ (MangaDex ใช้ `blob:` ซึ่งเป็น URL ใหม่ทุกก้อน map จึงไม่มีทางชนกัน) แต่ **ยังไม่มีหลักฐานจากของจริง** ต้องรันซ้ำเมื่อเข้าเว็บได้

**ยังไม่ได้ทำ:** Giga Viewer / Shonen Jump+ · EN→TH · Ollama

เหตุผลเบื้องหลังทุกการตัดสินใจอยู่ใน [decisions/DECISIONS.md](decisions/DECISIONS.md) — **ไม่เห็นด้วยข้อไหนสั่งแก้ได้**

## การตัดสินใจที่ยืนยันแล้ว (2026-08-15)

| หัวข้อ | ค่า |
|---|---|
| Extension v1 รองรับ | **MangaDex + imhentai + generic `<img>`** — ยังไม่เอา Shonen Jump+ (Giga Viewer / screenshot) |
| ลำดับความสำคัญ | **Extension ใช้งานได้จริง มาก่อน** การจูนคุณภาพใน harness |
| ปุ่มดาวน์โหลด | **PNG ทั้งตอนรวดเดียว** (batch) — คำแปลฝังอยู่บนภาพ |
| Recognizer | **Gemini vision** (`gemini-flash-lite-latest`) — manga-ocr ในเบราว์เซอร์ตกรอบแล้ว (53 วิ/หน้า) |

---

## A. Harness — ปิดให้จบ (ประมาณครึ่งวัน)

- [x] **A1. ปุ่มดาวน์โหลด PNG ทั้งตอน** ← *เจ้าของขอ* — ✅ ทดสอบในเบราว์เซอร์จริงแล้ว 3 หน้ารวด: ได้ไฟล์ครบ ชื่อถูก (`ja-set2-004-th.png`…) ขนาดเท่าต้นฉบับ (1280×1801) และพิสูจน์ด้วยการ diff พิกเซลว่า **ไม่มีพิกเซลไหนถูกวาดนอกกรอบ bubble เลย**
  - เรนเดอร์ `<img>` + overlay ลง `OffscreenCanvas` แล้ว `convertToBlob({type:'image/png'})`
  - วาดข้อความด้วย `ctx.fillText` เอง (html2canvas ไม่ต้อง — เรารู้พิกัดทุกกล่องอยู่แล้ว)
  - ต้องทำ word-wrap เอง: วัดด้วย `ctx.measureText` แล้วตัดบรรทัด (ไทยไม่มีช่องว่าง → ตัดทีละตัวอักษร)
  - ปุ่ม "ดาวน์โหลดทั้งหมด" → วนทุกหน้าที่รันแล้ว → ดาวน์โหลดทีละไฟล์ เว้น ~300 ms กันเบราว์เซอร์บล็อก
  - ตั้งชื่อไฟล์ `<original-name>-th.png`
  - ⚠️ ต้องใช้ฟอนต์ไทยที่โหลดเสร็จแล้ว — `await document.fonts.ready` ก่อนวาด

- [x] **A2. จูน `dilateRatio`** → **0.015** (วัดครบ 18 หน้า · [D-009](decisions/DECISIONS.md))
  - หน้าทดสอบ 10 → **8 blocks** · เศษหายตามต้องการ · dropdown ทั้ง dilate และ NMS อยู่ใน toolbar แล้ว
  - 🔴 **ไปไม่ถึง 6–7 และไปไม่ได้ด้วย dilate**: หน้านี้ให้ 8 เท่ากันทั้ง 0.015/0.02/0.03 → 8 ก้อนที่เหลือแยกกันจริง ถ้าจะตัด 2 อันเล็ก (107×76, 65×66 px) ต้องใช้เกณฑ์ขนาดขั้นต่ำ **รอเจ้าของสั่ง**

- [x] **A3. unit test ของ `dilate()`** — 8 เคส ครบตามที่ระบุ + asymmetric radius + รับ plain array

- [x] **A4. NMS / dedupe กล่องซ้อน** — `suppressOverlaps()` ใน `core/geometry.ts` + 8 tests · เรียกจาก detector ก่อน grouping
  - ⚠️ **วัดแล้วไม่เคยทำงานเลยบน 18 หน้า** (แม้ลดเกณฑ์ถึง IoU 0.2) — connected components ไม่สร้างกล่องซ้อนกันตั้งแต่ต้น ดู [D-011](decisions/DECISIONS.md) ว่าทำไมยังเก็บไว้

- [x] **A5. ไล่โหมด manga-ocr ที่ให้ 0 blocks** — เจอต้นเหตุแล้ว: **ONNX export พัง 2 ชั้น** ไม่ใช่ pipeline
  - `tokenizer.json` ของ `ms57rd` มี vocab **5 token จาก 6144** → ทุก id เป็น `[UNK]` → ถูกตัดจนเหลือสตริงว่าง — **แก้แล้ว** ใน `npm run models`
  - แต่พอ vocab ถูก โมเดลกลับ**อ่านไม่ตรงกับภาพ** เหมือนกันเป๊ะทั้ง fp32/int8 → ตัว export เองพัง แก้จากฝั่งเราไม่ได้ ([D-012](decisions/DECISIONS.md))
  - ติดป้าย 🔴 ใน dropdown แล้ว · **ADR-001 ถูกแก้**: 5.27 วิ/bubble วัดตอนโมเดลคืนค่าว่าง ต้องอ่านเป็นขอบล่าง

---

## B. Extension MVP — เป้าหมายหลัก 🎯

> ยกของจาก `spike/` มาเกือบทั้งหมด: `core/` ทั้งโฟลเดอร์ (81 tests), `PpOcrDetector`, `GeminiVisionReader`, `pipeline.ts`
> เขียนเป็น pure/portable ไว้ตั้งแต่ต้นเพื่อขั้นนี้โดยเฉพาะ

### B1. ✅ โครงสร้าง
- [x] `extension/` ด้วย **WXT** + TypeScript strict + Biome + Vitest
- [x] `manifest`: `permissions: ["offscreen","storage","contextMenus","activeTab"]`, `host_permissions: ["<all_urls>"]`
- [x] CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`
- [x] ย้าย `core/` + tests มาทั้งก้อน (ต้องผ่าน 81 tests เหมือนเดิม)
- [x] `shared/messages.ts` — typed message contract (design §10.2)
  - ⚠️ `LangCode` เป็น parameter ตั้งแต่บรรทัดแรก **ห้าม hardcode `'ja'`/`'th'`**

### B2. ✅ Acquisition — 2 path เท่าเทียมกัน (design §4.2)
- [x] `blob:` / `data:` / same-origin → **content script** `fetch` + `createImageBitmap` → ส่ง `ArrayBuffer` transferable
- [x] cross-origin ที่ canvas tainted → **SW `fetch`** ข้าม CORS ด้วย `host_permissions`
- [x] ทั้งสองจบที่ `sha256(bytes)` → hash เดียวกัน
- [x] `core/resolution.ts` — det 1600 / rec 2048 **ห้าม upscale**

### B3. ✅ ML host
- [x] **Offscreen document** (`reasons: ['WORKERS','BLOBS']`) — SW รัน ONNX ไม่ได้
- [x] `PpOcrDetector` ย้ายมา · โหลดโมเดลเข้า **Cache Storage** ไม่ bundle ลง .crx
- [x] 🔴 **Pre-warm ตอนกด toggle** — WebGPU cold start 1.7–2.0 วิ (ADR-001) ถ้า lazy-load หน้าแรกจะช้ากว่าหน้าอื่น 15 เท่า
- [x] ปิด offscreen เมื่อไม่มี job ครบ 5 นาที

### B4. ✅ Translation
- [x] `GeminiVisionReader` ย้ายมา · fetch อยู่ใน **SW** (content script จะติด CSP ของเว็บ)
- [x] `safetySettings: BLOCK_NONE` ครบ 4 หมวด
- [x] error path: `PROVIDER_REFUSED` (retry แยกทีละ block) / `QUOTA_EXCEEDED` / `INVALID_KEY` / `OFFLINE`
- [x] 🔴 **ห้าม pin เวอร์ชันโมเดล** — ใช้ alias `-latest` (2.5-flash-lite โดนปิดแล้ว → 404)

### B5. ✅ Overlay
- [x] Custom element + **closed Shadow DOM** ที่ `document.body` — ห้ามแตะ DOM ของเว็บ
- [x] กล่อง `%` + `container-type: size` + font `cqw` → responsive โดยไม่ใช้ JS
- [x] สูตรฟอนต์: `s = √(W·H / (1.2·N))` โดย **H ต้องแปลงผ่าน aspect ratio** (ดู `spike/src/ui/render.ts`)
- [x] 🔴 **ผูก overlay กับ `imageHash` ไม่ใช่ element** — imhentai สลับ `src` บน `<img id="gimg">` ตัวเดิม ถ้าผูก element คำแปลหน้าเก่าจะค้างทับหน้าใหม่
- [x] `computeContentBox()` รองรับ `object-fit: contain` (MangaDex ใช้จริง)
- [x] rAF sync แบบ dirty-flag + `transform` (ไม่ใช่ `left/top`)

### B6. ✅ Cache
- [x] IndexedDB **2 store แยกกัน**: `ocr` (key=`det@v:rec@v:hash`) และ `translation` (key=`provider@model:from-to:sha1`)
- [x] LRU 200 MB + ปุ่ม Clear
- [x] ⚠️ ห้ามใช้ `chrome.storage.local` เก็บ OCR result

### B7. Trigger ✅
- [x] **คลิกขวา → "แปลรูปนี้"** ให้ทำงานก่อน (ตัดตัวแปรออก ดีบั๊กง่าย)
- [x] auto: IntersectionObserver `rootMargin: '200% 0 100% 0'` + MutationObserver + navigation + **`load`**
  - ⚠️ **scroll event ใช้เป็นตัวขับไม่ได้** — เว็บเป้าหมายเป็น paged reader
  - 🔴 **ตัวจุดชนวนที่ขาดไปคือ `load`** — ตอน `src` เปลี่ยน `img.complete` เป็น false ตลอดช่วง callback ของ MutationObserver
    `enqueue()` จึง return เงียบๆ ทุกครั้ง = **เปลี่ยนหน้าแล้วไม่แปลเลย** (วัดได้ 60 วินาที 0 overlay) ดู [D-023](decisions/DECISIONS.md)
- [x] `PagedReader` — ดักเปลี่ยนหน้า: URL / `src` attribute / IntersectionObserver / `load`
  - 🔴 **หน่วยของงานต้องเป็น `(element, src ตอนเริ่ม)`** ไม่ใช่ element เปล่าๆ ไม่งั้นผลของหน้าเก่าจะถูกวาดทับหน้าใหม่ (เห็นกับตา: หน้า 1 แสดง hash ของหน้า 5)
  - 🔴 **ห้าม `clearAll()` ตอน URL เปลี่ยน** — MangaDex สลับ element ไม่ใช่สลับ src คำแปลจะหายถาวรทุกครั้งที่กดหน้าถัดไป ([D-025](decisions/DECISIONS.md))
- [x] Prefetch lookahead 3 หน้า, ≤1 req พร้อมกัน, เว้น ≥500 ms, หยุดเมื่อ tab ไม่ active
  - กติกาเป็น pure function ใน `core/prefetch.ts` + 14 tests · URL math ใน `core/page-url.ts` + 8 tests
  - เฉพาะเว็บที่มีช่อง `prefetch` ใน profile — **MangaDex ไม่มี** จึงไม่มีทางยิงคำขอเดาไปที่นั่น ([D-026](decisions/DECISIONS.md))
  - 🔴 **`core/prefetch.ts` เคยเขียนว่า worker มี “เลนแยก” ให้งานเดา — ไม่มีจริง** `background.ts` มีคิวเดียว
    วัดแล้วไม่ทำร้ายใครบน imhentai แต่ถ้ากระโดดไปหน้าที่ไม่ได้เดาไว้จะรออีก 1 งาน ([D-027](decisions/DECISIONS.md))

### B8. Site profiles ✅
- [x] `mangadex.ts` — `.md--page img.img`, `acquire: 'content-script'`, preload รูป rect 0×0
- [x] `imhentai.ts` — `#gimg`, `acquire: 'sw-fetch'`, `/view/{id}/{n}/`, prefetch ได้
- [x] `default.ts` — heuristic scoring (design §2.1)

### B9. UI ✅
- [x] **Popup**: toggle · โหมด · ภาษาต้นทาง · สถานะคิว
- [x] **Options**: Gemini API key + Test · display · cache · **ช่อง Ollama ใส่ใน schema เลยแม้ยัง disabled** (กัน migration ตอน M6)
- [x] `Settings.version` + migration · เก็บใน `chrome.storage.local` เท่านั้น
- [x] เตือนตรงๆ ว่า API key ใน extension storage ไม่ถือเป็นความลับ

### B10. ส่งมอบ ✅ ← *เจ้าของขอ*
- [x] `npm run build` → `dist/`
- [x] **`INSTALL.md` ภาษาไทย**: ขอ API key ฟรี → เปิด `chrome://extensions` → Developer mode → Load unpacked → ปักหมุด → ใส่ key → เปิดหน้ามังงะ
- [x] **`USAGE.md`**: วิธีใช้ · โหมดต่างๆ · ปุ่มลัด · แก้ปัญหาที่พบบ่อย
- [x] **Diagnostics page** — ปุ่มเดียวเช็ค WebGPU / โมเดล / API key / cache พร้อมวิธีแก้ต่อบรรทัด
- [x] LICENSE (Apache-2.0) + NOTICE

---

## ✅ หน้ารายการมังงะไม่ถูกแปลอัตโนมัติแล้ว — เสร็จ 2026-08-16 ([D-030](decisions/DECISIONS.md))

> เจ้าของรายงาน 2026-08-15: เปิดหน้าเลือกเรื่อง/เลือกตอน แล้วมันพยายามแปลภาพปก

- [x] **ชั้น 1 — `SiteProfile.isReaderPage?(url)`** imhentai `/view/` = อ่าน · MangaDex `/chapter/` = อ่าน · ที่เหลือ = ไม่ใช่ · คำตอบชี้ขาดทั้งสองทาง
- [x] **ชั้น 2 — `core/page-kind.ts`** สำหรับเว็บไม่รู้จัก: หน้าอ่าน = มีรูป**ครองจอ** ≥ 1 **และ** รูปที่ไม่ครองจอ ≤ 2
      ครองจอ = กว้าง ≥ 50% **หรือ สูง ≥ 60%** ของจอ (ต้องมีความสูง — MangaDex ย่อพอดีความสูง พอจอ 2560 px เหลือกว้าง 30%)
- [x] **ชั้น 3 — `READER_HINT` เหลือ `reader|viewer|chapter`** ตัด `gallery` `manga` `comic` `page` ทิ้ง
- [x] pure function + tests ใน `core/` — **231 tests**

🔴 **ข้อวินิจฉัยเดิมในคิวนี้ถูกครึ่งเดียว** — `gallery` ใน `READER_HINT` ผิดจริง แต่**ไม่ใช่ต้นเหตุของอาการบน imhentai/MangaDex**
วัดด้วย build เดิม: หน้า `/gallery/` **ไม่มี `#gimg`** และหน้า `/title/` **ไม่มี `img.img`** → `pageSelector` ลัดวงจรตัวให้คะแนนไปแล้ว → **0 คำขออยู่แล้ว**
อาการเกิดจริงบน**เว็บที่ไม่มี profile**: `mangaread.org` หน้าแรก build เดิม = **1 คำขอ + overlay ทับ thumbnail** (รูป 65×81 px แต่ไฟล์จริง 576×720)

**วัดหลังแก้บนเบราว์เซอร์จริง** (Edge 151 · นับคำขอที่ service worker target ผ่าน CDP):

| | Gemini | กล่อง |
|---|---|---|
| imhentai `/gallery/` · หน้าแรก · หน้าค้นหา | **0 · 0 · 0** | ไม่มี `<manga-translator-root>` เลย |
| MangaDex `/title/` · หน้าแรก | **0 · 0** | 0 |
| mangaread.org หน้าแรก (เดิม 1 คำขอ) | **0** | 0 |
| imhentai `/view/1/` · MangaDex `/chapter/` | 1 · 1 | **2 · 13** |
| mangaread.org `/chapter-207/` (ชั้น 2 ตัดสิน) | 4 | **6** |
| **คลิกขวาบนภาพปกในหน้ารายการ** | auto 0 → คลิกขวา **1** | **3** |
| **MangaDex `/title/` → `/chapter/` ไม่โหลดหน้าใหม่** | 0 → **2** | **3** ใน 10 วิ |

**ผลข้างเคียงที่ยอมรับ:** หน้าอ่านที่มี thumbnail ตอนอื่นเกิน 2 รูปข้างๆ จะไม่แปลอัตโนมัติ (คลิกขวาได้) — ตั้งใจให้เอียงทางนี้

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
| แปลภาพปกในหน้ารายการ | ตัวให้คะแนน**รายรูป**แยกภาพปกจากหน้ามังงะไม่ออก — ต้องตัดสินที่**ระดับหน้า** ([D-030](decisions/DECISIONS.md)) |
| ตัวให้คะแนนผ่าน thumbnail จิ๋ว | เกณฑ์ขนาดดู **naturalWidth** เว็บเสิร์ฟไฟล์ใหญ่แล้วให้ CSS ย่อ → 65×81 px บนจอ แต่ไฟล์ 576×720 |
| จอกว้าง 2560 px แล้ว heuristic ไม่ทำงาน | reader ที่ย่อพอดี**ความสูง** เหลือกว้างแค่ 30% ของจอ — เกณฑ์ต้องดูความสูงด้วย |
