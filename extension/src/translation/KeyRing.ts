import {
  allSpent,
  type ApiKeyEntry,
  backoffMs,
  keyFingerprint,
  type KeyStatuses,
  nextQuotaResetAt,
  pickKey,
  type QuotaVerdict,
  withExhausted,
  withInvalid,
} from '../core/quota';
import { PipelineError } from '../shared/errors';
import { loadKeyStatuses, saveKeyStatuses, tidyKeyStatuses } from '../shared/key-status';
import { makeLog } from '../shared/log';
import type { Settings } from '../shared/settings';
import { GeminiProvider, type GeminiConfig, type ReadResult } from './GeminiProvider';

const log = makeLog('keyring');

/**
 * Several Gemini keys, used strictly in the order the user listed them.
 *
 * The free tier meters 1,000 requests per key per day, so a second key is
 * simply a second day of reading. The subtlety — and the only reason this is a
 * class instead of three lines in the pipeline — is that Gemini answers **429
 * for two unrelated conditions**:
 *
 * - 15 requests/minute exceeded. Transient. The right move is to wait the delay
 *   the API itself supplies and retry the *same* key.
 * - 1,000 requests/day exceeded. Terminal until midnight Pacific. Only this one
 *   may advance to the next key.
 *
 * Rotating on the first kind is the failure that matters: a reader turning
 * pages quickly trips 15 RPM easily, and a ring that advances on it would walk
 * through every key the owner has within seconds and leave them with nothing —
 * with no visible cause, because each individual request "just" got a 429.
 * core/quota.ts does the classification against a real captured response body.
 *
 * An unclassifiable 429 counts as per-minute. Being wrong that way costs a
 * pause; being wrong the other way costs a key for a day.
 */

/** Per-minute waits allowed inside one logical call before giving up. */
const MAX_MINUTE_RETRIES = 2;

export interface KeyRingOptions {
  /**
   * Longest a single call may sit waiting out a per-minute limit.
   *
   * Zero for speculative work: the worker runs one job at a time, so a prefetch
   * that parks for 30 seconds also parks the page the reader is staring at.
   */
  maxWaitMs: number;
  /** Told about a wait so the status pill can explain the pause. */
  onWait?: (ms: number, verdict: QuotaVerdict) => void;
}

type LangCfg = Omit<GeminiConfig, 'apiKey' | 'model' | 'safetyOff'>;

export class KeyRing {
  private statuses: KeyStatuses;
  private readonly providers = new Map<string, GeminiProvider>();

  readonly id = 'gemini';

  private constructor(
    private readonly keys: readonly ApiKeyEntry[],
    statuses: KeyStatuses,
    readonly model: string,
    private readonly safetyOff: boolean,
    private readonly lang: LangCfg,
    private readonly opts: KeyRingOptions,
  ) {
    this.statuses = statuses;
  }

  static async create(
    settings: Settings,
    lang: LangCfg,
    opts: KeyRingOptions,
  ): Promise<KeyRing> {
    const keys = settings.translation.gemini.keys;
    if (keys.every((k) => k.key.trim() === '')) {
      throw new PipelineError('NO_API_KEY', 'no Gemini API key configured');
    }
    // Clearing yesterday's exhaustion on load, rather than on a timer, is what
    // makes the reset happen without the user having to do anything.
    const statuses = await tidyKeyStatuses(keys);
    return new KeyRing(
      keys,
      statuses,
      settings.translation.gemini.model,
      settings.translation.gemini.safetyOff,
      lang,
      opts,
    );
  }

  /** Identity for the OCR cache key. Independent of which key paid for it. */
  get recognizerId(): string {
    return `gemini-vision@${this.model}`;
  }

  /** Label of the key that would be used next, for logs and the status pill. */
  activeLabel(): string | null {
    const entry = pickKey(this.keys, this.statuses, Date.now());
    return entry ? entry.label || keyFingerprint(entry.key) : null;
  }

  async readPage(crops: readonly ArrayBuffer[], signal?: AbortSignal): Promise<ReadResult[]> {
    if (crops.length === 0) return [];
    return this.run((p) => p.readPage(crops, signal), signal);
  }

  /**
   * Retry a refused page one bubble at a time.
   *
   * Re-implemented here rather than delegated so each single-bubble call gets
   * its own rotation: a page that needs this costs N requests, which is exactly
   * the situation most likely to exhaust the key halfway through.
   */
  async readPageIndividually(
    crops: readonly ArrayBuffer[],
    signal?: AbortSignal,
  ): Promise<(ReadResult | null)[]> {
    const out: (ReadResult | null)[] = [];
    for (const crop of crops) {
      try {
        const [only] = await this.readPage([crop], signal);
        out.push(only ?? null);
      } catch (err) {
        if (err instanceof PipelineError && err.code === 'PROVIDER_REFUSED') {
          out.push(null);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  async translateBatch(texts: readonly string[], signal?: AbortSignal): Promise<string[]> {
    return this.run((p) => p.translateBatch(texts, signal), signal);
  }

  /* ---------------------------------------------------------------- */

  private provider(entry: ApiKeyEntry): GeminiProvider {
    let p = this.providers.get(entry.id);
    if (!p) {
      p = new GeminiProvider({
        apiKey: entry.key,
        model: this.model,
        safetyOff: this.safetyOff,
        ...this.lang,
      });
      this.providers.set(entry.id, p);
    }
    return p;
  }

  private async run<T>(
    fn: (provider: GeminiProvider) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let waits = 0;

    for (;;) {
      const entry = pickKey(this.keys, this.statuses, Date.now());
      if (!entry) throw this.nothingLeft();

      try {
        return await fn(this.provider(entry));
      } catch (err) {
        if (!(err instanceof PipelineError)) throw err;

        if (err.code === 'INVALID_KEY') {
          // Skipped with a reason, never marked exhausted: "come back tomorrow"
          // is the wrong instruction for a key that was revoked or typo'd, and
          // it would silently come back into rotation the next day.
          log.warn(`key ${label(entry)} rejected: ${err.message.slice(0, 80)}`);
          await this.mark((s) => withInvalid(s, entry.id, err.message.slice(0, 120), Date.now()));
          continue;
        }

        if (err.code !== 'QUOTA_EXCEEDED') throw err;

        const verdict = err.quota ?? { scope: 'unknown' as const, retryAfterMs: null, quotaId: null, limit: null };

        if (verdict.scope === 'per-day') {
          log.info(`key ${label(entry)} is out of daily quota — moving to the next one`);
          await this.mark((s) => withExhausted(s, entry.id, Date.now()));
          continue;
        }

        // Per-minute, or a body we could not read. Same key, after a pause.
        const wait = Math.min(backoffMs(verdict, waits), this.opts.maxWaitMs);
        if (waits >= MAX_MINUTE_RETRIES || wait <= 0) throw err;
        waits++;
        log.info(`per-minute limit on ${label(entry)} — waiting ${wait} ms and retrying same key`);
        this.opts.onWait?.(wait, verdict);
        await sleep(wait, signal);
      }
    }
  }

  private async mark(fn: (s: KeyStatuses) => KeyStatuses): Promise<void> {
    // Re-read before writing: the worker may have been restarted, and another
    // job may have learned something about a different key in the meantime.
    this.statuses = fn(await loadKeyStatuses());
    await saveKeyStatuses(this.statuses);
  }

  /**
   * Nothing usable is left — say which case it is and when it ends.
   *
   * A silent failure here is indistinguishable from the extension being broken,
   * which is the single most expensive kind of bug to have in a friend's hands.
   */
  private nothingLeft(): PipelineError {
    const now = Date.now();
    if (allSpent(this.keys, this.statuses, now)) {
      const spent = this.keys.filter((k) => this.statuses[k.id]?.exhaustedOn).length;
      const broken = this.keys.filter((k) => this.statuses[k.id]?.invalid).length;
      const reset = new Date(nextQuotaResetAt(now)).toLocaleString('th-TH', {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short',
      });
      const parts = [
        spent > 0 ? `โควตารายวันหมด ${spent} key` : '',
        broken > 0 ? `ใช้ไม่ได้ ${broken} key` : '',
      ].filter(Boolean);
      return new PipelineError(
        'ALL_KEYS_EXHAUSTED',
        `${parts.join(' · ')} จากทั้งหมด ${this.keys.length}`,
        broken === this.keys.length
          ? 'ทุก key ถูกปฏิเสธ — เปิดหน้าตั้งค่าแล้วกด “ทดสอบ” ทีละอันเพื่อดูว่าอันไหนพัง'
          : `ใช้ครบทุก key แล้ว · โควตาจะรีเซ็ตอีกครั้ง ${reset} น. (เที่ยงคืนเวลาแปซิฟิก) · เพิ่ม key สำรองได้ในหน้าตั้งค่า`,
      );
    }
    return new PipelineError('NO_API_KEY', 'no usable Gemini API key');
  }
}

function label(entry: ApiKeyEntry): string {
  // Never the key itself, not even in a debug log — extension logs get pasted
  // into bug reports.
  return entry.label ? `“${entry.label}” ${keyFingerprint(entry.key)}` : keyFingerprint(entry.key);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PipelineError('CANCELLED', 'aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new PipelineError('CANCELLED', 'aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
