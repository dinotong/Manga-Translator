# Technical Design — Manga Translator (JA → TH) Chrome Extension

> Status: **Draft for approval** · Date: 2026-08-14
> อ้างอิงจาก [manga-translator-project-handoff.md](../manga-translator-project-handoff.md)
> เอกสารนี้ตอบคำถาม 12 ข้อใน §19 ของ handoff และแก้ assumption ที่ใช้ไม่ได้จริง

---

## 0. TL;DR — 8 ข้อสรุปที่เปลี่ยนแผนเดิม

| # | สิ่งที่ handoff สมมติไว้ | ความจริง | ผลต่อสถาปัตยกรรม |
|---|---|---|---|
| 1 | ต้องเขียน algorithm ประกอบตัวอักษรญี่ปุ่นแนวตั้งเอง | `manga-ocr` อ่าน **ทั้ง bubble หลายบรรทัดใน forward pass เดียว** และคืน string ที่เรียงถูกแล้ว | **ตัด Phase 3 (vertical reconstruction) ออกจาก critical path** — เหลือแค่ "จับ line ให้เป็น block" |
| 2 | Reading order เป็นงาน MVP | Overlay วางตามพิกัด → ลำดับไม่มีผลต่อการแสดงผลเลย ลำดับมีผลแค่กับ LLM context | **เลื่อน reading order ไป M6** ใช้ heuristic ง่ายๆ ไปก่อน |
| 3 | Local OCR = ฟรี + เบา | `manga-ocr` = encoder-decoder ~140–460 MB + autoregressive decode loop ต่อ 1 bubble | **นี่คือความเสี่ยงอันดับ 1 ของโปรเจกต์** ต้อง benchmark ก่อนเขียน extension |
| 4 | OCR engine เลือกทีหลังได้ | เลือกผิด = รื้อทั้ง pipeline | ทำ `OCRProvider` abstraction แบบเดียวกับ translation — มี WASM + Local Service |
| 5 | ใช้ comic-text-detector / YOLOv8 ได้เลย | comic-text-detector = **GPL-3.0**, YOLOv8/Ultralytics = **AGPL-3.0** (คลุมถึง weights) | ใช้ **PP-OCR detection (Apache-2.0)** + **manga-ocr (Apache-2.0)** |
| 6 | อ่าน `<img>` แล้ววาดลง canvas เพื่อ hash/OCR ได้ | canvas จะ **tainted** ทันทีถ้ารูปเป็น cross-origin ที่ไม่มี CORS header → อ่าน pixel ไม่ได้เลย | ต้อง `fetch` รูปใน **service worker** (ใช้ `host_permissions` ข้าม CORS) แล้ว decode ใน offscreen |
| 7 | `captureVisibleTab()` เป็น fallback ที่ใช้ได้สบาย | rate limit ~2 ครั้ง/วินาที + จับภาพ **overlay ของเราเองติดไปด้วย** | ใช้เป็นทางเลือกสุดท้าย ต้องซ่อน overlay ก่อนแคปทุกครั้ง |
| 8 | Google Translate ฟรี | Cloud Translation v3 = **$20 / 1M ตัวอักษร** (ต้องผูกบัตร) · `googletrans` = scrape endpoint ภายใน ผิด ToS + โดนแบน IP | ใช้ **Gemini API free tier** แทน — ทางการ, ไม่ต้องผูกบัตร, 1,000 req/วัน, batch ทั้งหน้า = 1 req |

**Go/No-Go gate:** ถ้า OCR 1 หน้า (5–20 bubble) ใน WASM ใช้เวลา > 8 วินาที → "Auto Translate on Scroll" จะไม่เป็น UX ที่ใช้ได้ ต้องสลับไป Local Service เป็น default
ดังนั้น **งานชิ้นแรกคือ benchmark ไม่ใช่ extension**

---

## 1. Pipeline ที่แก้แล้ว

Handoff เขียนไว้ว่า:

```
Detect → Capture → OCR → BBox → Reconstruction → Reading Order → Translate → Overlay → Cache
```

ของจริงควรเป็น:

```
1. Discover      หา manga image candidate ใน DOM              → MangaSource
2. Acquire       ดึง bytes จริง (ผ่าน SW) + hash + decode      → AcquiredImage
3. Detect        หา text region (PP-OCR det / detector อื่น)    → TextLine[]  (image space)
4. Group         รวม line → text block ต่อ bubble               → TextBlock[]
5. Recognize     manga-ocr อ่านทั้ง block                       → TextBlock + jaText  ← reconstruction จบตรงนี้
6. Order         จัดลำดับอ่าน (ใช้เฉพาะเป็น context)             → ordered TextBlock[]
7. Translate     batch ทั้งหน้า ผ่าน provider                    → thText
8. Layout        คำนวณกล่อง + ขนาดฟอนต์ใน normalized space      → OverlayBox[]
9. Render        วาดใน Shadow DOM เหนือรูป                      → DOM
10. Cache        เก็บแยก 2 ชั้น (OCR / Translation)
```

จุดที่ต่างสำคัญ: **ขั้น 5 กลืนขั้น "reconstruction" ทั้งหมด** และ **ขั้น 6 ถูกย้ายออกจาก critical path**

---

## 2. คำตอบ Q1 — จะ detect manga image ยังไง

### 2.1 Candidate scoring (ไม่ใช้ ML — ใช้ heuristic ก่อน)

เก็บ candidate จาก 4 แหล่ง แล้วให้คะแนน:

```ts
type MangaSourceKind = 'img' | 'canvas' | 'css-background' | 'screenshot-region';

interface MangaSource {
  kind: MangaSourceKind;
  el: Element;
  url?: string;              // resolved src / background-image url
  natural: { w: number; h: number };
  rendered: DOMRectReadOnly;
  score: number;
}
```

**Rule set (ให้คะแนนบวก/ลบ):**

| สัญญาณ | น้ำหนัก |
|---|---|
| `naturalWidth ≥ 500` และ `naturalHeight ≥ 500` | +3 |
| พื้นที่ rendered ≥ 30% ของ viewport width | +3 |
| aspect ratio อยู่ใน 0.45–1.8 (หน้ามังงะปกติ) | +2 |
| aspect ratio < 0.2 และ `naturalHeight > 2000` (webtoon strip) | +2 และตั้ง flag `longStrip` |
| อยู่ใน element ที่ id/class ตรง `/reader|viewer|page|chapter|comic|manga/i` | +2 |
| เป็นรูปที่ใหญ่ที่สุดใน container เดียวกัน | +1 |
| อยู่ใน `<nav> <header> <footer> <aside>` | −5 |
| id/class/alt ตรง `/avatar\|icon\|logo\|thumb\|banner\|ad/i` | −5 |
| อยู่ใน `<a>` ที่ลิงก์ออกนอก host | −2 |
| `naturalWidth < 300 \|\| naturalHeight < 300` | −5 |

ผ่านเกณฑ์ที่ `score ≥ 4` → เข้าคิว
ตัวเลขเหล่านี้เป็น **starting point ที่ต้องจูนด้วย fixture จริง** ไม่ใช่ค่าศักดิ์สิทธิ์

### 2.2 Site Profile Registry (กันการ hardcode ไปเว็บเดียว)

```ts
interface SiteProfile {
  id: string;
  match: (url: URL) => boolean;
  pageSelector?: string;             // ถ้ามี → ข้าม heuristic ทั้งหมด
  exclude?: string;                  // เช่น iframe โฆษณา
  acquire?: AcquireStrategy;         // 'auto' | 'content-script' | 'sw-fetch' | 'screenshot'
  sourceLang?: LangCode | 'auto';    // ถ้าเว็บมีหลายภาษา ให้ 'auto'
  readingDirection?: 'rtl' | 'ltr' | 'webtoon' | 'auto';

  // --- paged reader (§3.2) ---
  reader?: 'paged' | 'strip' | 'auto';
  pageKeyFromUrl?: (u: URL) => { setId: string; page: number } | null;
  nextPageUrl?: (u: URL, delta: number) => string | null;   // สำหรับ prefetch
  imageUrlForPage?: (ctx: SetContext, page: number) => string | null;
  navSelectors?: { next?: string; prev?: string };

  notes?: string;
}
```

MVP ลง registry 2 เว็บที่คุณอ่านจริง (mangadex, imhentai) + `DEFAULT_PROFILE` ที่ใช้ heuristic
โครงนี้ทำให้เพิ่มเว็บใหม่ = เพิ่มอ็อบเจ็กต์เดียว ไม่ต้องแตะ core

**Anti-pattern ที่ต้องเลี่ยง:** อย่าเขียน CSS selector ของเว็บใดเว็บหนึ่งลงใน core detector เด็ดขาด

---

## 3. คำตอบ Q2 — จะ detect content ใหม่ตอน scroll ยังไง

**อย่าใช้ scroll event เป็นตัวขับ** ใช้ 3 observer ประกอบกัน:

```ts
// 1) IntersectionObserver — ตัวขับหลัก
new IntersectionObserver(cb, {
  root: null,
  rootMargin: '200% 0px 100% 0px',   // preload ล่วงหน้า 2 หน้าจอด้านบน 1 ด้านล่าง
  threshold: 0.01,
});

// 2) MutationObserver — จับ lazy-load และ virtual list
new MutationObserver(cb).observe(document.documentElement, {
  childList: true, subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'style', 'class'],
});

// 3) ResizeObserver — จับ layout เปลี่ยน (responsive / zoom / sidebar)
new ResizeObserver(cb);   // observe เฉพาะรูปที่มี overlay อยู่
```

**rootMargin `200%` ด้านบน** สำคัญมากสำหรับ webtoon — เพราะผู้ใช้ scroll ลงเร็ว ต้องเริ่ม OCR ก่อนรูปโผล่ประมาณ 2 หน้าจอ ถึงจะทันแสดงผลพอดี

### 3.2 Paged Reader Adapter — เว็บที่ "กดทีละหน้า"

เว็บอ่านมังงะแบ่งเป็น 2 ตระกูลใหญ่ ต้องรองรับทั้งคู่เป็นพลเมืองชั้นหนึ่ง:

| | **Strip reader** | **Paged reader** |
|---|---|---|
| ตัวอย่าง | webtoon, MangaDex long strip | **imhentai**, MangaDex single page |
| ตัวขับ | scroll | **การเปลี่ยนหน้า** |
| รูปใน DOM | หลายรูปพร้อมกัน | มัก **1 รูป** |
| โอกาสที่ได้ | preload ตาม rootMargin | **prefetch หน้าถัดไปล่วงหน้าได้ทั้งชุด** |

#### 3.2.1 ปัญหาที่ paged reader สร้างขึ้นมาโดยเฉพาะ

**(ก) `<img>` ตัวเดิม แต่ `src` เปลี่ยน**
imhentai ใช้ `<img id="gimg">` ตัวเดียวตลอด แล้วสลับ `src` เมื่อเปลี่ยนหน้า

> 🔑 **กฎที่ตามมา: overlay ต้องผูกกับ `imageHash` ไม่ใช่กับ element**
> ถ้าผูกกับ element จะเกิดบั๊กร้ายแรง — คำแปลของหน้า 3 ค้างทับอยู่บนหน้า 4

```ts
// MutationObserver บน attribute 'src' ของ element ที่มี overlay อยู่
onSrcChanged(el) {
  overlayFor(el)?.invalidateImmediately();   // ซ่อนทันที ห้ามรอ OCR รอบใหม่
  scheduler.enqueue(resolveSource(el));      // hash ใหม่ → อาจ hit cache ขึ้นทันที
}
```

**(ข) การเปลี่ยนหน้าตรวจจับได้ 4 ทาง** — ต้องดักทั้งหมดเพราะแต่ละเว็บทำไม่เหมือนกัน
1. **URL เปลี่ยน** (imhentai: `/view/1706342/3/` → `/4/`) — ดักด้วย `navigation` API + patch `history.pushState/replaceState` + `popstate`
2. **`src` attribute เปลี่ยน** — MutationObserver (ครอบ SPA ที่ไม่เปลี่ยน URL)
3. **IntersectionObserver** — ครอบ pager ที่เลื่อนแนวนอน
4. **คลิก `navSelectors.next` / ปุ่มลูกศร** — ใช้เป็น *hint* ให้ prefetch เร็วขึ้นเท่านั้น ไม่ใช่ตัวขับหลัก

#### 3.2.2 Prefetch — ข้อได้เปรียบที่ทำให้ paged reader ดีกว่า strip

เมื่อ URL ของรูปคาดเดาได้ (imhentai: `https://m11.imhentai.xxx/032/{hash}/{n}.webp`)
เราสามารถ **fetch + OCR + แปลหน้าถัดๆ ไปล่วงหน้าใน background** ได้เลย

```
ผู้ใช้อยู่หน้า 3
  → SW prefetch หน้า 4, 5, 6  (default lookahead = 3)
  → OCR + แปล เข้า cache
  → ผู้ใช้กด "ถัดไป" → cache hit → คำแปลขึ้น "ทันที" (< 200 ms)
```

ทำให้ paged reader **รู้สึกเร็วกว่า strip reader** เพราะเรารู้ล่วงหน้าแน่นอนว่าหน้าถัดไปคืออะไร (strip ต้องเดาจาก scroll)

**กติกาความสุภาพ — บังคับ:**
- ยิงทีละ 1 request (`MAX_CONCURRENT_PREFETCH = 1`) เว้นระยะ ≥ 500 ms
- lookahead default **3 หน้า** (ปรับได้ 0–10 ใน settings)
- หยุด prefetch ทันทีเมื่อ tab ไม่ active หรือ battery saver
- **"โหลดทั้งตอนล่วงหน้า" ต้องเป็นปุ่มที่ผู้ใช้กดเอง** ไม่ใช่ default — ไม่งั้นเท่ากับยิงเซิร์ฟเวอร์เขารัวๆ

#### 3.2.3 Interface

```ts
interface ReaderAdapter {
  kind: 'paged' | 'strip';
  observe(onChange: (sources: MangaSource[]) => void): () => void;
  /** คืนรายการหน้าถัดไปที่ prefetch ได้ (paged เท่านั้น) */
  lookahead(n: number): PrefetchTarget[];
}
```
`PagedReaderAdapter` และ `StripReaderAdapter` แชร์ `scheduler` ตัวเดียวกัน
`core/` ไม่รู้จักคำว่า paged/strip เลย — รู้แค่ว่ามี `MangaSource` เข้ามาในคิว

### 3.3 Scheduler — หัวใจของ "ห้าม OCR ทุก scroll event"

```ts
class OcrScheduler {
  private queue: PriorityQueue<Job>;      // priority = ระยะห่างจากกลาง viewport
  private inflight = new Set<string>();   // กัน job ซ้ำ
  private done = new Map<string, Result>(); // L1 cache ต่อ tab
  private readonly MAX_CONCURRENT = 1;    // OCR กิน CPU — ห้ามขนาน
  enqueue(src: MangaSource): void;
  cancel(hash: string): void;             // ยกเลิกเมื่อเลื่อนพ้น viewport ไปไกล
}
```

กติกา:
- **จัดคิวใหม่ทุกครั้งที่ scroll หยุด 150 ms** (debounce) โดยเรียง priority ตามระยะจากกลางจอ
- Job ที่หลุด viewport ไปเกิน 3 หน้าจอ → `cancel()` ทิ้ง
- `inflight` + `done` + IndexedDB = กัน reprocess ครบ 3 ชั้น
- `MAX_CONCURRENT = 1` เพราะ OCR เป็น CPU-bound การขนานไม่ช่วยและทำให้หน้าเว็บกระตุก

---

## 4. คำตอบ Q3 — จัดการ `<img>` / canvas / CSS background / lazy load

### 4.1 ปัญหาที่ handoff ไม่ได้พูดถึง: **Canvas Tainting**

นี่คือกับดักที่จะทำให้แผนเดิมพังทันทีในเว็บจริง:

> ถ้าวาดรูป cross-origin ที่ไม่มี `Access-Control-Allow-Origin` ลง `<canvas>`
> → `getImageData()` และ `toDataURL()` จะ **throw SecurityError**
> → อ่าน pixel ไม่ได้ → OCR ไม่ได้ → hash ไม่ได้

เว็บมังงะเกือบทั้งหมด serve รูปจาก CDN ที่ไม่มี CORS header ดังนั้น **content script อ่าน pixel เองไม่ได้**

**ทางแก้:** ให้ service worker เป็นคนดึง bytes

```
content script                service worker (มี host_permissions)
     │  ACQUIRE_IMAGE {url, referrer}   │
     ├─────────────────────────────────►│
     │                                  │ fetch(url, {credentials:'include'})
     │                                  │ → ArrayBuffer (ไม่ติด CORS เพราะเป็น extension fetch)
     │                                  │ → sha256 → hash
     │                                  ├──────────► offscreen: createImageBitmap()
     │  ◄── {hash, cached?}             │
```

`host_permissions` ของ extension ทำให้ `fetch` ใน service worker ข้าม CORS ได้ — นี่คือเหตุผลหลักที่ **acquisition ต้องอยู่ใน service worker ไม่ใช่ content script**

### 4.2 กลยุทธ์ต่อชนิด source

> ⚠️ **ผลตรวจจริงจาก MangaDex (2026-08-14) พลิกลำดับความสำคัญ** — ดู §4.5

**Decision tree (เรียงตามลำดับที่ต้องลองจริง):**

```
1. currentSrc ขึ้นต้นด้วย blob: หรือ data:
   → content script fetch() → ArrayBuffer (transferable)      ← MangaDex อยู่ทางนี้
2. รูปโหลดเสร็จแล้ว และ canvas อ่านได้ (ลอง drawImage 8×8 + toDataURL)
   → content script: createImageBitmap(img) โดยตรง ไม่ต้อง fetch ซ้ำเลย
3. เป็น http(s) cross-origin ที่ canvas tainted
   → SW fetch(currentSrc, {credentials:'include'}) ข้าม CORS ด้วย host_permissions
4. อ่านไม่ได้ทุกทาง (WebGL / DRM / iframe ต่าง origin)
   → captureVisibleTab + crop (ซ่อน overlay ก่อน)
```

| ชนิด | วิธี acquire | หมายเหตุ |
|---|---|---|
| `blob:` URL | **content script `fetch()`** | ✅ **MangaDex ใช้ทางนี้** — blob ผูกกับ origin ของหน้า **SW fetch ไม่ได้เด็ดขาด** และเพราะ same-origin จึง **ไม่ tainted** อ่าน pixel ได้ตรงๆ |
| `data:` URL | content script decode | เหมือน blob |
| `<img src>` same-origin / มี CORS header | content script `createImageBitmap(img)` | ถูกที่สุด — ใช้ bitmap ที่เบราว์เซอร์ decode ไว้แล้ว |
| `<img src>` cross-origin ไม่มี CORS | **SW `fetch(currentSrc)`** | ใช้ `currentSrc` ไม่ใช่ `src` (รองรับ `srcset`/`<picture>`) |
| `<img>` lazy | รอ `img.complete && naturalWidth > 0` แล้วค่อย acquire | MutationObserver จับ `data-src → src` |
| `<canvas>` | `toBlob()` ใน content script → ถ้า `SecurityError` → screenshot | |
| CSS `background-image` | parse `url(...)` จาก `getComputedStyle` → SW fetch | ต้องอ่าน `background-size/position` เพื่อ map พิกัด |
| Custom reader / WebGL | screenshot fallback | |

**บทเรียน:** SW-fetch ไม่ใช่ทางหลักอย่างที่คิดตอนแรก — มันคือทางสำหรับ **cross-origin CDN ที่ไม่มี CORS** เท่านั้น
ส่วน reader สมัยใหม่ที่โหลดรูปเองด้วย JS (MangaDex, reader ที่มี DRM/ตัวนับหน้า) จะสร้าง `blob:` ซึ่ง **ต้องอ่านจาก content script เท่านั้น**
→ `acquire.ts` ต้องรองรับ **ทั้งสองทาง** ตั้งแต่ M1 ไม่ใช่ค่อยเพิ่มทีหลัง

### 4.3 Screenshot fallback — ข้อควรระวังที่ต้องออกแบบ

`chrome.tabs.captureVisibleTab()`:
- **rate limit** (documented `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`) → ต้อง throttle ฝั่งเราเอง ≥ 600 ms/ครั้ง
- จับที่ `devicePixelRatio` → ภาพที่ได้ใหญ่กว่า CSS pixel ต้องหารก่อน map พิกัด
- **จับ overlay ของเราติดไปด้วย** → ต้อง `overlayHost.style.visibility='hidden'` → `await raf()` → capture → คืนค่า
- จับได้เฉพาะส่วนที่เห็นจริง → webtoon ต้องต่อภาพหลายครั้ง
- ต้องมี `activeTab` หรือ host permission

สรุป: **fallback จริง ไม่ใช่ทางหลัก** และ MVP ควรรองรับแค่ `<img>` + `background-image` ให้ได้ก่อน

### 4.4 Ground truth: MangaDex (เว็บเป้าหมายหลัก)

ตรวจด้วย browser จริงบน `mangadex.org/chapter/...` เมื่อ 2026-08-14:

| สิ่งที่วัดได้ | ค่า | ผลต่อดีไซน์ |
|---|---|---|
| `img.currentSrc` | `blob:https://mangadex.org/585692f7-…` | 🔴 **SW fetch ใช้ไม่ได้** → ต้อง acquire จาก content script |
| canvas tainted? | **ไม่ tainted** (blob = same-origin) | 🟢 อ่าน pixel ได้ตรงๆ ไม่ต้อง fetch ซ้ำด้วยซ้ำ |
| ขนาดรูปจริง | **3496 × 4960** (17.3 MP, PNG 2.5 MB) | 🔴 ต้อง downscale ก่อน OCR — ดู §4.6 |
| ขนาดที่ render | 507 × 720 | อัตราส่วนย่อ ~6.9× |
| `object-fit` | **`contain`** | 🔴 `computeContentBox()` (§8.4) **จำเป็นจริง** ไม่ใช่เคสสมมติ |
| Reader container | `.md--reader-pages` · `.md--page > img.img` | site profile |
| Pager | `overflow-x-auto flex` + โหมด "Single Page" / "Fit Both" | 🟡 **เป็น paged reader ไม่ scroll แนวตั้ง** |
| รูปใน DOM | 3 รูป (หน้าปัจจุบัน + preload) โดย 2 รูปมี rect 0×0 | ต้องกรองด้วย rect ไม่ใช่แค่ `naturalWidth` |
| `createImageBitmap(img, {resizeWidth:1600})` | **111 ms** | 🟢 downscale ถูกและเร็ว |

**ข้อที่กระทบ mental model มากที่สุด:** MangaDex default เป็น **paged reader ที่ไม่ scroll**
ผู้ใช้กดเปลี่ยนหน้า ไม่ได้เลื่อน → "Auto Translate on **Scroll**" ต้องถูกนิยามใหม่เป็น
**"Auto Translate on Visibility Change"**

โชคดีที่ `IntersectionObserver` ครอบทั้งสองแบบอยู่แล้ว (§3) แต่ต้องเพิ่ม:
- **ห้ามพึ่ง scroll event เป็นตัวขับหลัก** — บน MangaDex มันแทบไม่ยิงเลย
- รูปที่ preload ไว้ (rect 0×0) เป็นโอกาสทอง: **OCR ล่วงหน้าตั้งแต่ยังไม่แสดง** → ผู้ใช้กดหน้าถัดไปแล้วเห็นคำแปลทันที
- MangaDex มีโหมด **Long Strip** ด้วย → site profile ต้องตรวจโหมดปัจจุบัน ไม่ใช่ hardcode

```ts
// site-profiles/mangadex.ts
export const mangadex: SiteProfile = {
  match: (u) => u.hostname === 'mangadex.org',
  pageSelector: '.md--page img.img',
  readingDirection: 'rtl',        // ตรวจจากโหมด reader อีกที
  acquire: 'content-script',      // blob: — SW fetch ไม่ได้
  preloadHidden: true,            // OCR รูปที่ rect 0×0 ล่วงหน้า
};
```

### 4.4b Ground truth: imhentai (เว็บเป้าหมายที่ 2 — เคสตรงข้ามกับ MangaDex)

ตรวจ DOM จริงที่ `/view/1706342/3/` เมื่อ 2026-08-14:

| สิ่งที่วัดได้ | ค่า | ผล |
|---|---|---|
| element | **`<img id="gimg" class="preloader image_3">` ตัวเดียว** | 🔴 เปลี่ยนหน้า = `src` เปลี่ยนบน element เดิม → **overlay ต้องผูก hash ไม่ใช่ element** |
| src | `https://m11.imhentai.xxx/032/{hash}/3.webp` | 🟢 **URL คาดเดาได้** → prefetch หน้าถัดไปได้ |
| canvas | **tainted** | 🔴 content script อ่าน pixel ไม่ได้ |
| `fetch()` จาก page context | **CORS blocked** | 🔴 → **ต้องใช้ SW fetch เท่านั้น** |
| ขนาด | **1280 × 1808** WebP (render 1150 × 1652) | 🔴 **เล็กกว่า MangaDex 2.7×** → ห้าม upscale (§4.5) และตัวหนังสือใน bubble สูงแค่ ~20–30 px → **detection ยากกว่า** ต้องเข้า benchmark M0 |
| จำนวนหน้า | 310 | prefetch/preload ทั้งเล่มต้องมี budget ไม่งั้นบวมมาก |
| URL ต่อหน้า | `/view/{galleryId}/{page}/` | 🟢 ดัก page change จาก URL ได้ตรงๆ |
| nav | `a.next_img` (คลิกที่รูป), `a.nav_next`, `a.page_next` | hint สำหรับ prefetch |
| หน้า gallery index | thumb ใช้ `data-src` + `class="lazy"` + SVG placeholder | เคส lazy-load มาตรฐาน |
| iframe | 1–3 อัน (โฆษณา) | ต้อง `exclude` |

**เทียบสองเว็บ — ทำไมสองเว็บนี้เป็นชุดทดสอบที่ดีมาก:**

| | MangaDex | imhentai |
|---|---|---|
| URL รูป | `blob:` same-origin | https cross-origin CDN |
| canvas | ไม่ tainted | **tainted** |
| acquire | **content script** | **SW fetch** |
| element | 3 img แยกกัน | **1 img สลับ src** |
| prefetch | ทำไม่ได้ (blob สร้างโดย JS ของเว็บ) | **ทำได้เต็มที่** |
| ภาษา | JA / EN | **JA และ EN ปนกันในเว็บเดียว** → ต้อง auto-detect |

ทำงานได้ทั้งสองเว็บ = ครอบคลุม acquisition path เกือบทั้งหมดที่มีในโลกจริง

```ts
// site-profiles/imhentai.ts
export const imhentai: SiteProfile = {
  id: 'imhentai',
  match: (u) => /(^|\.)imhentai\./.test(u.hostname),
  pageSelector: '#gimg',
  exclude: 'iframe *',
  acquire: 'sw-fetch',            // cross-origin CDN, canvas tainted
  reader: 'paged',
  sourceLang: 'auto',             // มีทั้ง JA และ EN
  readingDirection: 'auto',
  pageKeyFromUrl: (u) => {
    const m = u.pathname.match(/^\/view\/(\d+)\/(\d+)\/?$/);
    return m ? { setId: m[1], page: +m[2] } : null;
  },
  nextPageUrl: (u, d) => {
    const k = imhentai.pageKeyFromUrl!(u);
    return k ? `/view/${k.setId}/${k.page + d}/` : null;
  },
  navSelectors: { next: 'a.next_img, a.nav_next', prev: 'a.nav_prev' },
};
```

### 4.4c Ground truth: Shonen Jump+ (เว็บที่ยากที่สุด — canvas DRM)

ตรวจจริงที่ `shonenjumpplus.com/episode/...` เมื่อ 2026-08-14 — ใช้ **Giga Viewer** ของ Shueisha:

| สิ่งที่วัดได้ | ค่า | ผล |
|---|---|---|
| element | **`<canvas class="page-image js-page-image">` × 5** ไม่มี `<img>` ของหน้าเลย | 🔴 ไม่มี URL รูปให้ fetch |
| `canvas.toDataURL()` | **`SecurityError` — tainted** | 🔴 |
| `ctx.getImageData()` | **`SecurityError` — tainted** | 🔴 อ่าน pixel ไม่ได้เลยทุกทาง |
| canvas backing store | 760 × 1200 | |
| **ขนาดที่ render จริง** | **371 × 586** (dpr 1) | 🔴🔴 **เล็กมาก** ตัวหนังสือใน bubble จะสูงราว **8–12 px** |
| layout | pager แนวนอน 5 canvas, `align-right`/`align-left` | อ่านคู่หน้า (spread) แบบ RTL |

**→ เว็บนี้เหลือทางเดียวคือ `captureVisibleTab()` + crop** ซึ่งเป็นทางที่แย่ที่สุดในทุกมิติ:
rate limit ~2/วินาที · ต้องซ่อน overlay ก่อนแคปทุกครั้ง · และ**ได้ความละเอียดเท่าที่หน้าจอแสดงจริง**

#### ขอบเขตที่ต้องไม่ข้าม ⚖️

Giga Viewer สับ tile รูปแล้วประกอบใหม่ใน canvas เป็น **มาตรการป้องกันทางเทคนิค**

- ✅ **ทำได้:** อ่านสิ่งที่แสดงบนหน้าจอแล้ว (screenshot) — หลักการเดียวกับ screen reader / เครื่องมือช่วยการเข้าถึง
- ❌ **ห้ามทำ:** ย้อนวิศวกรรมอัลกอริทึมสับ tile เพื่อดึงและประกอบไฟล์ต้นฉบับ

`SiteProfile` ของเว็บกลุ่มนี้ต้องเป็น `acquire: 'screenshot'` **เท่านั้น** และห้ามมีโค้ด descramble ในโปรเจกต์

#### ความละเอียดคือปัญหาจริง ไม่ใช่ปัญหารอง

ตัวหนังสือสูง 8–12 px **ต่ำกว่าที่ OCR ส่วนใหญ่อ่านได้** (manga-ocr เทรนบน crop ที่คมกว่านี้มาก)

ทางแก้ที่ทำได้ เรียงตามลำดับที่ควรลอง:
1. **บอกผู้ใช้ให้ขยาย** — เต็มจอ + ซูมเบราว์เซอร์ 150–200% ทำให้ canvas render ใหญ่ขึ้นจริง → screenshot ได้ pixel มากขึ้นจริง
2. จอ HiDPI (`devicePixelRatio` 2) ได้ pixel เพิ่มฟรีเท่าตัว
3. **super-resolution ก่อน OCR** (ESRGAN-lite / Real-CUGAN ตัวเล็ก) — เพิ่มงานอีกโมเดล เก็บไว้ทีหลัง
4. ถ้าไม่ไหวจริง → แสดงข้อความชัดเจนว่า "เว็บนี้ความละเอียดไม่พอ กรุณาซูม" **ดีกว่าแปลมั่ว**

> 🔴 **ต้องเข้า benchmark M0:** วัด accuracy ที่ 371 px / 760 px / 1280 px / 3500 px
> ถ้า 371 px อ่านไม่ออก ต้องรู้ตั้งแต่ M0 เพื่อออกแบบ UX "กรุณาซูม" ไม่ใช่ไปเจอตอน M5

### 4.4d สรุป: 3 เว็บ = ครบทุก acquisition path

| | MangaDex | imhentai | **Shonen Jump+** |
|---|---|---|---|
| source | `<img>` `blob:` | `<img>` cross-origin | **`<canvas>`** |
| canvas tainted | ❌ ไม่ | ✅ ใช่ | ✅ **ใช่ (อ่านไม่ได้เลย)** |
| acquire | **content script** | **SW fetch** | **screenshot** |
| ความละเอียด | 3496 px 🟢 | 1280 px 🟡 | **371 px** 🔴 |
| prefetch | ไม่ได้ | **ได้** | ไม่ได้ |
| element | 3 img แยก | **1 img สลับ src** | 5 canvas |
| ภาษา | JA / EN | JA + EN ปนกัน | JA |

**ทำงานได้ครบ 3 เว็บนี้ = ครอบคลุมเว็บมังงะเกือบทั้งโลก** ใช้เป็นชุดทดสอบมาตรฐานของโปรเจกต์

```ts
// site-profiles/gigaviewer.ts — ครอบ shonenjumpplus + tonarinoyj + comic-days ฯลฯ
export const gigaViewer: SiteProfile = {
  id: 'gigaviewer',
  match: (u) => /shonenjumpplus\.com|tonarinoyj\.jp|comic-days\.com/.test(u.hostname),
  pageSelector: 'canvas.js-page-image',
  acquire: 'screenshot',          // canvas tainted — ไม่มีทางอื่น
  reader: 'paged',
  sourceLang: 'ja',
  readingDirection: 'rtl',
  notes: 'Giga Viewer. อ่านเฉพาะสิ่งที่ render แล้วเท่านั้น ห้าม descramble',
};
```

### 4.5 Resolution policy — อย่าส่งภาพ 17 MP เข้า OCR

รูป MangaDex คือ 3496×4960 ถ้าเก็บเป็น bitmap เต็มความละเอียด = **69 MB RAM ต่อ 1 หน้า**

```ts
// 🔴 ห้าม upscale — imhentai กว้างแค่ 1280 px ถ้าขยายเป็น 1600 จะช้าขึ้น 1.5× โดยไม่ได้ข้อมูลเพิ่มเลย
const detW = Math.min(DET_TARGET /* 1600 */, natural.w);
const recW = Math.min(REC_TARGET /* 2048 */, natural.w);
```

```
MangaDex 3496×4960 → detBitmap 1600  · recBitmap 2048   (ย่อจริง)
imhentai 1280×1808 → detBitmap 1280  · recBitmap 1280   (ใช้ต้นฉบับ ไม่แตะ)
```
- manga-ocr รับ input 224×224 → bubble crop ที่ ~400 px กว้างก็เกินพอ ไม่ต้องใช้ต้นฉบับ
- ปล่อย bitmap ต้นฉบับทันทีหลังสร้าง 2 ตัวนี้ (`.close()`)
- ทั้ง 2 ค่าเป็น setting ใน performance preset (Fast / Balanced / Quality)
- **hash คำนวณจาก bytes ต้นฉบับ ไม่ใช่จาก bitmap ที่ย่อแล้ว** — ไม่งั้น cache จะพังเมื่อเปลี่ยน preset

### 4.6 Webtoon long strip — เคสที่ handoff ตกไป

รูปยาว 800×12000 px ทำ OCR ทั้งใบไม่ได้ (RAM + เวลา)

**วิธี:** ตัดเป็น slice ตาม viewport พร้อม overlap
```
sliceHeight = 1400 px (image space)
overlap     = 200 px      ← กันตัดกลาง bubble
```
- OCR เฉพาะ slice ที่ intersect กับ viewport (+ preload margin)
- cache key = `${imageHash}:${sliceIndex}`
- **dedupe ในโซน overlap**: block ที่ IoU > 0.6 กับ block จาก slice ข้างเคียง → ตัดทิ้งอันที่ confidence ต่ำกว่า

---

## 5. คำตอบ Q4 + Q5 — เลือก OCR engine และ รันที่ไหน

### 5.1 ตารางเปรียบเทียบ

| Engine | ความแม่นกับมังงะ JA | แนวตั้ง | Detection? | ขนาด | Runtime ในเบราว์เซอร์ | License |
|---|---|---|---|---|---|---|
| **manga-ocr** (kha-white) | **สูงมาก** (เทรนบน Manga109) | **ได้ในตัว** | ❌ recognition อย่างเดียว | 140–460 MB (ONNX) | ort-web / transformers.js | **Apache-2.0** |
| PaddleOCR PP-OCRv5/v6 (ja) | ปานกลาง | **แย่** — อ่านแนวตั้งเป็นแนวนอน | ✅ det + rec | ~10–90 MB | ort-web + WebGPU (พิสูจน์แล้ว) | **Apache-2.0** |
| Tesseract.js (`jpn_vert`) | **ต่ำ** กับข้อความบนภาพ | มี traineddata แต่ผลแย่ | ✅ | ~15 MB | WASM | Apache-2.0 |
| comic-text-detector | — (detector) | ✅ ให้ direction ด้วย | ✅ det อย่างเดียว | ~30 MB | ort-web | ⚠️ **GPL-3.0** |
| YOLOv8-seg speech bubble | — (detector) | — | ✅ | ~50 MB | ort-web | ⚠️ **AGPL-3.0** (คลุม weights) |
| Google Cloud Vision API | สูง | ดี | ✅ | cloud | — | จ่ายเงิน + ส่งภาพออกนอก |

### 5.2 ข้อสรุป: **Hybrid — PP-OCR det (หา) + manga-ocr rec (อ่าน)**

```
image
 → PP-OCRv5 det (ONNX, ~5 MB, forward pass เดียว, เร็ว)   → text line polygons
 → group lines → text blocks (1 block ≈ 1 speech bubble)
 → crop block → manga-ocr                                  → ญี่ปุ่นเต็มประโยค เรียงถูกแล้ว
```

**เหตุผล**
1. manga-ocr ชนะขาดเรื่องความแม่น + รองรับแนวตั้ง/furigana/ข้อความบนภาพ ในตัว — และมันคืนทั้ง bubble เป็นประโยคเดียว **นี่คือคำตอบของ Q6 (vertical reconstruction) ทั้งข้อ**
2. PP-OCR det เบามาก และเราใช้แค่ **ตำแหน่ง** ไม่ใช้ผลอ่านของมัน → จุดอ่อนเรื่องแนวตั้งของ PaddleOCR ไม่มีผล
3. ทั้งคู่ Apache-2.0 → แจกจ่ายได้ไม่ติดปัญหา ต่างจาก comic-text-detector (GPL) และ YOLOv8 (AGPL)

**Known failure mode ที่ต้องกัน:** manga-ocr *"always attempts to recognize some text"* — ถ้าป้อน crop เปล่าจะ**แต่งประโยคญี่ปุ่นขึ้นมาเอง**
กัน 3 ชั้น: (a) กรอง det confidence < 0.5, (b) ทิ้ง crop ที่ ink ratio < 2%, (c) ทิ้งผลที่ซ้ำแบบวนลูป (`ぁぁぁぁ`) หรือยาวผิดสัดส่วนกับขนาดกล่อง

### 5.2.1 Multi-language — JA→TH, EN→TH, และภาษาอื่นในอนาคต

> ⚠️ **manga-ocr อ่านได้เฉพาะภาษาญี่ปุ่น** — ใช้กับ EN ไม่ได้เลย
> นี่เป็นเหตุผลว่าทำไม pipeline ต้องแยก **detector** ออกจาก **recognizer** ตั้งแต่ต้น

**คุณสมบัติที่ช่วยเราไว้:** PP-OCR **detection** เป็น *language-agnostic* — มันหาว่า "ตรงไหนมีตัวหนังสือ" โดยไม่สนใจว่าเป็นภาษาอะไร
→ **เปลี่ยนแค่ recognizer ก็รองรับภาษาใหม่ได้** ส่วน detect / group / layout / render / cache ใช้โค้ดเดิมทั้งหมด

```ts
type LangCode = 'ja' | 'en' | 'ko' | 'zh' | 'auto';

interface LanguagePack {
  code: Exclude<LangCode, 'auto'>;
  recognizer: TextRecognizer;              // ตัวเดียวที่เปลี่ยนตามภาษา
  defaultDirection: 'vertical' | 'horizontal';
  defaultReadingOrder: 'rtl' | 'ltr';
  groupingTuning: GroupingThresholds;      // ช่องไฟ Latin ≠ ช่องไฟ CJK
}
```

| ภาษา | Recognizer | ขนาด | ความเร็ว | สถานะ |
|---|---|---|---|---|
| **ja** | **manga-ocr** (Apache-2.0) | 140–460 MB | ช้า (autoregressive ต่อ bubble) | **M0–M4** |
| **en** | **PP-OCR rec latin/en** (Apache-2.0) | **~10 MB** | **เร็วมาก** (CRNN forward pass เดียว ไม่มี decode loop) | **M5** |
| ko | PP-OCR rec korean | ~10 MB | เร็ว | อนาคต |
| zh | PP-OCR rec chinese | ~10 MB | เร็ว | อนาคต |

> 🟢 **ข่าวดี: EN→TH จะเร็วกว่า JA→TH หลายเท่า** — PP-OCR rec เป็น CRNN ตัวเล็กที่ไม่มี autoregressive decode
> ปัญหาความเร็วที่เป็นความเสี่ยงอันดับ 1 ของโปรเจกต์ (§0 ข้อ 3) **มีเฉพาะกับภาษาญี่ปุ่นเท่านั้น**

#### การเลือกภาษาต้นทาง (3 ชั้น เรียงตามลำดับความสำคัญ)

```
1. ผู้ใช้เลือกเองใน popup       → ชนะทุกอย่าง (จำต่อ gallery/series)
2. site profile ระบุ sourceLang → เช่นเว็บที่มีแต่ JA
3. auto-detect                  → เมื่อทั้งสองข้อบนไม่มี (imhentai มีทั้ง JA และ EN)
```

**Auto-detect แบบถูกและแม่นพอ** — ไม่ต้องใช้โมเดลแยก:
```
1. รัน detection (ต้องทำอยู่แล้ว) → เอา 3 block ที่ใหญ่ที่สุด
2. รัน PP-OCR rec latin (10 MB, ~20 ms) บน 3 block นั้น
3. ถ้าผลออกมาเป็น ASCII อ่านรู้เรื่อง + confidence สูง  → 'en'  ✅ จบ (ผลใช้ได้เลย ไม่เสียของ)
   ถ้า confidence ต่ำ / เป็นขยะ                        → 'ja'  → โหลด manga-ocr แล้วอ่านใหม่
4. จำผลไว้ต่อ "ชุด" (galleryId / seriesId) — จ่ายแค่ครั้งเดียวต่อเรื่อง
```
เสียเวลาเพิ่มแค่ ~60 ms ต่อเรื่อง และถ้าเป็น EN ก็ **ไม่ต้องโหลด manga-ocr 400 MB เลย**

#### สิ่งที่ต้องเป็น parameter ไม่ใช่ค่าคงที่ (ตั้งแต่ M1)

| จุด | ก่อน | หลัง |
|---|---|---|
| Cache key OCR | `${ocrId}@${v}:${hash}` | `${detId}@${v}:${recId}@${v}:${hash}` — recognizer id ผูกกับภาษาอยู่แล้ว |
| Cache key แปล | `${provider}:th:${sha1}` | **`${provider}@${model}:${from}-${to}:${sha1(text)}`** |
| Prompt | "แปลญี่ปุ่น→ไทย" | `translate(from, to)` — เปลี่ยนแค่ตัวแปรในเทมเพลต |
| Reading order | RTL เสมอ | มาจาก `LanguagePack.defaultReadingOrder` (ja→rtl, en→ltr) |
| Direction detect | อนุมานแนวตั้งได้ | EN แทบไม่มีแนวตั้ง → threshold ต่างกัน |

> 🔑 **ต้นทุนของการรองรับหลายภาษาเกือบทั้งหมดคือ "อย่า hardcode `ja` และ `th`"**
> ถ้าทำถูกตั้งแต่ M1 การเพิ่ม EN ที่ M5 จะเหลือแค่ "เพิ่ม `LanguagePack` 1 ตัว"
> ถ้าทำผิด จะต้องไล่แก้ cache key + prompt + reading order ทั้งระบบ

**ภาษาปลายทาง:** ตอนนี้ไทยอย่างเดียว แต่ `to` เป็น parameter อยู่แล้ว → เพิ่มภาษาอื่นคือแก้ dropdown อย่างเดียว
(ข้อควรระวังจริงอยู่ที่ **การจัดบรรทัด** ไม่ใช่การแปล — ไทยไม่มีช่องว่างระหว่างคำ ต้องใช้ `word-break` / ICU segmenter คนละชุดกับภาษาที่มีช่องว่าง)

### 5.3 Q5 — Browser/WASM หรือ Local Service?

**คำตอบ: ออกแบบให้เป็น provider แล้วให้ benchmark ตัดสิน**

```ts
interface OCRProvider {
  readonly id: 'wasm' | 'local-service';
  readonly version: string;              // เข้า cache key
  init(onProgress?: (p: number) => void): Promise<void>;
  isReady(): boolean;
  recognize(img: ImageBitmap | Blob, opts?: OcrOptions): Promise<TextBlock[]>;
  dispose(): void;
}
```

| | WASM in-browser | Local Service (sidecar) |
|---|---|---|
| ติดตั้ง | zero-config ✅ | ผู้ใช้ต้องรัน server ❌ |
| ความเร็ว | ช้า (WebGPU ช่วยได้แต่ไม่การันตีกับ decoder loop) | **เร็วมาก** (CUDA / DirectML) |
| ครั้งแรก | ดาวน์โหลด 140–460 MB | ดาวน์โหลดตอนติดตั้ง server |
| RAM | กินของ tab | แยกโปรเซส ✅ |
| Privacy | ดีที่สุด | ดี (localhost) |

**แผน:**
- **M0 benchmark** วัดจริงว่า WASM/WebGPU ทำได้กี่วินาที/หน้า
- **Default = WASM** ถ้าผลได้ ≤ 8 วิ/หน้า (พร้อม preload margin จะรู้สึกเหมือน instant)
- **มี Local Service เป็น "Turbo mode"** เสมอ — คุณจะรัน Ollama อยู่แล้ว การเพิ่ม FastAPI + manga-ocr อีกตัวไม่เพิ่มภาระมาก
- ทั้งสองใช้ `OCRProvider` เดียวกัน → สลับได้จาก settings โดยไม่ต้องแก้ pipeline

**ทำไมต้อง Offscreen Document:** MV3 service worker **ไม่มี DOM, ไม่มี `createImageBitmap` ที่ครบ, และถูก terminate หลัง idle ~30 วิ** → รัน ONNX ไม่ได้จริง
ดังนั้น ML ทั้งหมดอยู่ใน **offscreen document** (เหตุผล: `reasons: ['WORKERS','BLOBS']`) ซึ่งอยู่ยาวและมี DOM/OffscreenCanvas/WebGPU ครบ

CSP ที่ต้องใส่ใน manifest:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
}
```
⚠️ known issue: worker thread ใน extension โดน CSP คนละชุด ทำให้โหลด `.wasm` พลาด → เริ่มด้วย `ort.env.wasm.numThreads = 1` แล้วค่อยลองเปิด thread ทีหลัง

**Model delivery:** อย่า bundle 400 MB ลง .crx — ดาวน์โหลดครั้งแรกเข้า **Cache Storage / OPFS** แล้วโหลดจากที่นั่น (model weights = data ไม่ใช่ remote code จึงไม่ผิดกฎ MV3)

---

## 6. คำตอบ Q6 — Japanese vertical text reconstruction

### 6.1 ปัญหาถูกย้ายที่

Handoff คิดว่า OCR จะคืน **ตัวอักษรทีละตัว** แล้วเราต้องเรียง
ของจริงกับ pipeline ที่เลือก:

```
crop bubble ─→ manga-ocr ─→ "これは何？"     ← เรียบร้อยแล้ว ไม่ต้องทำอะไร
```

manga-ocr รองรับ multi-line ใน forward pass เดียว, รู้จักทั้งแนวตั้ง/แนวนอน, และข้าม furigana ให้
**ดังนั้นงานที่เหลือคือ "จับ line ให้เป็น block ให้ถูก" ซึ่งอยู่ก่อน OCR ไม่ใช่หลัง OCR**

### 6.2 Line → Block grouping (สิ่งที่ต้องเขียนจริง)

PP-OCR det คืน polygon ระดับบรรทัด สำหรับข้อความแนวตั้ง 1 บรรทัด = 1 คอลัมน์แคบสูง

```ts
function detectDirection(line: Poly): 'vertical' | 'horizontal' {
  const { w, h } = boundsOf(line);
  if (h / w >= 1.4) return 'vertical';
  if (w / h >= 1.4) return 'horizontal';
  return 'horizontal';           // สั้นๆ เช่น "え？" → เดาแนวนอน
}
```

รวมเป็น block เมื่อครบทุกข้อ:
1. `direction` เดียวกัน
2. ขนาดตัวอักษรใกล้กัน — `0.6 ≤ sizeA/sizeB ≤ 1.66`
   (แนวตั้ง: size = width; แนวนอน: size = height)
3. **ซ้อนทับตามแกนอ่าน ≥ 50%** (แนวตั้ง: ช่วง y ต้องซ้อนกัน)
4. **ระยะตามแกนตั้งฉาก < 1.5 × ขนาดตัวอักษร** (ช่องไฟระหว่างคอลัมน์)

ใช้ **union-find** เพื่อเชื่อมแบบ transitive แล้วคืน bounding box ของแต่ละกลุ่ม
สำหรับ crop ป้อน manga-ocr: **ขยาย padding 6% ทุกด้าน** — ตัวอักษรริมมักโดนตัด

> ⚠️ อย่ารวม 2 bubble ที่อยู่ติดกันเป็น block เดียว — จะได้ประโยคปนกัน
> ถ้าเจอปัญหานี้บ่อย ค่อยเพิ่ม bubble-mask (PP-OCR det ให้ segmentation map มาด้วย ใช้เช็คว่า 2 line อยู่ในพื้นที่ขาวต่อเนื่องกันไหม)

### 6.3 โมดูลนี้ต้องเป็น pure function
`groupLinesIntoBlocks(lines: TextLine[]): TextBlock[]` — ไม่แตะ DOM ไม่แตะ network
→ unit-test ด้วย fixture JSON ได้ 100% ปรับ threshold ได้เร็วโดยไม่ต้องรัน browser

---

## 7. คำตอบ Q7 — Reading order algorithm

### 7.1 ความจริงที่ต้องพูดก่อน

**Overlay ไม่ต้องใช้ reading order เลย** เพราะแต่ละ block วาดที่พิกัดของตัวเอง
ลำดับมีผลกับ 2 อย่างเท่านั้น:
1. ลำดับ context ที่ส่งให้ LLM
2. โหมด "Japanese + Thai" แบบ side panel (ถ้าทำ)

→ **MVP ใช้ heuristic ง่ายๆ พอ ยังไม่ต้อง perfect**

### 7.2 M1–M5: Column-band sort (~20 บรรทัด)

```
1. จัดกลุ่ม block เป็น "แถบคอลัมน์" ตามการซ้อนทับของช่วง x
2. เรียงแถบจาก ขวา → ซ้าย
3. ภายในแถบ เรียง บน → ล่าง
```
ถูกต้องพอใช้กับหน้าที่มี panel เรียงเป็นตาราง ซึ่งคือส่วนใหญ่

### 7.3 M6: Recursive XY-Cut แบบ RTL (ถูกต้องกับ layout จริง)

```
readingOrder(blocks, bounds):
  ถ้า blocks ≤ 1 → return blocks
  หา "ช่องว่างขาว" ที่กว้างที่สุดที่ตัดผ่านทั้ง bounds โดยไม่ตัดโดน block ใดเลย
    - ลองแนวตั้ง (แบ่งซ้าย/ขวา) และแนวนอน (แบ่งบน/ล่าง)
  ถ้าไม่มีช่องว่างที่กว้างพอ (< 3% ของด้าน) → fallback column-band sort
  เลือกช่องว่างที่กว้างกว่า:
    ตัดแนวตั้ง  → recurse(ฝั่งขวา) ++ recurse(ฝั่งซ้าย)     ← RTL
    ตัดแนวนอน  → recurse(ฝั่งบน)  ++ recurse(ฝั่งล่าง)
```

ประมาณ 80 บรรทัด, pure function, จัดการ panel ซ้อนชั้นได้ถูกต้อง, unit-test ง่าย
ตรงกับที่ handoff ขอ: *"group regions → detect local layout → determine reading order"* โดยไม่ต้อง detect panel จริง

สำหรับ webtoon (`readingDirection: 'webtoon'`) → ข้าม XY-cut ใช้ **เรียงตาม y อย่างเดียว**

---

## 8. คำตอบ Q12 — Coordinate system (ส่วนที่ handoff เตือนว่า "ต้องออกแบบดีๆ")

### 8.1 กฎเหล็ก: มี canonical space เดียว = **Normalized Image Space**

ทุก bbox ที่ออกจาก OCR ให้แปลงเป็น `[0,1]` เทียบ `naturalWidth/naturalHeight` **ทันที** แล้วห้ามเก็บ pixel ที่ไหนอีก

```ts
interface NormRect { x: number; y: number; w: number; h: number }  // ทุกค่า 0..1
```

**ทำไม:** cache จะใช้ได้ข้ามขนาดจอ ข้าม zoom ข้าม responsive breakpoint และข้ามเครื่อง
ถ้าเก็บเป็น pixel ของ viewport → cache จะพังทันทีที่ผู้ใช้ย่อหน้าต่าง

Space ทั้งหมดในระบบ:
```
Screenshot px ──(÷ dpr, − rect)──►
Image px      ──(÷ natural)──►  Normalized [0,1]   ◄── canonical, เก็บใน cache
                                       │
                                       └──(× 100%)──► CSS % ในกล่อง overlay
```

### 8.2 การ render — ใช้ % + container query units → responsive ฟรี

```html
<!-- overlay host: absolute ทับพอดีกับ <img> -->
<div class="mt-layer" style="container-type: size">
  <div class="mt-box" style="left:31.2%; top:8.4%; width:14.9%; height:23.1%;">
    <span class="mt-text">นี่คืออะไร?</span>
  </div>
</div>
```

```css
.mt-box  { position: absolute; }
.mt-text { font-size: clamp(9px, var(--mt-fs) * 1cqw, 40px); }
```

**ผลลัพธ์:** ผู้ใช้ย่อ/ขยายหน้าต่าง → กล่อง **และขนาดฟอนต์** ขยับตามเองโดย **ไม่ต้องรัน JS แม้แต่บรรทัดเดียว**
นี่คือคำตอบของ *"overlay ต้อง align ตอน responsive resizing"* ทั้งข้อ — แก้ที่ CSS ไม่ใช่ที่ JS

### 8.3 การผูก overlay กับรูป — โดยไม่ทำ DOM ของเว็บพัง

**ห้าม** ทำ: ห่อ `<img>` ด้วย `<div>` ใหม่ / แก้ `position` ของ element เว็บ / ใส่ลูกใน element ของเว็บ
เว็บสมัยใหม่ (React/Vue) จะ re-render ทับหรือ layout พัง

**ทำ:** สร้าง host เดียวที่ `document.body` แล้ววางด้วยพิกัดหน้าเอกสาร

```
<body>
  ...เนื้อหาเว็บเดิม ไม่ถูกแตะเลย...
  <manga-translator-root>          ← custom element + Shadow DOM (closed)
    #shadow-root
      <div class="mt-layer" data-for="hash1" style="position:absolute; ...">
      <div class="mt-layer" data-for="hash2" ...>
  </manga-translator-root>
</body>
```

Sync loop:
```ts
// ทำงานเฉพาะตอน "dirty" — ไม่ใช่ทุก frame
let dirty = false;
addEventListener('scroll', () => dirty = true, { passive: true, capture: true });
resizeObserver.observe(img);  // → dirty = true
function tick() {
  if (dirty) {
    for (const layer of visibleLayers) {          // ปกติ ≤ 5 ตัว
      const r = layer.img.getBoundingClientRect();
      layer.el.style.transform =
        `translate(${r.left + scrollX}px, ${r.top + scrollY}px)`;
      layer.el.style.width  = `${r.width}px`;
      layer.el.style.height = `${r.height}px`;
    }
    dirty = false;
  }
  requestAnimationFrame(tick);
}
```

ใช้ `transform` ไม่ใช่ `left/top` → GPU compositing ไม่เกิด layout reflow
อ่าน `getBoundingClientRect()` แค่ ≤ 5 ตัว/เฟรม → ไม่กระตุก

**Style isolation:** Shadow DOM + `all: initial` ที่ root + host ตั้ง `z-index: 2147483646; pointer-events: none`
(กล่องข้อความตั้ง `pointer-events: auto` เฉพาะตอนเปิด "hover เพื่อดูต้นฉบับ")

### 8.4 กรณี `object-fit` / CSS background
ถ้ารูปถูกครอบด้วย `object-fit: cover/contain` หรือเป็น background ที่มี `background-size`
→ พื้นที่แสดงผลจริง ≠ `getBoundingClientRect()`
ต้องคำนวณ **content box** ก่อน แล้วค่อย map normalized เข้าไป
เขียนเป็น pure function `computeContentBox(rect, natural, objectFit, objectPosition): DOMRect` + unit test

---

## 9. คำตอบ Q8 — Cache design

### 9.1 แยก cache 2 store — ห้ามรวมเป็นก้อนเดียว

handoff เสนอ `TranslationCache { contentHash, ocrResult, translation }` ก้อนเดียว
**ปัญหา:** เปลี่ยน translation provider ทีนึง → OCR ที่แพงกว่า 10 เท่าโดนล้างทิ้งด้วย

```ts
// store 1 — แพง เปลี่ยนน้อย
interface OcrRecord {
  key: string;              // `${detId}@${detV}:${recId}@${recV}:${imageHash}[:${sliceIdx}]`
                            // recId ผูกกับภาษาอยู่แล้ว (manga-ocr=ja, ppocr-latin=en)
  imageHash: string;
  lang: LangCode;           // ภาษาที่ตรวจได้/ถูกเลือก
  natural: { w: number; h: number };
  blocks: Array<{
    rect: NormRect;         // normalized เสมอ
    ja: string;
    direction: 'vertical' | 'horizontal';
    confidence: number;
  }>;
  createdAt: number;
  bytes: number;            // สำหรับ LRU
}

// store 2 — ถูก เปลี่ยนบ่อย · key เป็น "ข้อความ" ไม่ใช่ "รูป"
interface TranslationRecord {
  key: string;              // `${providerId}@${modelId}:${from}-${to}:${sha1(src)}`
  from: LangCode;
  to: LangCode;
  src: string;
  out: string;
  createdAt: number;
}
```

**ประโยชน์ที่ได้ฟรี:** ประโยคซ้ำๆ ที่โผล่ทั้งเรื่อง (`「なに！？」`, ชื่อตัวละคร) จะ hit cache ข้ามหน้า ข้ามตอน ข้ามเว็บ — ประหยัดโควตา Google ได้มาก

### 9.2 Image hash

```ts
imageHash = base64url(sha256(rawImageBytes)).slice(0, 22)
```
hash จาก **bytes ที่ fetch มา** ไม่ใช่ pixel — เร็วกว่า, ไม่ต้อง decode, และไม่ติดปัญหา tainted canvas
ตรงกับที่ handoff เตือนว่า *"Do not use URL alone as the cache key"* — URL ของ CDN มัก signed/หมดอายุ แต่ bytes เหมือนเดิม

**ข้อจำกัดที่ยอมรับ:** ถ้าเว็บ re-encode รูป (WebP vs JPEG) hash จะไม่ตรง → ยอมรับได้สำหรับ MVP
ถ้าเจอปัญหาจริงค่อยเพิ่ม perceptual hash (dHash 64-bit จาก thumbnail 9×8) เป็น secondary index

### 9.3 Storage layer

| ชั้น | ที่อยู่ | อายุ | ขนาด |
|---|---|---|---|
| L1 | `Map` ใน content script | ตลอด tab | ไม่จำกัด |
| L2 | IndexedDB (SW เป็นเจ้าของ) | 90 วัน | budget 200 MB, LRU |
| L3 | Cache Storage / OPFS | ถาวร | model weights |

⚠️ **ห้ามใช้ `chrome.storage.local` เก็บ OCR result** — มีเพดานและช้ากับข้อมูลก้อนใหญ่ ใช้เก็บแค่ settings

Eviction: เมื่อ `totalBytes > 200 MB` → ลบ `ocr` ที่ `lastAccessedAt` เก่าสุดจนเหลือ 160 MB
เพิ่มปุ่ม "Clear cache" ใน options พร้อมแสดงขนาดที่ใช้

---

## 10. คำตอบ Q9 — MV3 component communication

```
┌─ Content Script (ISOLATED world, ทุก tab) ────────────────────┐
│  detector · scheduler · overlay renderer · L1 cache           │
└──────────────── chrome.runtime.sendMessage / Port ────────────┘
                              │
┌─ Service Worker (orchestrator, ephemeral) ────────────────────┐
│  image fetch (ข้าม CORS) · IndexedDB · translation providers  │
│  settings · offscreen lifecycle                               │
└────────────── chrome.runtime + offscreen messaging ───────────┘
                              │
┌─ Offscreen Document (ML host, long-lived) ────────────────────┐
│  ONNX Runtime Web · det model · manga-ocr · image decode      │
│  Web Worker(s) เพื่อกัน main thread ค้าง                       │
└───────────────────────────────────────────────────────────────┘

┌─ Popup / Options ─────────────────────────────────────────────┐
│  toggle · mode · API key · cache mgmt                         │
└───────────────────────────────────────────────────────────────┘
```

### 10.1 กฎการสื่อสาร

- **งานสั้น (< 1 วิ):** `chrome.runtime.sendMessage` + `Promise`
- **งานยาว (OCR ทั้งหน้า):** ใช้ **`chrome.runtime.connect()` Port ระยะยาว** ต่อ 1 tab
  → มี progress event, ยกเลิกได้, และ **port ที่เปิดอยู่ช่วยกัน SW ถูก terminate**
- **ห้ามส่ง base64:** ส่ง `ArrayBuffer` / `ImageBitmap` ผ่าน **transferable** (base64 ทำให้ข้อมูลบวม 33% และ copy 2 รอบ)
- **SW ephemeral:** ห้ามเก็บ state สำคัญในตัวแปร module — ทุกอย่างต้องอ่าน/เขียน IndexedDB หรือ `chrome.storage`
- **Offscreen lifecycle:** สร้างเมื่อ job แรกเข้า, ปิดเมื่อไม่มี job ครบ 5 นาที (คืน RAM ~500 MB)

### 10.2 Typed message contract

```ts
type Msg =
  | { t: 'PING' }
  | { t: 'TRANSLATE_IMAGE'; url: string; referrer: string; natural: Size; sliceIdx?: number }
  | { t: 'TRANSLATE_BYTES'; bytes: ArrayBuffer; natural: Size }      // blob:/canvas
  | { t: 'CAPTURE_REGION'; rect: DOMRect; dpr: number }
  | { t: 'PROGRESS'; jobId: string; stage: Stage; pct: number }
  | { t: 'RESULT'; jobId: string; blocks: OverlayBlock[]; fromCache: boolean }
  | { t: 'ERROR'; jobId: string; code: ErrCode; message: string };
```
ไฟล์ `src/shared/messages.ts` เป็น single source of truth — ทั้ง 4 context import จากที่เดียวกัน

---

## 11. คำตอบ Q10 + Q11 — Translation providers

### 11.1 Interface (แก้จาก handoff — ต้องเป็น batch)

handoff เสนอ `translate(text): Promise<string>` ทีละอัน
**ปัญหา:** 15 bubble = 15 round trip และ **LLM เสีย context ทั้งหมด**

```ts
interface TranslationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly caps: {
    batch: boolean;
    context: boolean;
    maxItemsPerCall: number;
    maxCharsPerCall: number;
    approxLatencyMs: number;      // ให้ router ใช้ตัดสินใจ
    costPerMChars: number;        // 0 = ฟรี/local
  };
  isConfigured(): Promise<boolean>;
  translateBatch(req: BatchRequest): Promise<BatchResult>;
}

interface BatchRequest {
  items: Array<{ id: string; ja: string }>;   // เรียงตาม reading order แล้ว
  from: 'ja'; to: 'th';
  context?: {
    previous?: Array<{ ja: string; th: string }>;   // 3–5 bubble ก่อนหน้า
    glossary?: Record<string, string>;              // ชื่อตัวละคร/ศัพท์เฉพาะ
    seriesTitle?: string;
  };
  signal?: AbortSignal;
}

interface BatchResult {
  items: Array<{ id: string; th: string; confidence?: number }>;
  provider: string;
  charsBilled: number;
}
```

### 11.2 GeminiProvider — **default provider**

> ตัดสินใจ 2026-08-14: แทนที่ Cloud Translation v3 เป็น default
> เหตุผล: ฟรีกว่า (ไม่ต้องผูกบัตร), ถูกกฎ, และ**คุณภาพกับบทพูดมังงะดีกว่า MT ล้วน**เพราะเป็น LLM ที่รับ context ได้

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Model: **`gemini-flash-lite-latest`** — free tier ไม่ต้องใช้บัตรเครดิต
  🔴 **ยืนยันจากการทดสอบจริง 2026-08-15:** `gemini-2.5-flash-lite` คืน **404 "no longer available to new users"**
  Google ปิด point release แต่ alias `-latest` ยังตามรุ่นปัจจุบันเสมอ → **ห้าม pin เวอร์ชันใน default** เพราะเพื่อนที่ติดตั้งทีหลังจะพังทันที
  (ต้องการตัวเลข benchmark ที่ทำซ้ำได้ ค่อย pin เป็นรายครั้ง)
- เพราะเรา **batch ทั้งหน้าเป็น 1 request** → 1,000 req/วัน ≈ **1,000 หน้า/วัน** ซึ่งเกินพอมหาศาล
- ใช้ **structured output** (`responseSchema`) บังคับ JSON — ห้าม parse ข้อความอิสระ
- ใช้ prompt/validation ชุดเดียวกับ `LocalLLMProvider` (§11.3) → แชร์โค้ดได้เกือบหมด
- **BYO API key**: ผู้ใช้แต่ละคนใส่ key ของตัวเอง (สมัครฟรีที่ AI Studio) → `chrome.storage.local`
  ⚠️ ห้ามฝัง key ของ developer ลง extension เด็ดขาด · เตือนผู้ใช้ว่า key ใน extension storage ไม่ถือเป็นความลับ
- ⚠️ แจ้งผู้ใช้: free tier ของ Gemini **อาจนำ prompt/response ไปปรับปรุงโมเดล** — ถ้าซีเรียสให้ใช้ Ollama
- Rate limit: token bucket 15/นาที ฝั่งเรา + exponential backoff เมื่อ 429
- fetch ต้องอยู่ใน **service worker** (content script จะติด CORS/CSP ของเว็บ)

**`GoogleCloudTranslateProvider` (v3) — optional, ไม่ใช่ default**
ทำเพิ่มทีหลังสำหรับคนที่อยากได้ MT แบบ deterministic/latency ต่ำ · $20 per 1M chars, ฟรี 500k/เดือน, ต้องผูกบัตร

**ห้ามเด็ดขาด:** `googletrans` / `translate_a/single` / endpoint ภายในของ translate.google.com
เป็น reverse-engineered endpoint → ผิด ToS, พังเมื่อ Google เปลี่ยน, และ**โดนแบน IP เมื่อยิงถี่** (มังงะ 1 ตอน = 15–20 request)
ตรงกับที่ handoff §8 เตือนไว้ — ยืนยันว่าคำเตือนนั้นถูกต้อง

### 11.2.1 Safety filter — เคสเนื้อหาผู้ใหญ่ (ต้องออกแบบ ไม่ใช่ปล่อยพัง)

ผู้ใช้อ่านมังงะที่มีเนื้อหา NSFW ด้วย ซึ่งกระทบ Gemini โดยตรง:

- Gemini 2.5/3 ตั้ง block threshold **`OFF` เป็นค่า default** สำหรับ 4 หมวดที่ปรับได้
  และเราตั้ง `HARM_CATEGORY_SEXUALLY_EXPLICIT: BLOCK_NONE` ได้ → เนื้อหาผู้ใหญ่**ส่วนใหญ่ผ่าน**
- แต่ **core protections (child safety) ปิดไม่ได้ถาวร** — และลายเส้นมังงะบางแบบทำให้เกิด false positive ได้
- ต่อให้ filter ไม่บล็อก **ตัวโมเดลเองก็ยังปฏิเสธในข้อความตอบได้**

**ดังนั้น "provider ปฏิเสธ" ต้องเป็น error path ชั้นหนึ่ง ไม่ใช่ของแถม:**

```ts
type ErrCode =
  | 'PROVIDER_REFUSED'      // finishReason: SAFETY | promptFeedback.blockReason
  | 'QUOTA_EXCEEDED'        // 429
  | 'INVALID_KEY'
  | 'OFFLINE'
  | 'VALIDATION_FAILED';    // JSON ไม่ตรง schema
```

พฤติกรรมเมื่อเจอ `PROVIDER_REFUSED`:
1. **ห้าม fail ทั้งหน้า** — ลองใหม่แบบแยกทีละ block เพื่อหาว่า block ไหนโดน (block อื่นควรได้คำแปลปกติ)
2. block ที่โดนปฏิเสธ → แสดง badge เล็กๆ บน overlay + ปุ่ม "ลองด้วย Local LLM"
3. ถ้า `LocalLLMProvider` ตั้งค่าไว้แล้ว → fallback อัตโนมัติ

> ⚠️ **ผลกระทบต่อแผน:** MVP ที่มี Gemini อย่างเดียวจะ**ใช้ไม่ได้เต็มที่กับเนื้อหา NSFW**
> ช่อง Ollama จึงไม่ใช่ "ของเสริม" สำหรับ use case นี้ — แต่ยังเลื่อนไป M6 ได้
> เพราะ MVP ต้องพิสูจน์ pipeline ก่อน และ Gemini ครอบคลุมมังงะทั่วไปได้

### 11.3 LocalLLMProvider (Ollama / LM Studio / llama.cpp)

```
extension SW ──HTTP──► http://localhost:11434/api/chat ──► model
```

**สิ่งที่ต้องมี ไม่งั้นพังแน่ๆ:**
1. **CORS**: Ollama บล็อก `chrome-extension://` โดย default
   ต้องตั้ง `OLLAMA_ORIGINS=chrome-extension://*` → **ใส่ใน onboarding พร้อมปุ่ม "Test connection"** ที่บอก error ให้ชัด
2. `host_permissions: ["http://localhost/*", "http://127.0.0.1/*"]`
3. **บังคับ JSON output** ผ่าน structured output / `format: json` — ห้าม parse ข้อความอิสระ
4. Timeout + AbortSignal ต่อ request (LLM ค้างได้)
5. **Fallback อัตโนมัติไป Google** เมื่อ local ล่ม/timeout/parse ไม่ผ่าน

**Prompt design** (ตาม constraint ใน handoff §9):
```
System:
คุณคือนักแปลมังงะญี่ปุ่น→ไทยมืออาชีพ
- แปลให้เป็นธรรมชาติแบบบทพูดในมังงะไทย
- ห้ามเพิ่มข้อมูลที่ไม่มีในต้นฉบับ ห้ามแต่งบทสนทนา
- ห้ามอธิบาย ห้ามใส่หมายเหตุ
- รักษาโทน/ระดับภาษาของตัวละคร
- ถ้าไม่แน่ใจ ให้แปลตรงตัวไว้ก่อน
- ข้อความสั้น/เสียงประกอบ (オノマトペ) ให้แปลเป็นเสียงประกอบไทย
- คืน JSON เท่านั้น: {"items":[{"id":"...","th":"..."}]}

User:
{"series":"...","previous":[...],"glossary":{...},"items":[{"id":"b1","ja":"..."},...]}
```

**Validation ก่อนใช้ผล:** จำนวน item ต้องครบ, `id` ต้องตรง, `th` ต้องไม่ว่าง, ต้องไม่มี kanji/kana เหลือ
ถ้าไม่ผ่าน → retry 1 ครั้ง → fallback Google

**หมายเหตุตรงไปตรงมา:** โมเดล local เล็ก (< 7B) จำนวนมาก **ภาษาไทยแย่มาก** — คุณภาพไทยของ LLM ต้อง benchmark เองในเครื่องคุณ อย่าเชื่อ benchmark ทั่วไป ตั้ง eval set 30 bubble แล้วเทียบตาเปล่า

### 11.4 TranslationRouter — เริ่มโง่ๆ ก่อน

handoff §10 วางแกนไว้เป็น "Google = เร็ว vs LLM = คุณภาพ"
แต่เมื่อ default เป็น Gemini (ซึ่งเป็น LLM และเร็วและฟรี) **แกนที่แท้จริงเปลี่ยนเป็น cloud vs local**:

```
Gemini (cloud)  → เร็ว + คุณภาพดี + ฟรี แต่มีโควตา/ต้องออนไลน์/ข้อมูลออกนอกเครื่อง
Ollama (local)  → ไม่จำกัด + offline + privacy สมบูรณ์ แต่ช้ากว่าและกิน VRAM
```

Router v0 (MVP) — **ห้าม over-engineer**:
```
mode = 'cloud'   → Gemini ทั้งหมด
mode = 'local'   → Ollama ทั้งหมด
mode = 'auto'    → Gemini ก่อน
                   fallback → Ollama เมื่อ: 429 quota / offline / ไม่มี API key / JSON ไม่ผ่าน validation
```

Router v1 (หลัง benchmark) — เพิ่มการ re-translate เฉพาะรายการ "น่าสงสัย" (คำนวณได้ทันที ไม่ต้อง ML):
- ผลลัพธ์ยังมีอักษรญี่ปุ่นเหลือ
- ผลลัพธ์ = ต้นฉบับ (แปลไม่ออก)
- ต้นฉบับมี `……` / `っ` ท้ายคำ / `〜` / เครื่องหมายซ้ำ → เป็นอารมณ์/สแลง
- ต้นฉบับสั้นมาก (< 4 ตัว) แต่ผลลัพธ์ยาวผิดปกติ

ตามที่ handoff §10 บอกไว้ว่า *"exact routing heuristic should be designed after benchmarking"*

---

## 12. Tech Stack

| ส่วน | เลือก | เหตุผล |
|---|---|---|
| ภาษา | **TypeScript strict** | contract ระหว่าง 4 context ต้อง type-safe |
| Extension framework | **WXT** (บน Vite) | MV3 first-class, HMR ถึง content script, จัดการ manifest/entrypoint ให้ · ทางเลือก: Vite + `@crxjs/vite-plugin` |
| ML runtime | **onnxruntime-web** (det) + **transformers.js** (manga-ocr) | transformers.js จัดการ tokenizer + generation loop ให้ ไม่ต้องเขียน greedy decode เอง |
| Overlay UI | **vanilla TS + CSS** ใน Shadow DOM | content script ต้องเบา — React ในหน้าเว็บคนอื่น = หนักและเสี่ยงชน |
| Popup / Options | **Preact + Signals** (~4 KB) | มี state จริง แต่ไม่ต้องแบก React |
| Storage | **idb** (wrapper IndexedDB) | promise-based, tree-shakable |
| Test (unit) | **Vitest** | grouping / reading-order / coordinate เป็น pure function ทั้งหมด |
| Test (e2e) | **Playwright** + `--load-extension` | ทดสอบบนหน้า fixture ที่เราคุมเอง |
| Lint/Format | **Biome** | เร็ว ตั้งค่าเดียวจบ |
| Sidecar (optional) | **Python FastAPI + manga-ocr + onnxruntime-gpu** | มีก็ต่อเมื่อ M0 ตัดสินว่า WASM ช้าเกิน |

**สิ่งที่จงใจไม่ใช้:** React ใน content script, state library ใหญ่, monorepo tooling, CSS framework — ยังไม่จำเป็นและจะกลายเป็นภาระ

---

## 13. Project Structure

```
manga-translator/
├─ docs/
│  ├─ 00-technical-design.md          ← ไฟล์นี้
│  ├─ 01-implementation-plan.md
│  └─ decisions/                      ← ADR เมื่อมีการตัดสินใจใหญ่
│
├─ spike/                             ← M0: ไม่ใช่ extension เป็น harness ล้วน
│  ├─ index.html                      ← ลากรูปมังงะใส่ → เห็น bbox + เวลาแต่ละ stage
│  ├─ bench.ts
│  └─ README.md
│
├─ extension/
│  ├─ wxt.config.ts
│  ├─ src/
│  │  ├─ shared/                      ← ใช้ร่วมทุก context — ห้ามมี side effect
│  │  │  ├─ messages.ts               ← typed message contract
│  │  │  ├─ types.ts                  ← NormRect, TextLine, TextBlock, OverlayBlock
│  │  │  ├─ settings.ts
│  │  │  └─ log.ts
│  │  │
│  │  ├─ core/                        ← 💎 pure functions + unit test ทั้งหมด
│  │  │  ├─ grouping.ts               ← line → block (union-find)
│  │  │  ├─ reading-order.ts          ← column-band → XY-cut
│  │  │  ├─ direction.ts
│  │  │  ├─ geometry.ts               ← NormRect, IoU, computeContentBox
│  │  │  ├─ slicing.ts                ← webtoon tiling + overlap dedupe
│  │  │  ├─ text-fit.ts               ← หาขนาดฟอนต์ไทยที่พอดีกล่อง
│  │  │  └─ *.test.ts
│  │  │
│  │  ├─ content/
│  │  │  ├─ index.ts                  ← entry
│  │  │  ├─ detector/
│  │  │  │  ├─ scan.ts                ← หา candidate
│  │  │  │  ├─ scoring.ts
│  │  │  │  └─ site-profiles/
│  │  │  │     ├─ registry.ts
│  │  │  │     ├─ default.ts
│  │  │  │     ├─ mangadex.ts         ← blob: + paged/strip
│  │  │  │     └─ imhentai.ts         ← sw-fetch + paged + prefetch
│  │  │  ├─ readers/
│  │  │  │  ├─ ReaderAdapter.ts       ← interface (§3.2.3)
│  │  │  │  ├─ StripReader.ts
│  │  │  │  └─ PagedReader.ts         ← url/src change + lookahead
│  │  │  ├─ observers.ts              ← IO + MO + RO + navigation
│  │  │  ├─ scheduler.ts              ← priority queue + dedupe + cancel
│  │  │  ├─ acquire.ts                ← decision tree (§4.2) ทั้ง 2 path
│  │  │  └─ overlay/
│  │  │     ├─ host.ts                ← custom element + shadow root
│  │  │     ├─ layer.ts               ← 1 layer / 1 image + rAF sync
│  │  │     ├─ render.ts
│  │  │     └─ overlay.css
│  │  │
│  │  ├─ background/
│  │  │  ├─ index.ts                  ← SW entry + port router
│  │  │  ├─ pipeline.ts               ← orchestrator ของ stage 2–8
│  │  │  ├─ image-fetch.ts            ← fetch ข้าม CORS + sha256
│  │  │  ├─ offscreen-manager.ts
│  │  │  └─ capture.ts                ← captureVisibleTab + throttle
│  │  │
│  │  ├─ offscreen/
│  │  │  ├─ offscreen.html
│  │  │  ├─ index.ts
│  │  │  ├─ ocr/
│  │  │  │  ├─ OCRProvider.ts         ← interface
│  │  │  │  ├─ WasmOCRProvider.ts     ← det + recognizer ตามภาษา
│  │  │  │  ├─ LocalServiceProvider.ts
│  │  │  │  ├─ TextDetector.ts        ← language-agnostic (PP-OCR det)
│  │  │  │  ├─ recognizers/
│  │  │  │  │  ├─ TextRecognizer.ts   ← interface
│  │  │  │  │  ├─ MangaOcrJa.ts       ← ja เท่านั้น
│  │  │  │  │  └─ PpOcrLatin.ts       ← en (และใช้เป็นตัว sniff ภาษา)
│  │  │  │  ├─ lang-packs.ts          ← LanguagePack registry (§5.2.1)
│  │  │  │  ├─ lang-detect.ts         ← auto-detect ภาษาต้นทาง
│  │  │  │  └─ model-store.ts         ← ดาวน์โหลด + cache weights
│  │  │  └─ worker.ts
│  │  │
│  │  ├─ translation/
│  │  │  ├─ TranslationProvider.ts
│  │  │  ├─ GoogleTranslateProvider.ts
│  │  │  ├─ LocalLLMProvider.ts
│  │  │  ├─ TranslationRouter.ts
│  │  │  ├─ prompts.ts
│  │  │  └─ glossary.ts
│  │  │
│  │  ├─ cache/
│  │  │  ├─ db.ts                     ← schema + migration
│  │  │  ├─ ocr-cache.ts
│  │  │  ├─ translation-cache.ts
│  │  │  └─ eviction.ts
│  │  │
│  │  ├─ popup/
│  │  └─ options/
│  │
│  └─ tests/e2e/
│     └─ fixtures/                    ← หน้า HTML จำลอง reader หลายแบบ
│
└─ local-services/                    ← สร้างเมื่อจำเป็นเท่านั้น
   └─ ocr/
```

**หลักการจัดโครง:** `core/` ต้อง import ได้จากทุกที่และ **ทดสอบได้โดยไม่ต้องมี browser** — ตรรกะยากทั้งหมดอยู่ที่นั่น ส่วนที่เหลือคือ glue กับ platform API

---

## 14. ความเสี่ยงและแผนสำรอง

| ความเสี่ยง | ระดับ | สัญญาณเตือน | แผนสำรอง |
|---|---|---|---|
| WASM OCR ช้าเกินใช้งาน | 🔴 สูง | M0 วัดได้ > 8 วิ/หน้า | สลับ default เป็น Local Service (มี interface รออยู่แล้ว) |
| โหลดโมเดล 400 MB ครั้งแรก UX แย่ | 🟠 กลาง | — | quantize int8, แสดง progress, ให้เริ่มโหลดตอนกดเปิดครั้งแรก |
| manga-ocr แต่งข้อความจาก crop เปล่า | 🟠 กลาง | เจอประโยคมั่วบนภาพที่ไม่มีตัวหนังสือ | กรอง 3 ชั้น (§5.2) |
| Grouping รวม 2 bubble เป็นอันเดียว | 🟠 กลาง | ประโยคปนกัน | ใช้ segmentation map เช็ค bubble แยก |
| ข้อความไทยยาวเกินกล่อง (ไทยยาวกว่า JA ~1.5–2×) | 🟠 กลาง | ข้อความล้น | auto-shrink + `text-wrap: balance` + ขยายกล่องเกินขอบได้ 20% + hover ดูเต็ม |
| เว็บ block extension / CSP เข้ม | 🟡 ต่ำ | overlay ไม่ขึ้น | Shadow DOM + isolated world ป้องกันได้เกือบหมด |
| Google API key รั่ว | 🟡 ต่ำ | — | เตือนผู้ใช้ + แนะนำตั้ง API restriction |
| SW ถูก terminate กลางงาน | 🟡 ต่ำ | job ค้าง | ใช้ Port ยาว + resume จาก IndexedDB |

---

## 15. Definition of Done (แปลจาก handoff §17 เป็นเกณฑ์ที่วัดได้)

MVP ผ่านเมื่อ — บนหน้ามังงะจริง 3 เว็บ:

1. ⏱️ หน้าใหม่เข้า viewport → คำแปลปรากฏภายใน **≤ 5 วินาที** (cache miss) / **≤ 200 ms** (cache hit)
2. 🎯 Detection recall ≥ **90%** ของ speech bubble ที่มีข้อความ
3. 🎯 OCR ถูกต้องระดับประโยค ≥ **80%** (ตรวจด้วยตาบน eval set 50 bubble)
4. 📐 Overlay ตรงตำแหน่ง — ย่อ/ขยายหน้าต่างแล้ว **ไม่เลื่อน**
5. ↕️ scroll ลง 20 หน้าแล้วขึ้น → **0 ครั้ง** ที่ OCR ซ้ำ (ดูจาก log)
6. 🚫 ไม่ทำให้หน้าเว็บกระตุก — scroll ยัง ≥ 50 fps
7. 🇹🇭 ข้อความไทยเป็นแนวนอนเสมอ อ่านออก ไม่ล้นกล่องจนอ่านไม่ได้
8. 🔌 ปิด extension → หน้าเว็บกลับสภาพเดิม 100% ไม่มี DOM ตกค้าง

---

## 15.5 Settings & Options UI

มี **3 surface** แยกหน้าที่กันชัดเจน — อย่ายัดทุกอย่างไว้ที่เดียว

| Surface | ใช้ตอน | เนื้อหา |
|---|---|---|
| **Popup** (คลิกไอคอน) | ระหว่างอ่าน ทุกวัน | toggle, โหมด, ภาษาต้นทางของเรื่องนี้, สถานะคิว |
| **Options** (หน้าเต็ม) | ตั้งครั้งเดียว | API key, Ollama, OCR runtime, display, cache |
| **Diagnostics** (แท็บใน Options) | ตอนพัง | ปุ่มเดียวเช็คทุกอย่าง — สำคัญมากเมื่อแจกให้เพื่อน |

### 15.5.1 Schema

```ts
interface Settings {
  version: 3;                                  // สำหรับ migration

  enabled: boolean;                            // kill switch ระดับเบราว์เซอร์
  autoSites: string[];                         // hostname ที่เปิดแปลอัตโนมัติ · ไม่อยู่ในรายการ = ปิด (D-029)

  lang: {
    source: LangCode | 'auto';                 // default 'auto'
    target: LangCode;                          // default 'th'
  };

  translation: {
    mode: 'cloud' | 'local' | 'auto';          // default 'cloud'
    gemini: {
      apiKey: string;                          // ⚠️ ของผู้ใช้เอง ห้ามฝังของ dev
      model: string;                           // default 'gemini-2.5-flash-lite'
      safetyOff: boolean;                      // ตั้ง BLOCK_NONE ทุกหมวด
    };
    ollama: {
      baseUrl: string;                         // default 'http://localhost:11434'
      model: string;                           // เช่น 'huihui_ai/qwen3.5-abliterated:4b'
      numCtx: number;                          // default 8192 — สำคัญกับการ์ด 6 GB
      timeoutMs: number;                       // default 60000
    };
    contextBubbles: number;                    // 0–5, default 3
  };

  ocr: {
    runtime: 'auto' | 'webgpu' | 'wasm' | 'local-service';
    localServiceUrl: string;                   // ใช้เมื่อ runtime = 'local-service'
    preset: 'fast' | 'balanced' | 'quality';   // ผูกกับ PRESETS ใน core/resolution
  };

  display: {
    mode: 'target-only' | 'target-plus-source-on-hover';
    fontScale: number;                         // 0.7–1.5
    boxOpacity: number;                        // ความทึบของแผ่นรองข้อความ
  };

  performance: {
    prefetchLookahead: number;                 // 0–10, default 3
    maxConcurrentOcr: 1;                       // ล็อกไว้ที่ 1 — OCR เป็น CPU-bound
  };

  /** จำค่าต่อเรื่อง เช่นภาษาที่ auto-detect ได้ ไม่ต้องตรวจซ้ำ */
  perSet: Record<string, { source?: LangCode; enabled?: boolean }>;
}
```

### 15.5.2 การเก็บ

| ข้อมูล | ที่เก็บ | เหตุผล |
|---|---|---|
| ทุกอย่างใน `Settings` | **`chrome.storage.local`** | ไม่ใช้ `sync` เพราะ API key ไม่ควรวิ่งข้ามเครื่องอัตโนมัติ และ `sync` มีเพดาน 8 KB/รายการ |
| OCR / translation cache | IndexedDB | §9 |
| model weights | Cache Storage / OPFS | §5.3 |

⚠️ **ต้องเขียนบอกผู้ใช้ตรงๆ ในหน้า Options:** API key ใน extension storage **ไม่ถือว่าเป็นความลับ** — extension อื่นที่มีสิทธิ์พอหรือคนที่เข้าถึงเครื่องได้ก็อ่านได้
แนะนำให้ตั้ง API key restriction ฝั่ง Google และเตือนว่าอย่าใช้ key ที่ผูกกับ billing project สำคัญ

### 15.5.3 Diagnostics — ปุ่มเดียวจบ

> เมื่อแจกให้เพื่อน นี่คือฟีเจอร์ที่ประหยัดเวลาคุณมากที่สุด
> ไม่มีอันนี้ = คุณต้องนั่งไล่ถามทีละคนว่า "ขึ้น error ว่าอะไร"

```
[ ตรวจสอบระบบ ]

✅ WebGPU            available (NVIDIA GeForce RTX 3060 Laptop GPU)
✅ Offscreen document  ทำงานปกติ
✅ โมเดล det          ครบ (5.2 MB)
⚠️ โมเดล manga-ocr    ยังไม่ได้ดาวน์โหลด (จะโหลดอัตโนมัติเมื่อเจอหน้าญี่ปุ่น)
✅ Gemini API key     ใช้ได้ · วันนี้ใช้ไป 12/1000 req
❌ Ollama             ต่อไม่ได้ที่ http://localhost:11434
   └─ ตั้ง OLLAMA_ORIGINS=chrome-extension://* แล้วรีสตาร์ต Ollama  [คัดลอกคำสั่ง]
✅ Cache              142 MB / 200 MB   [ล้าง cache]
```

แต่ละบรรทัดที่ ❌ ต้องมี **วิธีแก้ที่ทำตามได้ทันที** ไม่ใช่แค่บอกว่าพัง

### 15.5.4 Onboarding ครั้งแรก

ผู้ใช้ใหม่ (รวมเพื่อนคุณ) เจอ 3 ขั้นเท่านั้น:

```
1. วาง Gemini API key   [ขอ key ฟรี ↗]  → ปุ่ม Test
2. เลือกภาษาปลายทาง      (ไทย)
3. เสร็จ — เปิดหน้ามังงะแล้วกดไอคอน
```

Ollama, OCR runtime, performance preset **ซ่อนไว้ใน "ขั้นสูง" ทั้งหมด** — ค่า default ต้องใช้งานได้ทันทีโดยไม่ต้องแตะ

---

## 16. Distribution & Licensing

**ตัดสินใจ 2026-08-14: ใช้เองเป็นหลัก แต่ต้องแจกให้เพื่อนได้โดยไม่ต้องรื้อ**

### 16.1 กฎ license ที่ต้องยึด

GPL/AGPL จะมีผลก็ต่อเมื่อมีการ **distribution (conveying)** — ส่งซอฟต์แวร์ให้คนอื่น
ใช้เองเครื่องเดียว = ไม่มีข้อผูกมัดใดๆ · แจกให้เพื่อน = **นับเป็น distribution**

| License | โมเดล | ใช้เอง | แจกให้เพื่อน |
|---|---|---|---|
| **Apache-2.0** | manga-ocr, PP-OCR | อิสระ | **อิสระ** — แนบ LICENSE + NOTICE |
| GPL-3.0 | comic-text-detector | อิสระ | ⚠️ extension กลายเป็น derivative work → ต้องเปิด source ให้ผู้รับ |
| AGPL-3.0 | YOLOv8 (Ultralytics) | อิสระ | ⚠️ เข้มกว่า + Ultralytics ระบุว่าคลุมถึง **trained weights** |

**ข้อสรุป:** default ต้องเป็น **Apache-2.0 ล้วน** (PP-OCRv5 det + manga-ocr)
ถ้าอนาคตอยากใช้ comic-text-detector มี 2 ทางที่สะอาด:
(ก) เปิด source extension เป็น GPL-3.0 ไปเลย หรือ
(ข) ผู้ใช้กดดาวน์โหลด weights เองตอน runtime โดยโค้ดเราเป็น generic ONNX runner ไม่มี source GPL ในแพ็กเกจ

> นี่คือการประเมินเชิงวิศวกรรม ไม่ใช่คำแนะนำทางกฎหมาย ถ้าเรื่องนี้มีเดิมพันสูงให้ปรึกษาผู้เชี่ยวชาญ

### 16.2 `TextDetector` ต้อง pluggable

เหตุผลเดียวกับ `OCRProvider` — ล็อก detector ตัวเดียวคือความเสี่ยง

```ts
interface TextDetector {
  readonly id: string;
  readonly version: string;              // เข้า cache key
  readonly license: 'Apache-2.0' | 'GPL-3.0' | 'AGPL-3.0';
  detect(img: ImageBitmap): Promise<TextLine[]>;   // normalized coords เสมอ
}
```
`license` เป็น field จริงในโค้ด เพื่อให้ build script เตือนได้เมื่อ default bundle มีของที่ไม่ใช่ Apache

### 16.3 สิ่งที่ต้องเพิ่มเพราะจะแจกจ่าย

1. **Onboarding ใส่ API key ของตัวเอง** — เพื่อนแต่ละคนสมัคร Gemini key ฟรีเอง · **ห้ามฝัง key ของ developer**
2. **First-run model download** พร้อม progress bar + ขนาดที่ชัดเจน + resume ได้ (140–460 MB)
3. **Diagnostics page** — ปุ่มเดียวเช็ค: WebGPU มีไหม / โมเดลโหลดครบไหม / API key ใช้ได้ไหม / Ollama ต่อได้ไหม
   (เวลาเพื่อนบอกว่า "ใช้ไม่ได้" คุณจะได้ไม่ต้องนั่งไล่ทีละคน)
4. **วิธีติดตั้ง** — Chrome เตือนทุกครั้งที่เปิดถ้าโหลดแบบ unpacked
   ทางที่สบายกว่าคือ publish แบบ **unlisted** บน Chrome Web Store ($5 ครั้งเดียว) แล้วส่งลิงก์
5. **README + LICENSE + NOTICE** ในรีโป

### 16.4 ค่าที่ยืนยันแล้ว

| ข้อ | ค่า | ผล |
|---|---|---|
| GPU | **NVIDIA RTX/GTX** | WebGPU น่าจะไหว · CUDA sidecar เป็น fallback ที่ดี · Local LLM รันได้จริง |
| Cloud translation | **Gemini free tier** (ไม่ผูกบัตร) | M3 ใช้ `GeminiProvider` เป็น default |
| Distribution | ใช้เอง + แจกเพื่อนได้ | ล็อก Apache-2.0 · ต้องมี onboarding + diagnostics |

### 16.5 ยังต้องการจากคุณเพื่อเริ่ม M0

1. **เว็บมังงะเป้าหมาย 1–2 เว็บ** — เพื่อสร้าง fixture และ site profile ที่ตรงของจริง
2. **หน้ามังงะจริง 10 หน้า** ใส่ `spike/samples/` (ไม่ commit) — M0 รันไม่ได้ถ้าไม่มีข้อมูลจริง
3. **VRAM เท่าไร + มี Ollama/โมเดลอะไรอยู่แล้ว** — เพื่อตั้ง baseline ภาษาไทยของ local LLM
