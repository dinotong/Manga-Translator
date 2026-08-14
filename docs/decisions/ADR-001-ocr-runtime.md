# ADR-001 — OCR runtime: WASM vs WebGPU vs Local Service

- **สถานะ:** 🔴 **M0 gate ไม่ผ่านสำหรับ WASM/WebGPU** — recognition ช้าเกินไป ~10 เท่า
- **วันที่:** 2026-08-15
- **บริบท:** [00-technical-design.md §5.3](../00-technical-design.md) · [01-implementation-plan.md M0](../01-implementation-plan.md)

---

## เครื่องที่วัด

```
GPU  RTX 3060 Laptop 6 GB   (WebGPU รายงาน vendor=nvidia arch=ampere)
CPU  i7-12700H · 20 threads
RAM  16 GB
Chrome · crossOriginIsolated = true
```

## สิ่งที่วัด

- Detector: **PP-OCRv4 mobile det** (ONNX 4.7 MB, Apache-2.0) ผ่าน `onnxruntime-web` 1.27
- `ort.env.wasm.numThreads = 1` (single thread — ตามข้อจำกัด CSP ของ extension)
- Fixture: **10 หน้าจริง 1280×~1820** จากเว็บที่ผู้ใช้อ่านจริง
- Resolution policy: `balanced` → det bitmap ~1128×1600 → model input capped ที่ 960 long edge
- Recognizer: **mock** (ยังไม่ได้ต่อ manga-ocr)

---

## ผลลัพธ์

### เวลาต่อหน้า (10 หน้า)

| Backend | detect (steady) | total median | total min | total max |
|---|---|---|---|---|
| **WASM** 1 thread | **574–731 ms** | **710 ms** | 648 ms | 830 ms |
| **WebGPU** | **101–139 ms** | **216 ms** | 149 ms | 1.83 s ⚠️ |

**WebGPU เร็วกว่า WASM ~5.5×** ในขั้น detection

### แยกตาม stage (WebGPU, steady state)

| Stage | เวลา | หมายเหตุ |
|---|---|---|
| decode + resize | 68–128 ms | 🔴 **พอๆ กับ detection** — ดูข้อค้นพบ 2 |
| detect | 101–139 ms | |
| group | 0–1 ms | ฟรี |
| recognize | — | ยังเป็น mock |

### จำนวน block ที่ detect ได้

5–19 block/หน้า (median ~9) · ทิศทางที่ตรวจได้ส่วนใหญ่เป็น **vertical** ซึ่งสอดคล้องกับ layout ญี่ปุ่น/CJK

---

## ข้อค้นพบ

### 1. 🔴 Cold start ของ WebGPU = ~1.7–2.0 วินาที

หน้าแรกหลังโหลดโมเดลใช้ **1.74 s** ขณะที่หน้าถัดไปใช้ 101–139 ms
สาเหตุคือ **shader compilation** ของ WebGPU ซึ่งจ่ายครั้งเดียวต่อ session

ยืนยันซ้ำได้ทุกครั้งที่สร้าง session ใหม่ (เห็นทั้งรอบ auto และรอบ webgpu แยก)

> **ผลต่อ M4:** ห้าม lazy-load โมเดลตอนเจอรูปแรกในหน้าจอ
> ต้อง **pre-warm ตอนผู้ใช้เปิด toggle** — รัน dummy inference 1 ครั้งทันที
> ไม่งั้นหน้าแรกที่ผู้ใช้เห็นจะช้ากว่าหน้าอื่น 15 เท่า ซึ่งเป็น first impression ที่แย่ที่สุดเท่าที่จะเป็นไปได้

### 2. 🟠 decode + resize แพงพอๆ กับ detection บน WebGPU

68–128 ms ต่อหน้า สำหรับ `createImageBitmap` × 2 (det + rec bitmap)
ตอนอยู่บน WASM มันดูไม่สำคัญ (10–20% ของเวลา) แต่พอขึ้น WebGPU มันกลายเป็น **~45% ของเวลาทั้งหมด**

ทางแก้ที่ควรทำใน M1:
- ถ้า `plan.det` เท่ากับ `plan.rec` (เกิดกับรูปเล็ก) → **สร้าง bitmap เดียวใช้ร่วมกัน** ตอนนี้สร้าง 2 ครั้งโดยไม่จำเป็น
- ปล่อย `ImageBitmap` ต้นฉบับให้เร็วที่สุด

### 3. 🟢 Detection ไม่ใช่คอขวด แม้บน WASM

710 ms/หน้าบน WASM single-thread ยังห่างจากเพดาน 5 วินาทีมาก
→ **ถ้า M0 ตกรอบ จะตกเพราะ manga-ocr ไม่ใช่เพราะ detector**

### 4. 🟢 `groupLinesIntoBlocks()` ต้นทุนเป็นศูนย์

0–1 ms กับ 5–19 block → ปรับ threshold ได้อิสระโดยไม่ต้องห่วงเรื่องความเร็ว

### 5. 🟢 กฎ "ห้าม upscale" ได้ผลจริง

รูป 1280×1820 → det bitmap 1128×1600 (ย่อลงตาม long edge) → model input capped 960
ถ้าใช้กฎเดิมที่ขยายเป็น 1600 จะเสียเวลาเพิ่มโดยไม่ได้ข้อมูลเพิ่ม

---

## การตัดสินใจ

1. **WebGPU เป็น default · WASM เป็น fallback อัตโนมัติ**
   `PpOcrDetector` ทำ `['webgpu', 'wasm']` แล้ว log ว่าตัวไหนติด — ห้าม fallback เงียบๆ

2. **Pre-warm บังคับ** — เพิ่มเข้า M4 เป็นข้อกำหนด ไม่ใช่ optimization

3. **ยังไม่สรุป go/no-go ของ M0** — ตัวเลขที่ตัดสินคือ manga-ocr ซึ่งยังไม่ได้วัด

### งบเวลาที่เหลือให้ manga-ocr

```
เพดาน                    5000 ms/หน้า
− decode + resize          ~100 ms
− detection (WebGPU)       ~120 ms
− grouping                   ~1 ms
                       ─────────────
เหลือให้ recognition      ~4780 ms/หน้า

median 9 block/หน้า  →  ~530 ms/block   ← ตัวเลขที่ต้องจับตา
```

ถ้า manga-ocr ทำได้ **≤ 500 ms/bubble บน WebGPU** โปรเจกต์ผ่านฉลุย
ถ้าเกิน **1 วินาที/bubble** ต้องพิจารณา Local Service

---

---

## ผลวัด recognition (manga-ocr) — 2026-08-15

Setup: `ms57rd/manga-ocr-base-ONNX` quantized (encoder 87 MB + decoder_merged 30 MB)
ผ่าน `@huggingface/transformers` 4.2 · เสิร์ฟจาก origin เดียวกัน · fixture ญี่ปุ่นจริง

| ค่า | ผล | งบที่ตั้งไว้ |
|---|---|---|
| **ต่อ bubble (median)** | **5.27 s** | ~530 ms |
| ต่อ bubble (max) | 6.25 s | |
| หน้าที่มี 1 bubble | 18.6 s รวม | ≤ 5 s |

**ช้ากว่างบประมาณ ~10 เท่า**

หน้าถัดไปที่ detect ได้ 17 block จะใช้เวลาประมาณ **85–90 วินาที/หน้า** ซึ่งทำ auto-translate-on-scroll ไม่ได้เลย

### ทำไมถึงช้า

manga-ocr เป็น autoregressive decoder — ต้องรัน decoder ซ้ำทีละ token ต่อ 1 bubble
ต่างจาก detection ที่เป็น forward pass เดียวจบ ดังนั้นมันไม่ได้ประโยชน์จาก GPU แบบเดียวกัน
และ ONNX Runtime Web ยังไม่มี KV-cache / graph capture ที่ดีพอสำหรับ decoder loop บน WebGPU

### 🔴 การตัดสินใจที่ตามมา

**Local Service กลายเป็น default ไม่ใช่ fallback**

```
OCRProvider
├── LocalServiceProvider  ← default (Python + manga-ocr + CUDA บน RTX 3060)
└── WasmOCRProvider       ← fallback: ใช้ได้เฉพาะ detection + EN (PP-OCR rec)
```

เหตุผลที่ยังไม่ทิ้ง WASM:
- **detection เร็วพอมาก** (120 ms) → ยังใช้ในเบราว์เซอร์ได้
- **EN ใช้ PP-OCR rec ซึ่งเป็น CRNN ไม่มี decode loop** → น่าจะเร็วพอใน WASM (ยังไม่ได้วัด)
- ปัญหาอยู่ที่ **ญี่ปุ่นเท่านั้น**

### ยังไม่ได้ลอง — ควรลองก่อนสรุปปิด

1. **quantize ระดับอื่น** — `q4f16` (encoder 50 MB + decoder 24 MB) อาจเร็วกว่ามาก
2. **แยก device** — encoder บน WebGPU, decoder บน WASM (decoder loop ที่ batch เล็กมัก CPU เร็วกว่า)
3. **batch หลาย bubble พร้อมกัน** — ตอนนี้รันทีละอันแบบ sequential
4. **ogkalu/manga-ocr-mobile** (encoder 17 MB + decoder 25+23 MB) — เล็กกว่ามาก
5. ลด `maxNewTokens` จาก 64

ถ้าข้อ 1–4 รวมกันทำให้เหลือ < 1 s/bubble ก็ยังพอมีทาง

---

## 🟢 ทางออก: Gemini เป็น multimodal — ตัด recognizer ท้องถิ่นออกจาก critical path

ข้อสังเกตที่เปลี่ยนทุกอย่าง: **Gemini อ่านภาพได้เอง** เราจึงไม่ต้องมี OCR ท้องถิ่นสำหรับ "อ่าน" เลย

```
เดิม   detect (120 ms) → crop → manga-ocr (5.27 s/bubble 🔴) → Gemini แปล
ใหม่   detect (120 ms) → crop → Gemini อ่าน+แปลใน request เดียว → overlay
```

**ทำไมยังเก็บ detection ไว้ในเครื่อง**
1. เร็วอยู่แล้ว (~120 ms/หน้า) และ**ฟรี** ไม่กินโควตา
2. กล่องจาก PP-OCR แม่นระดับพิกเซล — overlay ดีได้เท่าที่พิกัดดี ถ้าให้ LLM เดา bbox จะเสียของที่เราทำได้ดีอยู่แล้ว
3. `isInky()` กรอง crop เปล่าทิ้ง**ก่อน**ส่ง → ไม่เปลืองโควตา

**ทำไมต้อง batch ทั้งหน้าใน 1 request**
- free tier นับเป็น **request/วัน (1,000)** ไม่ใช่ token → 9 bubble = 9 request จะเปลืองโควตา 9 เท่า
- โมเดลเห็นทั้งหน้าพร้อมกัน → สรรพนามและโทนเสียงต่อเนื่องกันระหว่าง bubble

| | manga-ocr ในเบราว์เซอร์ | **Gemini vision** |
|---|---|---|
| เวลา/หน้า | 85–90 s (17 bubble) | **~2–4 s** |
| ต้องโหลด | 117 MB | **0** |
| แปลด้วย | ต้องเรียก API แยกอีกรอบ | **รวมอยู่ในนั้นแล้ว** |
| โควตา | — | 1,000 หน้า/วัน ฟรี |

### สถานะใหม่ของ provider

```
TextRecognizer
├── GeminiVisionReader   ← default (อ่าน+แปลรวดเดียว)
├── MangaOcrRecognizer   ← offline/privacy · ช้า · รอ sidecar หรือการปรับจูน
└── PpOcrLatin           ← EN (ยังไม่ได้ทำ · CRNN ไม่มี decode loop น่าจะเร็วพอใน WASM)
```

manga-ocr **ยังไม่ทิ้ง** — เป็นทางเลือก offline และเป็นฐานของ Local Service ในอนาคต แต่ไม่ใช่ทางหลักอีกต่อไป

## ขั้นถัดไป

1. ต่อ `MangaOcrRecognizer` ผ่าน `@huggingface/transformers` — **ต้องมี fixture ภาษาญี่ปุ่นที่ยืนยันแล้วก่อน**
2. วัด recognition ต่อ bubble บนทั้ง WebGPU และ WASM
3. ทดสอบ quantize int8 เทียบ fp32
4. วัดเคส Giga Viewer (screenshot ~371 px) ว่า detection ยัง recall ได้ไหม
5. อัปเดต ADR นี้เป็น ✅ Final แล้วสรุป go/no-go
