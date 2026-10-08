# Chrome Web Store submission notes

Kept up to date with the manifest. Each permission below has the justification
to paste into the store's "Privacy practices" form. If a permission is added or
removed in `wxt.config.ts`, change this file in the same commit.

Idea from Chrome's [Build extensions with AI](https://developer.chrome.com/docs/extensions/ai/build-with-ai) guide.

## Single purpose

Translates the text in manga and comic images on the page the user is reading
into the user's chosen language, and draws the translation over the original
speech bubbles.

## Permission justifications

| Permission | Why it is needed |
|---|---|
| `offscreen` | Runs the on-device text detector (ONNX Runtime with WebGPU/WebAssembly). The service worker has no DOM and cannot host it; the offscreen document is the MV3-sanctioned place for this. |
| `storage` | Stores the user's settings and their own Gemini API key in `chrome.storage.local`. Never synced. |
| `contextMenus` | Adds "Translate this image" to the right-click menu so a user can translate one image on any site without enabling automatic translation there. |
| `activeTab` | Lets the right-click action work on the current tab without granting standing access to it. |
| Host permission `<all_urls>` | (1) Manga images are usually served from a different domain (a CDN) than the reading site; reading their pixels requires fetching them from the service worker. (2) Sending the cropped text regions to the Gemini API. The content script is declared for all pages so the right-click action and per-site switch work anywhere, but on a site the user has not switched on it only reads its settings and stays idle: no image is read and nothing is sent. |

## Remote code

None. All JavaScript and the WebAssembly runtime ship in the package. The text
detection model (`models/ppocr-v4-det.onnx`) is bundled data, not code.

## Data usage (for the form)

- Collected by the developer: **nothing**. There is no developer server.
- Sent to a third party: cropped text regions of images and the user's API key,
  to the Google Gemini API, only when the user asks for a translation.
- Form categories to tick: **Website content** (image crops) and **Authentication information** (the user's own API key, sent only to Google).
- Not sold, not used for anything unrelated to the single purpose, not used for credit decisions.
- Privacy policy URL: https://github.com/dinotong/Manga-Translator/blob/main/docs/privacy.md

## Listing

- Name: Manga Translator
- Category: Productivity (or Accessibility)
- Screenshots (1280x800, 1 to 5): **an original sample page we own**, not pages from a real manga.
  A published manga's pages in our listing are someone else's copyrighted art and a takedown risk.
  Never screenshot adult sites for the listing.
- Small promo tile 440x280 (the store asks for it), marquee 1400x560 optional.
- Icon: `public/icon/128.png`

## Known review risks

- `<all_urls>` triggers in-depth review; the justification above must match what the code does.
- A site profile for an adult site is included by decision of the owner
  (docs/04-public-release-plan.md). The listing should not mention it.
