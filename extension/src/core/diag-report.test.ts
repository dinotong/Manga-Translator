import { describe, expect, it } from 'vitest';
import { formatDiagnostics, redactSecrets } from './diag-report';

const meta = { version: '1.0.0', userAgent: 'TestBrowser/1', at: '2026-10-08T12:00:00.000Z' };
const KEY = `AIza${'x'.repeat(31)}AbCd`;

describe('redactSecrets', () => {
  it('masks a Google API key down to its last four characters', () => {
    expect(KEY).toHaveLength(39);
    expect(redactSecrets(`key=${KEY}&x`)).toBe('key=AIza…AbCd&x');
  });

  it('masks every key, not just the first', () => {
    const out = redactSecrets(`${KEY} and ${KEY}`);
    expect(out).not.toContain('xxxx');
    expect(out.match(/AIza…AbCd/g)).toHaveLength(2);
  });

  it('leaves text without keys alone', () => {
    expect(redactSecrets('ใช้ได้ · โมเดล gemini-flash-lite-latest')).toBe(
      'ใช้ได้ · โมเดล gemini-flash-lite-latest',
    );
  });
});

describe('formatDiagnostics', () => {
  it('puts version, browser and time first', () => {
    const out = formatDiagnostics([], meta).split('\n');
    expect(out.slice(1, 4)).toEqual([
      'version: 1.0.0',
      'browser: TestBrowser/1',
      'at: 2026-10-08T12:00:00.000Z',
    ]);
  });

  it('writes one line per check, and the fix only when there is one', () => {
    const out = formatDiagnostics(
      [
        { label: 'WebGPU', status: 'ok', detail: 'NVIDIA', fix: '' },
        { label: 'Gemini API key', status: 'fail', detail: 'ยังไม่ได้ใส่', fix: 'ขอ key ฟรี' },
      ],
      meta,
    );
    expect(out).toContain('[OK] WebGPU: NVIDIA');
    expect(out).toContain('[FAIL] Gemini API key: ยังไม่ได้ใส่');
    expect(out).toContain('fix: ขอ key ฟรี');
    expect(out.match(/fix:/g)).toHaveLength(1);
  });

  it('never lets a key through, even inside an upstream error message', () => {
    const out = formatDiagnostics(
      [{ label: 'Gemini API key', status: 'fail', detail: `400: API key ${KEY} not valid`, fix: '' }],
      meta,
    );
    expect(out).not.toContain(KEY);
    expect(out).toContain('AIza…AbCd');
  });
});
