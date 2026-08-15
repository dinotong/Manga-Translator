import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../../ui/ui.css';
import { isAutoOn, siteKey, withAutoSite } from '../../core/site-scope';
import { LANG_LABELS_TH, SOURCE_LANGS, TARGET_LANGS, type SourceLang, type TargetLang } from '../../shared/lang';
import type { Request, Response } from '../../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings';

/**
 * The everyday surface: what you touch while reading.
 *
 * Anything you set once — API key, runtime, cache — lives in options instead.
 * Mixing them turns the popup into a settings page that happens to have a
 * toggle, which is exactly the thing you do not want in front of you on page 40.
 */
function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /**
   * The site this popup is talking about.
   *
   * `undefined` while it is still being read, `null` on a page that cannot have
   * a setting (chrome://, a local file). Told apart because "loading" and
   * "this page can never be switched on" want different words on screen.
   */
  const [site, setSite] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void loadSettings().then(setSettings);
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setSite(tab?.url ? siteKey(tab.url) : null));
  }, []);

  async function patch(next: Partial<Settings>) {
    setSettings(await saveSettings(next));
  }

  /** The switch reads and writes this one site, never the browser as a whole. */
  const autoHere = isAutoOn(settings.autoSites, site ?? null);

  async function toggleAutoHere(on: boolean) {
    if (!site) return;
    await patch({ autoSites: withAutoSite(settings.autoSites, site, on) });
  }

  async function toggleEnabled(on: boolean) {
    await patch({ enabled: on });
    if (on) {
      // Pay the WebGPU shader-compile cost now, while the user is still looking
      // at the popup, instead of on the first page they open.
      setNote('กำลังอุ่นเครื่องโมเดล…');
      await send({ t: 'PREWARM' });
      setNote('พร้อมแล้ว');
      setTimeout(() => setNote(''), 1500);
    }
  }

  async function translateNow() {
    setBusy(true);
    setNote('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('ไม่พบแท็บที่เปิดอยู่');
      const res = await send({ t: 'TRANSLATE_VISIBLE', tabId: tab.id });
      if (!res.ok) setNote(res.hint || res.message);
      else window.close();
    } catch (err) {
      setNote(`สั่งแปลไม่ได้: ${String(err)} — ลองรีเฟรชหน้าเว็บก่อน`);
    } finally {
      setBusy(false);
    }
  }

  const hasKey = settings.translation.gemini.keys.some((k) => k.key.trim().length > 0);

  return (
    <div style="width:280px">
      <h1>Manga Translator</h1>

      {!hasKey && (
        <div class="note">
          ยังไม่ได้ใส่ Gemini API key —{' '}
          <a href="#" onClick={() => chrome.runtime.openOptionsPage()}>
            เปิดหน้าตั้งค่า
          </a>
        </div>
      )}

      <section>
        <label class="switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => void toggleEnabled((e.target as HTMLInputElement).checked)}
          />
          เปิดใช้งาน (ทุกเว็บ)
        </label>
        <p class="hint">สวิตช์หยุดทุกอย่าง — ปิดแล้วส่วนเสริมไม่ทำอะไรเลยทั้งเบราว์เซอร์</p>

        <label class="switch">
          <input
            type="checkbox"
            checked={autoHere}
            disabled={!settings.enabled || !site}
            onChange={(e) => void toggleAutoHere((e.target as HTMLInputElement).checked)}
          />
          แปลอัตโนมัติ<b>เฉพาะเว็บนี้</b>
        </label>
        <p class="hint">
          {site === undefined ? (
            'กำลังดูว่าเปิดเว็บอะไรอยู่…'
          ) : site === null ? (
            'หน้านี้ไม่ใช่เว็บไซต์ (เช่น edge://, ไฟล์ในเครื่อง) จึงเปิดให้ไม่ได้'
          ) : (
            <>
              สวิตช์นี้มีผลกับ <b>{site}</b> เท่านั้น — {autoHere ? 'ตอนนี้เปิดอยู่' : 'ตอนนี้ปิดอยู่'}
              {' · '}เว็บอื่นที่ยังไม่เคยเปิดจะไม่ทำงานและไม่เสียโควตาเลย
            </>
          )}
        </p>
        <p class="hint">
          จำไว้ให้เอง — เปิดครั้งเดียวแล้วกลับมาอ่านเว็บนี้อีกก็ทำงานต่อโดยไม่ต้องเปิดใหม่
          {settings.performance.prefetchLookahead > 0
            ? ` · แปลล่วงหน้าอีก ${settings.performance.prefetchLookahead} หน้าบนเว็บที่เดาหน้าถัดไปได้`
            : ''}
        </p>
        <p class="hint">
          ปิดไว้ = แปลเฉพาะตอนสั่งเอง (คลิกขวาที่รูป → “แปลรูปนี้”) ซึ่ง<b>ใช้ได้ทุกเว็บ</b>เสมอ
        </p>
        {settings.autoSites.length > 0 && (
          <p class="hint">
            เปิดอัตโนมัติไว้ {settings.autoSites.length} เว็บ:{' '}
            {settings.autoSites.join(', ')} ·{' '}
            <a href="#" onClick={() => chrome.runtime.openOptionsPage()}>
              จัดการรายการ
            </a>
          </p>
        )}
      </section>

      <section>
        <label>ภาษาต้นทาง</label>
        <select
          value={settings.lang.source}
          onChange={(e) =>
            void patch({
              lang: { ...settings.lang, source: (e.target as HTMLSelectElement).value as SourceLang },
            })
          }
        >
          {SOURCE_LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABELS_TH[l]}
            </option>
          ))}
        </select>

        <label>ภาษาปลายทาง</label>
        <select
          value={settings.lang.target}
          onChange={(e) =>
            void patch({
              lang: { ...settings.lang, target: (e.target as HTMLSelectElement).value as TargetLang },
            })
          }
        >
          {TARGET_LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABELS_TH[l]}
            </option>
          ))}
        </select>
      </section>

      <div class="row">
        <button class="primary" disabled={busy || !hasKey} onClick={() => void translateNow()}>
          {busy ? 'กำลังสั่ง…' : 'แปลหน้านี้เดี๋ยวนี้'}
        </button>
        <button onClick={() => chrome.runtime.openOptionsPage()}>ตั้งค่า</button>
      </div>

      {note && <p class="hint">{note}</p>}
      <p class="foot">คลิกขวาที่รูป → “แปลรูปนี้” ได้เสมอแม้ปิดแปลอัตโนมัติ</p>
    </div>
  );
}

async function send(req: Request): Promise<Response> {
  return (await chrome.runtime.sendMessage(req)) as Response;
}

render(<Popup />, document.getElementById('app')!);
