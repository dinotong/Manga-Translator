import {
  allSpent,
  type ApiKeyEntry,
  backoffMs,
  keyFingerprint,
  type KeyStatuses,
  isUsable,
  nextQuotaResetAt,
  pickKey,
  type QuotaVerdict,
  withExhausted,
  withInvalid,
} from '../core/quota';
import { DEFAULT_LIMIT, pickPaced } from '../core/rate-limit';
import { PipelineError } from '../shared/errors';
import { loadKeyStatuses, saveKeyStatuses, tidyKeyStatuses } from '../shared/key-status';
import { makeLog } from '../shared/log';
import { loadRates, ratesNow, reserve } from '../shared/rate-record';
import type { Settings } from '../shared/settings';
import {
  GeminiProvider,
  type GeminiConfig,
  type PagesRead,
  type ReadResult,
} from './GeminiProvider';

const log = makeLog('keyring');

/**
 * Several Gemini keys, paced so the extension stays under their limits instead
 * of discovering them by being refused.
 *
 * Gemini answers **429 for two unrelated conditions**, and this class exists
 * because treating them the same destroys the feature:
 *
 * - 15 requests/minute exceeded. Transient. Wait, or move to a key that has
 *   room, and retry.
 * - 1,000 requests/day exceeded. Terminal until midnight Pacific. Only this one
 *   marks a key spent.
 *
 * core/quota.ts does that classification against a real captured response body,
 * and an unclassifiable 429 counts as per-minute — being wrong that way costs a
 * pause, being wrong the other way costs a key for a day.
 *
 * ## What changed, and why the old rule was wrong
 *
 * The ring used to be strictly ordered: key 2 was touched only once key 1 was
 * out of quota *for the day*. That reads sensibly and is wrong in the case that
 * matters, because it means a reader hitting the *per-minute* ceiling on key 1
 * sits and waits while key 2's entire per-minute allowance goes unused. Two keys
 * are two ceilings; the old rule made them one.
 *
 * It is now: the key whose next free slot is soonest, ties going to the order
 * the user chose (core/rate-limit.ts). While key 1 has room, everything still
 * goes to key 1 — so a spare still drains second against the 1,000/day counter
 * and still behaves like a spare. Spreading happens only when spreading is the
 * only way to go faster.
 *
 * Measured before any of this: three real reads issued 19 requests and took
 * **zero** 429s, at 2.5-3.0 requests per minute against a ceiling of 15 per key.
 * So pacing is not what makes the extension faster — the concurrency split and
 * batching do that. Pacing is what keeps it safe once those two make it able to
 * exceed the ceiling for the first time.
 */

/** Per-minute waits allowed inside one logical call before giving up. */
const MAX_MINUTE_RETRIES = 2;

export interface KeyRingOptions {
  /**
   * Longest a single call may sit waiting for a free slot or out of a
   * per-minute refusal.
   *
   * Speculative work passes a smaller budget than the reader's own, but no
   * longer zero: jobs used to be serialised, so a parked prefetch parked the
   * visible page with it. They are not any more, and a prefetch that gives up
   * instantly throws away work already paid for — the image was fetched and the
   * detector has already run on it.
   */
  maxWaitMs: number;
  /** Told about a wait so the status pill can explain the pause. */
  onWait?: (ms: number, verdict: QuotaVerdict | null) => void;
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

  static async create(settings: Settings, lang: LangCfg, opts: KeyRingOptions): Promise<KeyRing> {
    const keys = settings.translation.gemini.keys;
    if (keys.every((k) => k.key.trim() === '')) {
      throw new PipelineError('NO_API_KEY', 'no Gemini API key configured');
    }
    // Clearing yesterday's exhaustion on load, rather than on a timer, is what
    // makes the reset happen without the user having to do anything.
    const statuses = await tidyKeyStatuses(keys);
    // Pull the rate record into memory before anything reserves against it, so
    // a worker that has just restarted does not start from a blank window.
    await loadRates();
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

  /** Crops from several pages in one request. See core/batch.ts. */
  async readPages(
    pages: readonly (readonly ArrayBuffer[])[],
    signal?: AbortSignal,
  ): Promise<PagesRead> {
    return this.run((p) => p.readPages(pages, signal), signal);
  }

  async readPage(crops: readonly ArrayBuffer[], signal?: AbortSignal): Promise<ReadResult[]> {
    if (crops.length === 0) return [];
    return this.run((p) => p.readPage(crops, signal), signal);
  }

  /**
   * Retry a refused page one bubble at a time.
   *
   * Re-implemented here rather than delegated so each single-bubble call gets
   * its own key choice: a page that needs this costs N requests, which is
   * exactly the situation most likely to run a key out of per-minute room
   * halfway through.
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
    let paced = 0;
    // Time this request spent held back by *our own* pacing, as opposed to by
    // Gemini. The two are indistinguishable from outside and need opposite
    // fixes — one is a number we chose, the other is somebody else's latency.
    let pacedMs = 0;
    let backedOffMs = 0;

    for (;;) {
      const now = Date.now();
      const usable = this.keys.filter((k) => isUsable(k, this.statuses[k.id], now));
      const choice = usable.length
        ? pickPaced(usable, (k) => ratesNow()[k.id] ?? [], now, DEFAULT_LIMIT)
        : null;
      if (!choice) throw this.nothingLeft();

      const entry = choice.key;

      if (choice.readyAt > now) {
        // Every key we may use is full for the moment. Waiting here is the
        // whole point: the alternative is a request that earns a 429 and then
        // has to wait *anyway*, having spent a round trip to find out.
        const wait = Math.min(choice.readyAt - now, this.opts.maxWaitMs);
        if (wait <= 0 || paced >= MAX_MINUTE_RETRIES) {
          throw new PipelineError(
            'QUOTA_EXCEEDED',
            `all keys paced out for ${choice.readyAt - now} ms`,
            `ยิงครบโควตาต่อนาทีของทุก key แล้ว — รออีก ${Math.ceil((choice.readyAt - now) / 1000)} วินาที`,
          );
        }
        paced++;
        pacedMs += wait;
        log.debug(`pacing: no free slot for ${wait} ms`);
        this.opts.onWait?.(wait, null);
        await sleep(wait, signal);
        continue;
      }

      // Synchronous, before any await: this is what stops two concurrent jobs
      // from both deciding the same last slot is theirs.
      reserve(entry.id, now);

      try {
        const sentAt = Date.now();
        const out = await fn(this.provider(entry));
        if (pacedMs > 0 || backedOffMs > 0) {
          log.info(
            `key wait: paced=${pacedMs}ms backoff=${backedOffMs}ms upstream=${Date.now() - sentAt}ms`,
          );
        }
        return out;
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

        const verdict = err.quota ?? {
          scope: 'unknown' as const,
          retryAfterMs: null,
          quotaId: null,
          limit: null,
        };

        if (verdict.scope === 'per-day') {
          log.info(`key ${label(entry)} is out of daily quota — moving to the next one`);
          await this.mark((s) => withExhausted(s, entry.id, Date.now()));
          continue;
        }

        // Per-minute, or a body we could not read. Our own pacing was wrong or
        // something outside this extension is spending the same key, so believe
        // the API: fill this key's window so the next pick moves elsewhere.
        fillWindow(entry.id, Date.now());
        const wait = Math.min(backoffMs(verdict, waits), this.opts.maxWaitMs);
        if (waits >= MAX_MINUTE_RETRIES || wait <= 0) throw err;
        waits++;
        backedOffMs += wait;
        log.info(`per-minute limit on ${label(entry)} — waiting ${wait} ms`);
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

/**
 * Believe a 429 over our own bookkeeping.
 *
 * Our window can be an undercount for reasons we cannot see: the same key pasted
 * into a second browser profile, or another tool of the user's. When the API says
 * the key is full, marking it full is what moves the next request to the other
 * key instead of walking into a second refusal.
 */
function fillWindow(keyId: string, now: number): void {
  for (let i = 0; i < DEFAULT_LIMIT.limit; i++) reserve(keyId, now);
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
