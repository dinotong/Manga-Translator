/**
 * Diagnostics as plain text a user can paste into a bug report.
 *
 * A stranger reporting "it doesn't work" gives us nothing to act on; the
 * diagnostics screen already knows the browser, the GPU path, the model and
 * the key state. This turns it into something they can copy in one click.
 *
 * It must never carry a secret. The diagnostic lines only show key labels and
 * fingerprints, but some lines quote error messages from upstream, and those
 * are not ours to vouch for — so anything shaped like a Google API key is
 * masked here, at the last step before the text leaves the extension.
 */

export interface ReportLine {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix: string;
}

export interface ReportMeta {
  version: string;
  userAgent: string;
  /** ISO timestamp, passed in so the function stays pure. */
  at: string;
}

/** Google API keys: "AIza" followed by 35 URL-safe characters. */
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/g;

export function redactSecrets(text: string): string {
  return text.replace(GOOGLE_KEY, (k) => `AIza…${k.slice(-4)}`);
}

const MARK: Record<ReportLine['status'], string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };

export function formatDiagnostics(lines: readonly ReportLine[], meta: ReportMeta): string {
  const out = [
    'Manga Translator — diagnostics',
    `version: ${meta.version}`,
    `browser: ${meta.userAgent}`,
    `at: ${meta.at}`,
    '',
  ];
  for (const l of lines) {
    out.push(`[${MARK[l.status]}] ${l.label}: ${l.detail}`);
    if (l.fix) out.push(`       fix: ${l.fix}`);
  }
  return redactSecrets(out.join('\n'));
}
