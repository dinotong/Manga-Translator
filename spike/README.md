# spike/ — M0 Benchmark Harness

> ยังไม่ใช่ Chrome extension — เป็นหน้า Vite ธรรมดา
> จุดประสงค์เดียว: **วัดว่า OCR ในเบราว์เซอร์เร็วพอทำ auto-translate ไหม**
> ผลลัพธ์ตัดสินว่า default runtime คือ WASM หรือ Local Service (ดู [../docs/01-implementation-plan.md](../docs/01-implementation-plan.md) M0)

---

## เริ่มยังไง

```bash
cd spike && npm install
```

```bash
npm run dev
```

เปิดเบราว์เซอร์ → ลากรูปมังงะมาวาง → เห็น bbox + ข้อความ + เวลาแต่ละ stage

**ตอนนี้ใช้ mock engine อยู่ ยังไม่ต้องมีโมเดล** จุดประสงค์คือให้ท่อทั้งอันเดินได้ก่อน
(รายละเอียดว่าทำไมถึงทำแบบนี้ อยู่หัวข้อ "วิธีคิด" ด้านล่าง)

```bash
npm test
```
67 tests ครอบตรรกะทั้งหมดใน `core/` — รันได้โดยไม่ต้องมีโมเดล ไม่ต้องมีรูป ไม่ต้องมีเบราว์เซอร์ ใช้เวลา < 1 วินาที

---

## วิธีคิด — ทำไมวางแบบนี้

หลักการเดียวที่ตัดสินทุกอย่าง: **แยกตรรกะที่ทดสอบได้โดยไม่ต้องมีโมเดล ออกจากตรรกะที่ต้องมีโมเดล**

โมเดลใหญ่ (140–460 MB) โหลดนาน และรันช้า ถ้าเอาทุกอย่างผูกกับโมเดล การแก้ threshold ของ grouping ทีนึงจะต้องรอโหลดโมเดลทุกครั้ง — พัฒนาไม่ไหว

```
src/core/     pure function ล้วน       → vitest 300 ms · ไม่ต้องมี browser/model/network
src/ocr/      interface + mock + real  → สลับ implementation ได้โดยไม่แตะ core
src/ui/       แสดงผล + จับเวลา          → เห็นด้วยตาว่าอะไรพัง
src/pipeline.ts  ประกอบทั้งหมดเข้าด้วยกัน
```

### ทำไมต้องมี mock engine

`MockDetector` / `MockRecognizer` ทำให้ harness **ทั้งอันเดินได้ตั้งแต่วันแรก** — decode, grouping, crop, render, timing ทำงานจริงหมด

พอเสียบโมเดลจริงเข้าไป **ตัวแปรใหม่มีตัวเดียวคือโมเดล** ถ้าพังก็รู้ทันทีว่าพังที่ไหน
ถ้าเขียนทุกอย่างพร้อมกันแล้วพัง จะแยกไม่ออกว่าเป็นที่ ONNX, ที่ preprocessing, ที่ grouping, หรือที่ render

> mock จงใจคืนข้อความว่า `[mock vertical 3L @120,80 90x200]` **ไม่ใช่ภาษาญี่ปุ่นปลอม**
> mock ที่หน้าตาเหมือนของจริง คือ mock ที่วันหนึ่งคุณจะเผลอคิดว่าเป็นของจริง

### สอง coordinate space — จุดที่พลาดกันบ่อยที่สุด

```
PixRect   พิกเซลใน bitmap ที่กำลังทำงานอยู่   → คำนวณทุกอย่างที่นี่
NormRect  [0,1] เทียบขนาดจริงของรูป          → เก็บ cache / ส่งต่อ เท่านั้น
```

**ทำไมไม่คำนวณใน normalized space ไปเลย?** เพราะ x กับ y หารด้วยตัวหารคนละตัว
หน้า 3496×4960: `w: 0.05` = 175 px แต่ `h: 0.05` = 248 px
→ โค้ดที่เทียบ width กับ height (aspect ratio, ระยะห่าง, "บรรทัดนี้แนวตั้งไหม") จะ**ผิดแบบเงียบๆ**

กฎ: **คำนวณในพิกเซล แปลงเป็น normalized ครั้งเดียวตอนออกจาก pipeline และห้ามแปลงกลับ**

### ทำไม overlay ใน harness ใช้ `%`

`src/ui/render.ts` วางกล่องด้วย `left: 42.318%` ไม่ใช่ pixel — นี่ไม่ใช่ความมักง่าย แต่เป็น**การซ้อมกลยุทธ์ overlay ของ extension ตั้งแต่ตอนนี้**
ถ้ามันจะพังตอน responsive รู้ตอนนี้ดีกว่ารู้ตอน M2

---

## แผนที่ไฟล์

| ไฟล์ | หน้าที่ | test? |
|---|---|---|
| `core/geometry.ts` | overlap, gap, IoU, padding, norm↔pix, `computeContentBox` (object-fit) | ✅ |
| `core/grouping.ts` | **line → block (union-find)** + reading order | ✅ |
| `core/components.ts` | connected components สำหรับ DB postprocess + ink ratio | ✅ |
| `core/direction.ts` | แนวตั้ง/แนวนอน จาก aspect ratio | ✅ |
| `core/resolution.ts` | นโยบายย่อภาพ (**ห้าม upscale**) + เตือนความละเอียดต่ำ | ✅ |
| `ocr/types.ts` | `TextDetector` / `TextRecognizer` interface | — |
| `ocr/mock.ts` | mock engine ให้ท่อเดินได้วันนี้ | — |
| `pipeline.ts` | decode → detect → group → recognize → normalize + จับเวลา | — |
| `ui/render.ts` | bbox overlay (`%`) + ตารางเวลา + verdict | — |
| `bench/timer.ts` | จับเวลาต่อ stage + สถิติ | — |

### 3 ตรรกะที่สำคัญที่สุด (ถ้าจะอ่านโค้ดแค่ 3 ไฟล์ อ่านพวกนี้)

**1. `grouping.ts` — หัวใจของทั้งโปรเจกต์**
manga-ocr อ่าน bubble หลายบรรทัดใน pass เดียวและคืนข้อความที่เรียงถูกแล้ว → **ไม่มีขั้นตอน "ประกอบตัวอักษรแนวตั้ง" ให้เขียน**
สิ่งที่ตัดสินคุณภาพแทนคือ **crop ที่ป้อนเข้าไปมี bubble เดียวพอดีไหม**

- แยกไม่พอ → 1 bubble กลายเป็นเศษหลายชิ้น แต่ละชิ้นแปลโดยไม่เห็นประโยคตัวเอง
- รวมเกิน → 2 bubble กลายเป็น crop เดียว ข้อความออกมาปนกัน

**รวมเกินแย่กว่า** เพราะเศษประโยคอ่านแล้วรู้ว่าห้วน แต่ข้อความปนกันอ่านแล้วดู "มั่นใจและผิด" → threshold จึงตั้งไว้ทางอนุรักษ์นิยม

**2. `components.ts` — 4-connectivity ไม่ใช่ 8**
คอลัมน์ญี่ปุ่นที่อยู่ติดกันมักแตะกันที่มุม ถ้าใช้ 8-connectivity มันจะรวมเป็นก้อนเดียวตั้งแต่ชั้น detector
→ แย่งการตัดสินใจไปจาก `grouping.ts` ซึ่งเป็นที่ที่ควรตัดสินใจเรื่องนี้

**3. `pipeline.ts` — กันโมเดลแต่งเรื่อง**
manga-ocr **ไม่เคยปฏิเสธ** ป้อน crop เปล่าให้ มันจะแต่งประโยคญี่ปุ่นที่ฟังดูสมเหตุสมผลออกมา
กัน 2 ชั้น: `isInky()` เช็ค ink ratio **ก่อน** ป้อนเข้าโมเดล · `isPlausible()` ตัดผลที่วนซ้ำ (`ぁぁぁぁぁぁ`)

---

## เก็บ fixture

`samples/` และ `groundtruth.json` อยู่ใน `.gitignore` — **ไม่ขึ้น git** เพราะเป็นงานมีลิขสิทธิ์

ลากไฟล์ใส่ `samples/` เองก็ได้ หรือ:

```bash
node fetch-samples.mjs --url "https://host/path/{n}.webp" --from 1 --to 10 --label ja-set1
```

`{n}` = เลขหน้า · `{n2}` = เติม 0 เป็น 2 หลัก · `{n3}` = 3 หลัก
ใส่ `Referer` ให้อัตโนมัติ (CDN มังงะหลายเจ้า 403 ถ้าไม่มี) · เว้น 800 ms/ไฟล์ · ข้ามไฟล์ที่มีแล้ว

### ต้องการกี่หน้า และแบบไหน

**~10 หน้า** พอ แต่ **10 หน้าจากตอนเดียวกันไม่มีประโยชน์** ต้องหลากหลาย:

| # | ลักษณะ | ทำไมต้องมี |
|---|---|---|
| 2–3 | บทพูดเยอะ หลาย bubble | เคสหลัก + วัด worst case |
| 1 | ตัวหนังสือขาวบนพื้นดำ | detection มักพลาดตรงนี้ |
| 1 | ข้อความนอก bubble (ทับบนภาพ) | ทดสอบว่า grouping รวมมั่วไหม |
| 1 | เสียงประกอบตัวใหญ่ (オノマトペ) | ตัวอักษรใหญ่ผิดสัดส่วน — ต้องไม่ถูกรวมกับบทพูด |
| 1 | **หน้าที่แทบไม่มีข้อความ** | 🔴 จับ manga-ocr แต่งเรื่อง |
| 1 | ความละเอียดต่ำ ~1280 px (imhentai) | ตัวหนังสือสูง ~20–30 px |
| 1 | ความละเอียดสูง ~3500 px (MangaDex) | อีกขั้วหนึ่ง |
| 1 | screenshot จาก Giga Viewer ~371 px | 🔴 เคสที่ยากที่สุด — ตัวหนังสือสูง 8–12 px |
| 1 | webtoon 1 แถบยาว | ทดสอบ slicing |

### groundtruth.json

benchmark ที่ไม่มีเฉลย = วัดได้แค่ความเร็ว ไม่รู้ว่าถูกไหม

```json
[
  { "file": "ja-set1-001.webp", "bubbles": ["ここはどこ？", "……知らない天井だ"] }
]
```
ไม่ต้องใส่พิกัด — แค่ข้อความเรียงตามลำดับอ่านก็พอให้คะแนนได้

---

## สิ่งที่ต้องวัด

| ค่า | ทำไม |
|---|---|
| เวลาโหลดโมเดล (ครั้งแรก / จาก cache) | ตัดสิน UX ตอน first run |
| เวลา detection ต่อหน้า | ควรอยู่หลัก 100 ms |
| **เวลา recognition ต่อ bubble และต่อหน้า** | 🔴 ตัวชี้ขาด |
| RAM peak | การ์ด 6 GB มีเพดาน |
| detection recall | หลุด bubble ไปกี่ % |
| accuracy ระดับประโยค | เทียบ groundtruth ด้วยตา |

รัน 3 backend: `wasm (1 thread)` / `wasm (multi-thread)` / `webgpu`
แล้วลอง quantize int8 เทียบ fp32 — เร็วขึ้นเท่าไร แม่นลดลงเท่าไร

> harness ใช้ **median ไม่ใช่ min** ในการสรุป — ตัวอย่างเดียวของโมเดลที่ JIT warm แล้วมันโกหก

---

## เกณฑ์ตัดสิน (แสดงในหน้าเว็บอัตโนมัติ)

| เวลา/หน้า | ผล |
|---|---|
| ≤ 5 วิ | ✅ WASM เป็น default → ไป M1 |
| 5–10 วิ | ⚠️ WASM + preload margin กว้าง + progress → ไป M1 |
| > 10 วิ | 🔴 ต้องสร้าง Local Service ก่อน |

บันทึกผลลง `../docs/decisions/ADR-001-ocr-runtime.md`

---

## ขั้นถัดไป (ยังไม่ได้ทำ)

1. `ocr/PpOcrDetector.ts` — PP-OCRv5 det ผ่าน `onnxruntime-web` → ใช้ `connectedComponents()` ที่ test แล้วเป็น postprocess
2. `ocr/MangaOcrRecognizer.ts` — manga-ocr ผ่าน `@huggingface/transformers`
3. `scripts/download-models.mjs` — ดาวน์โหลด weights เข้า `models/` (gitignored)
4. `bench/score.ts` — ให้คะแนนเทียบ `groundtruth.json` อัตโนมัติ

ข้อ 1–2 ต้องมีรูปตัวอย่างจริงก่อนถึงจะรู้ว่า threshold ที่ตั้งไว้ใช้ได้ไหม
