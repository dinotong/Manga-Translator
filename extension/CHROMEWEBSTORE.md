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
| Host permission `<all_urls>` | (1) Manga images are usually served from a different domain (a CDN) than the reading site; reading their pixels requires fetching them from the service worker. (2) Sending the cropped text regions to the Gemini API. The extension only scans pages on sites the user has explicitly switched on, or an image the user right-clicks. |

## Remote code

None. All JavaScript and the WebAssembly runtime ship in the package. The text
detection model (`models/ppocr-v4-det.onnx`) is bundled data, not code.

## Data usage (for the form)

- Collected by the developer: **nothing**. There is no developer server.
- Sent to a third party: cropped text regions of images and the user's API key,
  to the Google Gemini API, only when the user asks for a translation.
- Privacy policy: `docs/privacy.md` (publish its URL once the repository is public).

## Listing

- Name: Manga Translator
- Category: Productivity (or Accessibility)
- Screenshots: use MangaDex pages only. Never screenshot adult sites for the listing.
- Icon: `public/icon/128.png`

## Known review risks

- `<all_urls>` triggers in-depth review; the justification above must match what the code does.
- A site profile for an adult site is included by decision of the owner
  (docs/04-public-release-plan.md). The listing should not mention it.
