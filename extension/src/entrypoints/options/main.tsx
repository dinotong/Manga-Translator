import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../../ui/ui.css';
import {
  clampCacheBytes,
  clampCachePages,
  estimateBytesForPages,
  MAX_CACHE_PAGES,
  MIN_CACHE_PAGES,
} from '../../core/cache-budget';
import {
  clampLookahead,
  effectiveLookahead,
  LOOKAHEAD_WHOLE_CHAPTER,
  MAX_LOOKAHEAD,
} from '../../core/prefetch';
import { clampInFlight, MAX_IN_FLIGHT_CEILING } from '../../core/scheduling';
import { MAX_PAGES_PER_REQUEST } from '../../core/batch';
import {
  type ApiKeyEntry,
  keyFingerprint,
  keyReport,
  type KeyState,
  type KeyStatuses,
  moveKey,
  nextQuotaResetAt,
  withCleared,
} from '../../core/quota';
import { PRESETS, type PresetName } from '../../core/resolution';
import { withAutoSite } from '../../core/site-scope';
import {
  loadKeyStatuses,
  onKeyStatusesChanged,
  updateKeyStatuses,
} from '../../shared/key-status';
import {
  LANG_LABELS_TH,
  SOURCE_LANGS,
  TARGET_LANGS,
  type SourceLang,
  type TargetLang,
} from '../../shared/lang';
import type { CacheStats, DiagnosticLine, Request, Response } from '../../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings';

/**
 * Cache sizes worth one click, in the words the question arrives in.
 *
 * The extension cannot ask the site how long the chapter is — gallery length is
 * read in the content script, and the budget is applied in the service worker —
 * so "ทั้งตอน" is a number chosen to be larger than any chapter rather than a
 * measured one. 60 covers the long end of a MangaDex chapter (20–45) with room
 * to page backwards; 200 covers a whole imhentai gallery. Both cost under a
 * megabyte, which is what makes being generous here easy.
 */
const CACHE_PRESETS = [
  { pages: 40, label: '40 หน้า' },
  { pages: 60, label: 'ทั้งตอน (60)' },
  { pages: 200, label: 'ทั้งเล่ม (200)' },
  { pages: MAX_CACHE_PAGES, label: `เก็บหมด (${MAX_CACHE_PAGES})` },
] as const;

/** Ceilings offered in MB. Anything hand-edited is shown as-is rather than lost. */
const CACHE_BYTE_CHOICES = [20, 50, 100, 200, 500, 1000, 2000];

/**
 * Set-once settings, plus the diagnostics page.
 *
 * Diagnostics is the single most valuable screen here. Once the extension is in
 * a friend's hands, "it doesn't work" is the entire bug report you will get, and
 * one button that names the broken subsystem and prints the fix next to it is
 * the difference between one screenshot and an afternoon of questions.
 */
function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [statuses, setStatuses] = useState<KeyStatuses>({});
  /** Per-key test result, keyed by entry id. */
  const [tests, setTests] = useState<Record<string, { busy: boolean; msg: string; ok?: boolean }>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [lines, setLines] = useState<DiagnosticLine[] | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [stats, setStats] = useState<CacheStats | null>(null);

  useEffect(() => {
    void loadSettings().then(setS);
    void loadKeyStatuses().then(setStatuses);
    void refreshStats();
    // The service worker marks a key exhausted mid-read; this page should show
    // it happening rather than only after a reload.
    return onKeyStatusesChanged(setStatuses);
  }, []);

  async function patch(next: Partial<Settings>) {
    setS(await saveSettings(next));
  }

  async function refreshStats() {
    const res = await send({ t: 'CACHE_STATS' });
    if ('stats' in res) setStats(res.stats);
  }

  /* ---------------- API keys ---------------- */

  const keys = s.translation.gemini.keys;

  async function setKeys(next: ApiKeyEntry[]) {
    await patch({
      translation: { ...s.translation, gemini: { ...s.translation.gemini, keys: next } },
    });
  }

  async function addKey() {
    await setKeys([
      ...keys,
      { id: crypto.randomUUID(), label: `key ${keys.length + 1}`, key: '' },
    ]);
  }

  async function editKey(id: string, patchEntry: Partial<ApiKeyEntry>) {
    await setKeys(keys.map((k) => (k.id === id ? { ...k, ...patchEntry } : k)));
    // Changing the key text makes anything we knew about it obsolete: a pasted
    // replacement for a revoked key must not stay marked invalid.
    if (patchEntry.key !== undefined) {
      setStatuses(await updateKeyStatuses((cur) => withCleared(cur, id)));
      setTests((t) => ({ ...t, [id]: { busy: false, msg: '' } }));
    }
  }

  async function removeKey(id: string) {
    await setKeys(keys.filter((k) => k.id !== id));
    setStatuses(await updateKeyStatuses((cur) => withCleared(cur, id)));
  }

  async function testKey(entry: ApiKeyEntry) {
    setTests((t) => ({ ...t, [entry.id]: { busy: true, msg: 'กำลังทดสอบ…' } }));
    const res = await send({
      t: 'TEST_KEY',
      apiKey: entry.key,
      model: s.translation.gemini.model,
    });
    if (res.ok) {
      // A key that answers is not exhausted and not revoked, whatever we had
      // recorded — the live answer wins over the bookkeeping.
      setStatuses(await updateKeyStatuses((cur) => withCleared(cur, entry.id)));
      setTests((t) => ({ ...t, [entry.id]: { busy: false, msg: 'ใช้ได้ ✓', ok: true } }));
    } else {
      setTests((t) => ({
        ...t,
        [entry.id]: { busy: false, msg: `${res.message}\n${res.hint}`, ok: false },
      }));
    }
  }

  async function runDiagnostics() {
    setDiagBusy(true);
    const res = await send({ t: 'DIAGNOSE' });
    setLines('lines' in res ? res.lines : [{ id: 'x', label: 'ตรวจไม่สำเร็จ', status: 'fail', detail: JSON.stringify(res), fix: '' }]);
    setDiagBusy(false);
    void refreshStats();
  }

  const g = s.translation.gemini;
  const now = Date.now();
  const report = keyReport(keys, statuses, now);
  const allSpent = keys.length > 0 && !report.some((r) => r.state === 'active');
  const resetLabel = new Date(nextQuotaResetAt(now)).toLocaleString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });

  return (
    <div style="max-width:640px;margin:0 auto">
      <h1>ตั้งค่า Manga Translator</h1>
      <p class="hint">ตั้งครั้งเดียวก็พอ · สิ่งที่ใช้ทุกวันอยู่ในป๊อปอัปที่ไอคอน</p>

      <section>
        <h2>Gemini API key</h2>
        <p class="hint">
          ขอฟรีที่{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>{' '}
          — ไม่ต้องผูกบัตร ใช้ได้ 1,000 ครั้ง/วัน (เท่ากับ ~1,000 หน้า เพราะเราส่งทั้งหน้าใน 1 ครั้ง)
        </p>
        <p class="hint">
          ใส่ได้<b>หลาย key เรียงตามลำดับ</b> — ใช้อันบนสุดก่อน พอโควตารายวันหมดจะเลื่อนไปอันถัดไปให้เอง
          {keys.length > 1 ? ` · ตอนนี้มี ${keys.length} key = ${keys.length * 1000} หน้า/วัน` : ''}
        </p>

        {keys.length === 0 && (
          <p class="hint fail">ยังไม่มี key เลย — กด “เพิ่ม key” แล้ววาง key ที่ขอมา</p>
        )}

        {report.map((r, i) => {
          const t = tests[r.entry.id];
          return (
            <div key={r.entry.id} class="keyrow">
              <div class="row">
                <span class={`badge ${STATE_CLASS[r.state]}`}>
                  {i + 1}. {STATE_TH[r.state]}
                </span>
                <input
                  type="text"
                  value={r.entry.label}
                  placeholder={`key ${i + 1}`}
                  style="flex:1"
                  onInput={(e) =>
                    void editKey(r.entry.id, { label: (e.target as HTMLInputElement).value })
                  }
                />
                <button
                  title="เลื่อนขึ้น"
                  disabled={i === 0}
                  onClick={() => void setKeys(moveKey(keys, i, -1))}
                >
                  ↑
                </button>
                <button
                  title="เลื่อนลง"
                  disabled={i === keys.length - 1}
                  onClick={() => void setKeys(moveKey(keys, i, 1))}
                >
                  ↓
                </button>
                <button title="ลบ key นี้" onClick={() => void removeKey(r.entry.id)}>
                  ลบ
                </button>
              </div>

              <div class="row" style="margin-top:6px">
                <input
                  type={revealed[r.entry.id] ? 'text' : 'password'}
                  value={r.entry.key}
                  placeholder="AIza..."
                  onInput={(e) =>
                    void editKey(r.entry.id, { key: (e.target as HTMLInputElement).value })
                  }
                />
                <button
                  onClick={() => setRevealed((v) => ({ ...v, [r.entry.id]: !v[r.entry.id] }))}
                >
                  {revealed[r.entry.id] ? 'ซ่อน' : 'ดู'}
                </button>
                <button
                  onClick={() => void testKey(r.entry)}
                  disabled={t?.busy || !r.entry.key.trim()}
                >
                  ทดสอบ
                </button>
              </div>

              {r.state === 'exhausted' && (
                <p class="hint warn">
                  โควตารายวันหมดตั้งแต่ {r.status?.exhaustedOn} (นับตามวันแบบแปซิฟิก) — จะกลับมาใช้ได้เอง{' '}
                  {resetLabel} น.
                </p>
              )}
              {r.state === 'invalid' && (
                <p class="hint fail" style="white-space:pre-wrap">
                  ข้ามอันนี้ไป: {r.status?.invalid} — แก้ key แล้วสถานะจะรีเซ็ตเอง
                </p>
              )}
              {t?.msg && (
                <p
                  class={`hint ${t.ok === true ? 'ok' : t.ok === false ? 'fail' : ''}`}
                  style="white-space:pre-wrap"
                >
                  {t.msg}
                </p>
              )}
            </div>
          );
        })}

        <div class="row" style="margin-top:8px">
          <button onClick={() => void addKey()}>+ เพิ่ม key</button>
        </div>

        {allSpent && (
          <div class="note">
            <b>ใช้ครบทุก key แล้ว</b> — โควตารายวันจะรีเซ็ต {resetLabel} น.
            (Google นับวันตาม<b>เวลาแปซิฟิก</b> ไม่ใช่เวลาไทย จึงไม่ตรงกับเที่ยงคืนบ้านเรา)
            ระหว่างนี้เพิ่ม key ใหม่ได้ หรือปิดแปลอัตโนมัติแล้วใช้คลิกขวาเฉพาะหน้าที่อยากอ่าน
          </div>
        )}

        <label>โมเดล</label>
        <input
          type="text"
          value={g.model}
          onInput={(e) =>
            void patch({
              translation: {
                ...s.translation,
                gemini: { ...g, model: (e.target as HTMLInputElement).value },
              },
            })
          }
        />
        <p class="hint">
          ใช้ชื่อที่ลงท้ายด้วย <code>-latest</code> เสมอ — Google ปิดเวอร์ชันย่อยเป็นระยะ
          (<code>gemini-2.5-flash-lite</code> คืน 404 ไปแล้ว)
        </p>

        <label class="switch">
          <input
            type="checkbox"
            checked={g.safetyOff}
            onChange={(e) =>
              void patch({
                translation: {
                  ...s.translation,
                  gemini: { ...g, safetyOff: (e.target as HTMLInputElement).checked },
                },
              })
            }
          />
          ปิดตัวกรองเนื้อหาทั้ง 4 หมวด
        </label>
        <p class="hint">
          จำเป็นกับมังงะผู้ใหญ่ · ตัวป้องกันหลักของ Google ปิดไม่ได้ ถ้าโดนปฏิเสธระบบจะลองส่งใหม่ทีละกล่องให้เอง
        </p>

        <div class="note">
          API key ที่เก็บใน extension <b>ไม่ถือเป็นความลับ</b> — คนที่เข้าถึงเครื่องนี้ได้อ่านได้
          แนะนำให้ตั้ง restriction ฝั่ง Google และอย่าใช้ key ที่ผูกกับโปรเจกต์ที่มีบิล
          · Gemini free tier อาจนำข้อความที่ส่งไปใช้ปรับปรุงโมเดลของ Google
          <br />
          <b>ยิ่งใส่หลาย key ยิ่งมีของให้เสีย</b> — ทุก key ในรายการนี้เก็บแบบเดียวกันหมด
          ถ้าเครื่องหลุดก็หลุดพร้อมกันทั้งชุด
        </div>
      </section>

      <section>
        <h2>เว็บที่เปิดแปลอัตโนมัติ</h2>
        <p class="hint">
          แปลอัตโนมัติ<b>แยกตามเว็บ</b> — เปิดที่เว็บไหนก็ทำงานเฉพาะเว็บนั้น
          เว็บที่ไม่ได้อยู่ในรายการนี้จะไม่ถูกสแกน ไม่ยิงคำขอ และไม่กินโควตาเลย
        </p>
        <p class="hint">
          เปิด/ปิดทำที่<b>ป๊อปอัปตอนอยู่บนเว็บนั้น</b> · หน้านี้มีไว้ดูว่าเปิดอะไรค้างไว้บ้างและเอาออก
        </p>

        {s.autoSites.length === 0 ? (
          <p class="hint">
            ยังไม่ได้เปิดเว็บไหนเลย — เปิดหน้ามังงะ กดไอคอนส่วนเสริม แล้วเปิดสวิตช์ “แปลอัตโนมัติเฉพาะเว็บนี้”
          </p>
        ) : (
          s.autoSites.map((host) => (
            <div key={host} class="row" style="margin-top:6px">
              <span class="badge ok">เปิด</span>
              <span style="flex:1">{host}</span>
              <button
                title={`เลิกแปลอัตโนมัติที่ ${host}`}
                onClick={() => void patch({ autoSites: withAutoSite(s.autoSites, host, false) })}
              >
                เอาออก
              </button>
            </div>
          ))
        )}

        <p class="hint" style="margin-top:8px">
          เอาออกแล้วเว็บนั้นกลับไปเป็นโหมดสั่งเอง — คลิกขวาที่รูป → “แปลรูปนี้” ยังใช้ได้ทุกเว็บเสมอ
        </p>
      </section>

      <section>
        <h2>ภาษา</h2>
        <label>ต้นทาง</label>
        <select
          value={s.lang.source}
          onChange={(e) =>
            void patch({ lang: { ...s.lang, source: (e.target as HTMLSelectElement).value as SourceLang } })
          }
        >
          {SOURCE_LANGS.map((l) => (
            <option key={l} value={l}>{LANG_LABELS_TH[l]}</option>
          ))}
        </select>
        <label>ปลายทาง</label>
        <select
          value={s.lang.target}
          onChange={(e) =>
            void patch({ lang: { ...s.lang, target: (e.target as HTMLSelectElement).value as TargetLang } })
          }
        >
          {TARGET_LANGS.map((l) => (
            <option key={l} value={l}>{LANG_LABELS_TH[l]}</option>
          ))}
        </select>
      </section>

      <section>
        <h2>การรวมกล่องข้อความ</h2>
        <p class="hint">
          ปกติแต่ละกล่องที่ตรวจเจอจะถูกแปลแยกกัน หัวข้อนี้คือข้อยกเว้นข้อเดียวของกฎนั้น
        </p>

        <label class="switch">
          <input
            type="checkbox"
            checked={s.translation.modelGrouping}
            onChange={(e) =>
              void patch({
                translation: {
                  ...s.translation,
                  modelGrouping: (e.target as HTMLInputElement).checked,
                },
              })
            }
          />
          ให้โมเดลบอกว่ากล่องไหนเป็นประโยคเดียวกัน
        </label>
        <p class="hint">
          <b>ปิดไว้เป็นค่าเริ่มต้น และควรเปิดเฉพาะตอนที่ต้องการจริงๆ</b>
          <br />
          <b>ได้อะไร:</b> หน้าเขียนมือ/afterword ที่ประโยคเดียวกระจายอยู่หลายคอลัมน์แนวตั้ง
          จะถูกแปลรวมเป็นประโยคเดียวแทนที่จะเป็นเศษๆ ที่ต่างคนต่างแปล
          <br />
          <b>เสียอะไร:</b> ถ้าโมเดลเสนอผิด กล่องของ<b>คนละคนพูด</b>อาจถูกรวมกัน
          แล้วคำแปลเดียวจะถูกวางคร่อมทั้งสองบอลลูน — ฟังดูลื่นและมั่นใจแต่ผิด และผู้อ่านมองไม่ออก
          เคยเกิดขึ้นจริงมาแล้วกับหน้าอังกฤษ 3 บอลลูน จึงจำกัดให้ทำงานเฉพาะข้อความ<b>แนวตั้ง</b>
          และต้องผ่านการตรวจพิกัดอีกชั้น (ต้องอยู่ติดกันอยู่แล้ว ต้องเป็นเศษไม่ใช่ทั้ง bubble ขนาดตัวอักษรพอกัน)
          <br />
          ปิดแล้ว<b>มีผลกับหน้าที่เคยอ่านไปแล้วด้วย</b> ไม่ต้องล้างแคช และได้พฤติกรรมเดิมเป๊ะ
        </p>
      </section>

      <section>
        <h2>การแสดงผล</h2>
        <label>โหมด</label>
        <select
          value={s.display.mode}
          onChange={(e) =>
            void patch({
              display: { ...s.display, mode: (e.target as HTMLSelectElement).value as Settings['display']['mode'] },
            })
          }
        >
          <option value="target-only">แสดงคำแปลอย่างเดียว</option>
          <option value="target-plus-source-on-hover">แสดงคำแปล · ชี้เมาส์เพื่อดูต้นฉบับ</option>
        </select>

        <label class="switch">
          <input
            type="checkbox"
            checked={s.display.peekOnHover}
            onChange={(e) =>
              void patch({
                display: {
                  ...s.display,
                  peekOnHover: (e.target as HTMLInputElement).checked,
                },
              })
            }
          />
          ชี้เมาส์ที่กล่องแล้วจางลงเพื่อดูภาพข้างหลัง
        </label>
        <p class="hint">
          กล่องคำแปลมักใหญ่กว่าตัวหนังสือเดิม เลยบังลายเส้นไปด้วย · ชี้เมาส์ค้างที่กล่องไหน
          <b>เฉพาะกล่องนั้น</b>จะจางลงให้เห็นภาพ ขยับเมาส์ออกก็กลับมาเหมือนเดิม
        </p>
        <p class="hint">
          กล่องคำแปล<b>ไม่ดูดคลิก</b> — คลิกทะลุไปที่หน้าเว็บได้ตามปกติ
          (เว็บอย่าง imhentai เปลี่ยนหน้าด้วยการคลิกที่รูป ถ้ากล่องดูดคลิกไว้จะกดเปลี่ยนหน้าไม่ได้)
        </p>

        <label>ขนาดตัวอักษร ({s.display.fontScale.toFixed(2)}×)</label>
        <input
          type="range" min="0.7" max="1.5" step="0.05"
          value={String(s.display.fontScale)}
          onInput={(e) =>
            void patch({ display: { ...s.display, fontScale: Number((e.target as HTMLInputElement).value) } })
          }
        />

        <label>ความทึบของแผ่นปิดต้นฉบับ ({Math.round(s.display.plateOpacity * 100)}%)</label>
        <input
          type="range" min="0.3" max="1" step="0.02"
          value={String(s.display.plateOpacity)}
          onInput={(e) =>
            void patch({ display: { ...s.display, plateOpacity: Number((e.target as HTMLInputElement).value) } })
          }
        />
        <p class="hint">
          แผ่นนี้ทับ<b>เฉพาะกรอบที่ตรวจเจอตัวหนังสือ</b> — หน้าที่เดียวคือกลบต้นฉบับ
          ลดลงเมื่ออยากเห็นตัวอักษรญี่ปุ่นข้างใต้ · 100% = กลบมิด
        </p>

        <label>ความทึบของพื้นหลังคำแปล ({Math.round(s.display.panelOpacity * 100)}%)</label>
        <input
          type="range" min="0" max="1" step="0.02"
          value={String(s.display.panelOpacity)}
          onInput={(e) =>
            void patch({ display: { ...s.display, panelOpacity: Number((e.target as HTMLInputElement).value) } })
          }
        />
        <p class="hint">
          กล่องคำแปล<b>กว้างกว่า</b>ตัวหนังสือเดิมเสมอเมื่อต้นฉบับเป็นแนวตั้ง (ไทยเขียนแนวนอน
          ถ้าใช้ความกว้างเท่าเดิมจะได้ตัวละบรรทัด) — ส่วนที่กว้างเกินมาคือ<b>ลายเส้น</b>
          ตั้งค่านี้ต่ำๆ แล้วจะเห็นภาพทะลุหลังตัวหนังสือ โดยต้นฉบับยังถูกแผ่นด้านบนกลบอยู่
        </p>
        <p class="hint">
          ต้นฉบับที่เป็น<b>แนวนอน</b>อยู่แล้วไม่ถูกขยาย สองค่านี้จึงทับกันพอดี —
          กรณีนั้นจะวาดชั้นเดียวด้วยค่าที่<b>ทึบกว่า</b> ไม่ใช่สองชั้นซ้อนกัน
        </p>
      </section>

      <section>
        <h2>ขั้นสูง — การตรวจจับข้อความ</h2>
        <p class="hint">ค่าเริ่มต้นใช้ได้เลย แตะเมื่อผลลัพธ์ไม่ดีเท่านั้น</p>

        <label>Runtime</label>
        <select
          value={s.ocr.runtime}
          onChange={(e) =>
            void patch({ ocr: { ...s.ocr, runtime: (e.target as HTMLSelectElement).value as Settings['ocr']['runtime'] } })
          }
        >
          <option value="auto">อัตโนมัติ (WebGPU ก่อน แล้วค่อย WASM)</option>
          <option value="webgpu">WebGPU เท่านั้น</option>
          <option value="wasm">WASM เท่านั้น</option>
        </select>
        <p class="hint">วัดจริงบน RTX 3060: WebGPU ~120 มิลลิวินาที/หน้า · WASM ~710 มิลลิวินาที/หน้า</p>

        <label>ความละเอียด</label>
        <select
          value={s.ocr.preset}
          onChange={(e) =>
            void patch({ ocr: { ...s.ocr, preset: (e.target as HTMLSelectElement).value as PresetName } })
          }
        >
          {(Object.keys(PRESETS) as PresetName[]).map((p) => (
            <option key={p} value={p}>
              {p} ({PRESETS[p].detTarget} / {PRESETS[p].recTarget} px)
            </option>
          ))}
        </select>

        <label>การรวมตัวอักษรเป็นบรรทัด (dilate {s.ocr.dilateRatio.toFixed(3)})</label>
        <input
          type="range" min="0" max="0.03" step="0.0025"
          value={String(s.ocr.dilateRatio)}
          onInput={(e) =>
            void patch({ ocr: { ...s.ocr, dilateRatio: Number((e.target as HTMLInputElement).value) } })
          }
        />
        <p class="hint">
          สูงเกินไป = สอง bubble ติดกันถูกรวมเป็นอันเดียว · ต่ำเกินไป = ได้ตัวอักษรทีละตัว
        </p>
      </section>

      <section>
        <h2>แปลล่วงหน้า</h2>
        <label>
          อ่านล่วงหน้า{' '}
          {s.performance.prefetchLookahead === 0
            ? 'ปิด'
            : s.performance.prefetchLookahead >= LOOKAHEAD_WHOLE_CHAPTER
              ? 'ทั้งตอน'
              : `${s.performance.prefetchLookahead} หน้า`}
        </label>
        <div class="row">
          {[
            { label: 'ปิด', pages: 0 },
            { label: '3 หน้า', pages: 3 },
            { label: '10 หน้า', pages: 10 },
            { label: '40 หน้า', pages: 40 },
            { label: 'ทั้งตอน', pages: LOOKAHEAD_WHOLE_CHAPTER },
          ].map((p) => (
            <button
              key={p.pages}
              class={s.performance.prefetchLookahead === p.pages ? 'primary' : undefined}
              onClick={() =>
                void patch({ performance: { ...s.performance, prefetchLookahead: p.pages } })
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="range" min="0" max={String(MAX_LOOKAHEAD)} step="1"
          value={String(s.performance.prefetchLookahead)}
          onInput={(e) =>
            void patch({
              performance: {
                ...s.performance,
                prefetchLookahead: clampLookahead((e.target as HTMLInputElement).value),
              },
            })
          }
        />
        <p class="hint">
          แปลหน้าถัดๆ ไปไว้ล่วงหน้าขณะที่คุณยังอ่านหน้านี้ พอกดหน้าถัดไปคำแปลจะขึ้นทันที ·
          <b>0 = ปิด</b> · <b>ทั้งตอน</b> = อ่านล่วงหน้าไปจนจบเล่ม (สูงสุด {MAX_LOOKAHEAD} หน้า) ·
          ทำงานเฉพาะตอนเปิด “แปลอัตโนมัติ”
        </p>
        <p class="hint">
          <b>ตั้งลึกขึ้น = ไปได้ไกลขึ้น ไม่ใช่ยิงถี่ขึ้น</b> — ยังคงยิงทีละคำขอ เว้นอย่างน้อย 0.5 วินาที
          และ<b>หยุดทันทีที่สลับไปแท็บอื่น</b> เพื่อไม่ให้รบกวนเซิร์ฟเวอร์ของเว็บที่เราไปอ่าน ·
          หน้าที่คุณกำลังดูอยู่ได้คิวก่อนการเดาเสมอ
          · ใช้ได้เฉพาะเว็บที่เดา URL หน้าถัดไปได้ (imhentai) · MangaDex สร้าง URL ในโค้ดของตัวเอง จึงเดาไม่ได้และไม่ทำ
        </p>
        {effectiveLookahead(s.performance.prefetchLookahead, s.cache.maxPages) <
          s.performance.prefetchLookahead && (
          <p class="hint warn">
            แคชเก็บได้ {s.cache.maxPages} หน้า จึงอ่านล่วงหน้าได้จริง{' '}
            <b>{effectiveLookahead(s.performance.prefetchLookahead, s.cache.maxPages)} หน้า</b> —
            ถ้าอ่านล่วงหน้าเกินขนาดแคช หน้าแรกๆ จะถูกลบทิ้งก่อนคุณอ่านถึง เสียทั้งคำขอและโควตา ·
            เพิ่มขนาดแคชด้านล่างถ้าอยากได้ลึกกว่านี้
          </p>
        )}
        <p class="hint">
          ตอนนี้ส่ง crop ของหลายหน้าไปใน<b>คำขอเดียว</b> (สูงสุด {MAX_PAGES_PER_REQUEST} หน้า) —
          แปลได้เร็วขึ้นโดย<b>ไม่กินโควตาต่อนาทีเพิ่ม</b> · แต่ถ้าเลิกอ่านกลางคัน หน้าที่แปลไว้ล่วงหน้าจะเสียเปล่า
        </p>

        <label>งานพร้อมกัน {s.performance.maxConcurrentRequests} งาน</label>
        <input
          type="range" min="1" max={String(MAX_IN_FLIGHT_CEILING)} step="1"
          value={String(s.performance.maxConcurrentRequests)}
          onInput={(e) =>
            void patch({
              performance: {
                ...s.performance,
                maxConcurrentRequests: clampInFlight((e.target as HTMLInputElement).value),
              },
            })
          }
        />
        <p class="hint">
          หนึ่งงาน = โหลดรูป + หากล่องข้อความ + ส่งให้ Gemini · วัดจริงแล้ว <b>97% ของเวลาคือรอ Gemini ตอบ</b>
          (0.1–0.5 วินาทีหากล่อง เทียบกับ 1.3–41 วินาทีรอเน็ต) จึงทำหลายงานพร้อมกันได้ ·
          <b>การหากล่องยังทำทีละรูป</b>เสมอ เพราะ ONNX session ใช้ซ้อนกันไม่ได้ ·
          หนึ่งช่องถูกกันไว้ให้หน้าที่คุณกำลังดูเสมอ การเดาจะไม่มีวันแย่งไปหมด
        </p>
      </section>

      <section>
        <h2>แคช</h2>
        <p class="hint">
          หน้าที่แปลไว้แล้วจะไม่ถูกส่งไปแปลซ้ำ — ย้อนกลับไปอ่านหน้าเดิมจึงขึ้นทันทีและไม่เสียโควตา
        </p>

        <label>เก็บไว้กี่หน้า</label>
        <div class="row">
          {CACHE_PRESETS.map((p) => (
            <button
              key={p.pages}
              class={s.cache.maxPages === p.pages ? 'primary' : undefined}
              onClick={() => void patch({ cache: { ...s.cache, maxPages: p.pages } })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="number"
          min={String(MIN_CACHE_PAGES)}
          max={String(MAX_CACHE_PAGES)}
          step="1"
          value={String(s.cache.maxPages)}
          onChange={(e) =>
            void patch({
              cache: { ...s.cache, maxPages: clampCachePages((e.target as HTMLInputElement).value) },
            })
          }
        />
        <p class="hint">
          {s.cache.maxPages} หน้า ≈ <b>{(estimateBytesForPages(s.cache.maxPages) / 1e6).toFixed(1)} MB</b>{' '}
          บนดิสก์ — แคชเก็บ<b>ตำแหน่งกล่องกับตัวหนังสือ ไม่ได้เก็บรูป</b> หน้าหนึ่งจึงประมาณ 4 KB เท่านั้น ·
          ตอนหนึ่งของ MangaDex ปกติ 20–45 หน้า
        </p>
        <p class="hint">
          ต่ำสุด {MIN_CACHE_PAGES} หน้า · <b>ขนาดแคชเป็นตัวจำกัดว่าจะอ่านล่วงหน้าได้ลึกแค่ไหน</b> —
          อ่านล่วงหน้าเกินขนาดแคช หน้าแรกๆ จะถูกลบทิ้งก่อนคุณอ่านถึง เสียทั้งคำขอและโควตาฟรีๆ
          จึงตัดให้เหลือเท่าที่แคชรับไหวโดยอัตโนมัติ
          {s.performance.prefetchLookahead > 0 && (
            <> · ตอนนี้ตั้งอ่านล่วงหน้าไว้ {s.performance.prefetchLookahead} หน้า</>
          )}
        </p>

        <label>เพดานพื้นที่ (ตัวกันจริง)</label>
        <select
          value={String(Math.round(s.cache.maxBytes / 1024 / 1024))}
          onChange={(e) =>
            void patch({
              cache: {
                ...s.cache,
                maxBytes: clampCacheBytes(Number((e.target as HTMLSelectElement).value) * 1024 * 1024),
              },
            })
          }
        >
          {/* A hand-edited ceiling gets its own row rather than showing as blank. */}
          {[...new Set([...CACHE_BYTE_CHOICES, Math.round(s.cache.maxBytes / 1024 / 1024)])]
            .sort((a, b) => a - b)
            .map((mb) => (
              <option key={mb} value={String(mb)}>
                {mb} MB
              </option>
            ))}
        </select>
        <p class="hint">
          จำนวนหน้าบอกไม่ได้ว่ากินดิสก์เท่าไร ถ้าวันหนึ่งหน้าหนึ่งใหญ่กว่าที่วัดไว้มากๆ เพดานนี้คือตัวหยุดจริง ·
          ถึงเพดานเมื่อไหร่จะลบหน้าเก่าสุดก่อนเสมอ ไม่ว่าจะยังไม่ครบจำนวนหน้าก็ตาม
        </p>

        <label>ใช้ไปแล้ว</label>
        <p class="hint">
          {stats ? (
            <>
              <b>
                {stats.ocrRecords} / {s.cache.maxPages} หน้า
              </b>{' '}
              · {(stats.bytes / 1e6).toFixed(2)} / {(s.cache.maxBytes / 1e6).toFixed(0)} MB ·{' '}
              {stats.translationRecords} ประโยค
            </>
          ) : (
            'กำลังอ่าน…'
          )}
        </p>
        <div class="row">
          <button onClick={() => void refreshStats()}>อ่านค่าใหม่</button>
          <button onClick={() => void send({ t: 'CACHE_CLEAR', which: 'translation' }).then(refreshStats)}>
            ล้างเฉพาะคำแปล
          </button>
          <button onClick={() => void send({ t: 'CACHE_CLEAR', which: 'all' }).then(refreshStats)}>
            ล้างทั้งหมด
          </button>
        </div>
        <p class="hint">
          ล้างเฉพาะคำแปลเมื่ออยากแปลใหม่ด้วยโมเดลอื่น — ผลการอ่านภาพซึ่งแพงกว่าจะยังอยู่ ·
          ช่อง “ประโยค” ไม่ถูกนับเป็นหน้า มันถูกใช้ซ้ำข้ามเรื่องและจะถูกลบก็ต่อเมื่อชนเพดานพื้นที่จริงๆ
        </p>
      </section>

      <section>
        <h2>ตรวจสอบระบบ</h2>
        <div class="row">
          <button class="primary" onClick={() => void runDiagnostics()} disabled={diagBusy}>
            {diagBusy ? 'กำลังตรวจ…' : 'ตรวจสอบระบบ'}
          </button>
          <button onClick={() => void send({ t: 'PREWARM' })}>อุ่นเครื่องโมเดล</button>
        </div>

        {lines && (
          <ul class="diag">
            {lines.map((l) => (
              <li key={l.id}>
                <div class={l.status}>
                  <span class="label">
                    {l.status === 'ok' ? '✅' : l.status === 'warn' ? '⚠️' : '❌'} {l.label}
                  </span>
                </div>
                <div class="detail">{l.detail}</div>
                {l.fix && <div class="fix">↳ {l.fix}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p class="foot">
        Apache-2.0 · ตัวตรวจจับข้อความคือ PP-OCRv4 det (Apache-2.0) ดาวน์โหลดครั้งแรก 4.7 MB
      </p>
    </div>
  );
}

const STATE_TH: Record<KeyState, string> = {
  active: 'กำลังใช้',
  standby: 'สำรอง',
  exhausted: 'โควตาหมดวันนี้',
  invalid: 'ถูกปฏิเสธ',
  empty: 'ว่าง',
};

const STATE_CLASS: Record<KeyState, string> = {
  active: 'ok',
  standby: '',
  exhausted: 'warn',
  invalid: 'fail',
  empty: '',
};

async function send(req: Request): Promise<Response> {
  return (await chrome.runtime.sendMessage(req)) as Response;
}

render(<Options />, document.getElementById('app')!);
