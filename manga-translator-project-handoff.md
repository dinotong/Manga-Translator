# Manga Translator Chrome Extension — Project Handoff

## 1. Project Goal

Build a Chrome Extension that automatically translates Japanese manga/web manga into Thai while the user reads on a computer.

Current problem:

- Manga text is embedded in images, so normal browser translation cannot read it.
- Current workaround is using Google Translate Camera on a phone by pointing the phone at the computer screen.
- Desired experience: open the extension once, enable Auto Translate on Scroll, then read normally.

Target UX:

```text
Open manga in Chrome
        ↓
Enable Manga Translator
        ↓
Scroll normally
        ↓
Detect newly visible manga content
        ↓
Capture / obtain image
        ↓
Local OCR
        ↓
Japanese text + bounding boxes
        ↓
Japanese text reconstruction
        ↓
Reading-order detection
        ↓
Japanese → Thai translation
        ↓
Thai horizontal overlay
        ↓
Cache result
        ↓
Continue reading
```

The user should NOT have to manually screenshot, crop, copy text, or press Translate for every page/bubble.

---

## 2. Core MVP Requirement: Auto Translate on Scroll

Auto Translate on Scroll is a core feature from MVP.

When new manga content enters the viewport:

1. Detect newly visible content.
2. Avoid processing content already handled.
3. Capture/obtain the relevant image or visible region.
4. Run OCR.
5. Reconstruct Japanese text.
6. Determine reading order.
7. Translate Japanese → Thai.
8. Render Thai as a horizontal overlay.
9. Cache OCR/translation results.

Do not OCR on every raw scroll event.

Use mechanisms such as:

- IntersectionObserver
- debounced/throttled scroll handling
- visibility detection
- image mutation/lazy-load detection where useful

---

## 3. Important Manga-Specific Problems

### 3.1 Manga is image-based

Normal DOM text translation is insufficient.

Need:

```text
Image
→ OCR
→ Japanese text + bounding boxes
```

OCR output should ideally contain:

- text
- bounding box
- confidence
- orientation/direction if available

Example:

```json
{
  "text": "これは何？",
  "bbox": {
    "x": 300,
    "y": 150,
    "width": 120,
    "height": 240
  },
  "direction": "vertical",
  "confidence": 0.96
}
```

---

### 3.2 Japanese vertical text

OCR may return:

```text
こ
れ
は
何
？
```

It must be reconstructed into:

```text
これは何？
```

before translation.

Reconstruction should consider:

- x/y coordinates
- bounding box distance
- character spacing
- orientation
- vertical/horizontal layout
- proximity
- speech-bubble grouping

Do not send individual OCR characters directly to translation.

---

### 3.3 Manga reading order

Japanese manga commonly uses:

- vertical text: top → bottom
- multiple columns/bubbles: right → left

But manga layouts vary.

Do not implement only a simplistic global right-to-left sort.

Prefer:

```text
OCR regions
→ group regions
→ detect local layout
→ determine reading order
→ reconstruct sentences
```

A future LLM-assisted layout interpretation can be considered, but it is not required for MVP.

---

### 3.4 Thai must be horizontal

Japanese source may be vertical:

```text
こ
れ
は
何
？
```

Thai output must be rendered horizontally:

```text
นี่คืออะไร?
```

Do NOT preserve Japanese vertical layout for Thai.

---

## 4. Capture Strategy

The system should NOT require manual screenshotting.

The target behavior is automatic processing of newly visible content.

However, the implementation must determine the best capture strategy after technical investigation.

Potential approaches:

### A. DOM image extraction

For `<img>` elements, use the actual image source when possible.

Advantages:

- better quality than screenshot
- easier coordinate mapping
- avoids browser UI
- potentially easier OCR

### B. Visible screenshot

Potentially use:

```text
chrome.tabs.captureVisibleTab()
```

Useful for:

- canvas-rendered manga
- custom readers
- content that is not directly accessible as an image

### C. Hybrid approach — preferred direction

Try to process source images directly when possible, and fall back to screenshot/capture for difficult rendering cases.

Need to consider:

- `<img>`
- canvas
- CSS background images
- lazy-loaded images
- custom manga readers
- responsive scaling
- transformed images
- pages rendered inside containers

Do not assume every manga website uses `<img>`.

---

## 5. Overlay Display

Do NOT modify the original manga image in MVP.

Use an HTML/CSS overlay layer above the manga.

Concept:

```text
Original manga image
        +
absolute-positioned translation elements
```

Example:

```html
<div class="manga-translation-overlay">
  นี่คืออะไร?
</div>
```

Position using OCR/image-relative coordinates.

The overlay must remain aligned with the manga image during:

- scrolling
- responsive resizing
- zoom changes where practical
- image scaling

The coordinate system must be carefully designed.

---

## 6. Translation Overlay Strategy

MVP does not need image inpainting.

A practical first version can:

1. Detect Japanese text bounding box.
2. Place a background/cover layer over the original text area.
3. Render Thai horizontally over the area.

Future improvement:

```text
OCR
→ detect Japanese text
→ text removal / inpainting
→ clean manga background
→ Thai text
```

Do not implement inpainting in the first MVP unless it is surprisingly easy.

---

## 7. Translation Architecture

Translation must be provider-agnostic.

Use an abstraction similar to:

```ts
interface TranslationProvider {
  translate(
    text: string,
    from: string,
    to: string,
    context?: TranslationContext
  ): Promise<string>;
}
```

Potential providers:

```text
TranslationProvider
├── GoogleTranslator
├── LocalLLMTranslator
└── FutureProvider
```

---

## 8. Google Translation Approach

Pipeline:

```text
Local OCR
→ reconstructed Japanese
→ Google translation
→ Thai overlay
```

### Advantages

- fast
- low local resource usage
- easy to scale across many short translations
- generally good for straightforward sentences

### Limitations

- contextual understanding can be weaker than an LLM
- Japanese pronouns are often implicit
- manga slang / tone may be less natural
- translating one bubble at a time loses conversation context
- API pricing/quota/terms must be verified before implementation

Important:

Do NOT scrape or imitate private/internal Google Translate endpoints.

If implementing Google integration, use an officially supported/allowed API or mechanism and verify current pricing/quota/terms.

Do not assume that the consumer Google Translate website being free means its API is unlimited/free.

---

## 9. Local LLM Translation

Pipeline:

```text
OCR
→ reconstruction
→ context collection
→ Local LLM
→ Thai
```

Possible architecture:

```text
Chrome Extension
      ↓
localhost
      ↓
Ollama / local inference server
      ↓
LLM
```

### Advantages

- strong contextual understanding
- better for dialogue
- better for slang and natural Thai
- can preserve character speaking styles
- can maintain character memory
- local inference can avoid API costs and improve privacy

### Limitations

- slower than simple translation APIs
- consumes RAM/VRAM
- model quality matters
- may hallucinate or over-interpret
- more complex setup

Translation prompts must explicitly prevent adding information that is not in the source.

Example constraints:

```text
- Preserve the original meaning.
- Do not invent dialogue.
- Do not add information not present in the source.
- Preserve character tone where possible.
- If uncertain, stay close to the literal meaning.
```

---

## 10. Recommended Translation Modes

UI should support:

```text
Translation Mode

○ Google — Fast
○ LLM — Quality
● Auto — Recommended
```

### Google Mode

```text
OCR
→ Google
→ overlay
```

### LLM Mode

```text
OCR
→ context
→ Local LLM
→ overlay
```

### Auto Mode

A translation router decides.

Simple text:

```text
今日は暑い。
→ Google
```

More context-sensitive dialogue:

```text
やべぇ……
マジかよ……
→ LLM
```

Goal:

> Google provides speed; LLM is used where context and naturalness matter more.

The exact routing heuristic should be designed after benchmarking.

---

## 11. Context-Aware Translation

Future quality feature.

Instead of translating every bubble independently:

```text
Current bubble
+
Previous dialogue
+
Character information
+
Speaking style
```

Example character memory:

```text
Character:
佐藤

Gender:
Male

Speaking style:
Casual

First person:
ฉัน / ผม

How character addresses protagonist:
お前 → นาย
```

This should improve consistency.

However, do not build a complicated character-memory system before the core OCR → translation → overlay pipeline works.

---

## 12. Cache

Caching is essential.

Avoid OCR and translation duplicates when the user scrolls back up.

Cache should contain at least:

```text
contentHash
→ OCR result
→ reconstructed text
→ translation
→ bounding boxes
```

Concept:

```ts
interface TranslationCache {
  contentHash: string;
  ocrResult: OCRResult[];
  reconstructedText: string[];
  translation: string[];
  createdAt: number;
}
```

Do not use URL alone as the cache key.

Consider:

- image URL
- image dimensions
- content hash
- region hash

The exact strategy should be selected after understanding target sites.

---

## 13. Suggested Architecture

```text
Chrome Manga Website
        │
        ↓
Detect visible manga content
        │
        ↓
Capture / obtain image
        │
        ↓
Local OCR
        │
        ↓
Text + Bounding Boxes
        │
        ↓
Manga Text Processor
        ├── Direction Detection
        ├── Region Grouping
        ├── Reading Order
        └── Sentence Reconstruction
        │
        ↓
Translation Router
        ├── Google
        └── Local LLM
        │
        ↓
Thai Text
        │
        ↓
HTML/CSS Overlay
        │
        ↓
Cache
```

---

## 14. Suggested Technology

Starting direction:

- Chrome Extension
- Manifest V3
- TypeScript
- Content Script
- Background Service Worker
- Popup/options UI
- Local OCR
- Translation Provider abstraction
- HTML/CSS overlay

React is optional. Do not use React everywhere just because it is available.

Possible local service:

```text
Extension
→ localhost service
→ OCR / LLM
```

This should only be introduced if browser/WASM execution is insufficient.

---

## 15. Candidate Project Structure

This is a starting point, not a hard requirement:

```text
manga-translator/
│
├── extension/
│   ├── manifest.json
│   ├── src/
│   │   ├── content/
│   │   │   ├── observer.ts
│   │   │   ├── viewport.ts
│   │   │   ├── overlay.ts
│   │   │   └── manga-detector.ts
│   │   │
│   │   ├── ocr/
│   │   │   ├── OCRProvider.ts
│   │   │   └── ...
│   │   │
│   │   ├── translation/
│   │   │   ├── TranslationProvider.ts
│   │   │   ├── GoogleTranslator.ts
│   │   │   ├── LocalLLMTranslator.ts
│   │   │   └── TranslationRouter.ts
│   │   │
│   │   ├── manga/
│   │   │   ├── text-reconstruction.ts
│   │   │   ├── reading-order.ts
│   │   │   └── region-grouping.ts
│   │   │
│   │   ├── cache/
│   │   │   └── translation-cache.ts
│   │   │
│   │   └── popup/
│   │       └── ...
│   │
│   └── ...
│
└── local-services/
    ├── ocr/
    └── llm/
```

---

## 16. MVP Development Roadmap

### Phase 0 — Technical Spike

Prove:

```text
Screenshot / image
→ Japanese OCR
→ Bounding Boxes
```

Goal: reliably read Japanese manga text.

### Phase 1 — Manga Detection

Implement:

```text
Detect manga images
→ detect viewport
→ detect newly visible content
```

### Phase 2 — OCR Pipeline

Implement:

```text
Visible content
→ OCR
→ text
→ bounding boxes
→ confidence
```

### Phase 3 — Japanese Reconstruction

Implement:

```text
Vertical detection
→ character grouping
→ sentence reconstruction
→ reading order
```

### Phase 4 — Translation

Start with:

```text
GoogleTranslator
```

Then add:

```text
LocalLLMTranslator
```

Then:

```text
TranslationRouter
```

### Phase 5 — Overlay

Implement:

```text
Japanese region
→ Thai horizontal overlay
```

### Phase 6 — Auto Scroll

Implement:

```text
Scroll
→ detect new content
→ OCR
→ translate
→ overlay
→ cache
```

### Phase 7 — UX

Settings:

```text
Auto Translate: ON/OFF

Translation:
- Google
- LLM
- Auto

Language:
Japanese → Thai

Display:
- Thai only
- Japanese + Thai

Performance:
- Fast
- Balanced
- Quality
```

---

## 17. MVP Definition of Done

MVP is successful when:

1. User opens Japanese manga on Chrome.
2. User enables the extension.
3. Auto Translate on Scroll is enabled.
4. Extension detects manga content entering viewport.
5. OCR extracts Japanese text.
6. Vertical Japanese text is supported.
7. OCR characters are reconstructed into meaningful text.
8. Manga reading order is reasonably correct.
9. Japanese is translated to Thai.
10. Thai is rendered horizontally.
11. Translation appears over the relevant manga region.
12. Scrolling down automatically processes new content.
13. Scrolling back up does not reprocess cached content.
14. The system can work with image-based manga.
15. User does not need a phone.
16. User does not need to manually screenshot/crop/translate every page.

---

## 18. Critical Engineering Rules

Do not:

- OCR every raw scroll event.
- OCR the same content repeatedly.
- translate the same text repeatedly.
- translate individual OCR characters independently.
- assume every manga site uses `<img>`.
- assume Japanese text is always horizontal.
- preserve Japanese vertical layout for Thai.
- modify original manga images in MVP.
- hard-code the whole architecture to Google.
- scrape/imitate private translation endpoints.
- build an overly complex LLM character-memory system before the basic pipeline works.

Do:

- use visibility detection and caching.
- keep OCR local when practical.
- keep translation provider-agnostic.
- preserve coordinates throughout the pipeline.
- test on multiple manga-reader layouts.
- benchmark OCR engines before committing.
- design for responsive scaling and scrolling.
- keep MVP small but extensible.

---

## 19. Recommended Starting Point

Do not start by writing the entire extension.

First produce a technical design answering:

1. How should manga images/regions be detected?
2. How should new content be detected on scroll?
3. How should `<img>`, canvas, CSS background, lazy-loaded images, and custom readers be handled?
4. Which local OCR engine is best for Japanese manga?
5. Can OCR run in browser/WASM, or is a local service better?
6. How should vertical Japanese text be reconstructed?
7. How should reading order be calculated?
8. How should content hashing/cache work?
9. How should Manifest V3 components communicate?
10. How should Google translation be integrated legally/technically?
11. How should Local LLM translation work?
12. How should overlay coordinates remain aligned with responsive manga images?

After that, create an MVP implementation plan.

Do not over-engineer, but do not make assumptions that will block support for multiple manga sites later.

---

## 20. Long-Term Vision

The ideal experience is:

```text
Open Extension
      ↓
Enable Manga Translate Mode
      ↓
Read manga normally
      ↓
Scroll
      ↓
Translation appears automatically
```

Future capabilities:

- character memory
- context-aware translation
- LLM translation
- speech bubble detection
- improved reading order
- text inpainting
- better Thai typography
- multiple manga site support
- additional source/target languages
