import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquire } from './acquire';
import { profileFor } from './site-profiles';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acquire blob images', () => {
  it('falls back to the decoded image when the blob URL is no longer fetchable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const png = new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' });
    const toBlob = vi.fn((callback: BlobCallback) => callback(png));
    const canvas = {
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob,
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const img = {
      currentSrc: 'blob:https://mangaplus.shueisha.co.jp/df824551-99ba-4a4b-84a3-2f8a7e5cea1e',
      src: '',
      complete: true,
      naturalWidth: 1200,
      naturalHeight: 1800,
    } as HTMLImageElement;

    const result = await acquire(
      img,
      profileFor(new URL('https://mangaplus.shueisha.co.jp/viewer/1007468')),
    );

    expect(result).toMatchObject({
      kind: 'bytes',
      natural: { w: 1200, h: 1800 },
      ref: { bytes: 3, inlineBase64: 'AQID' },
    });
    expect(toBlob).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  });

  it('reports when neither the blob URL nor the decoded image can be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const canvas = {
      getContext: () => ({ drawImage: () => { throw new DOMException('Tainted canvas'); } }),
      toBlob: vi.fn(),
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const img = {
      currentSrc: 'blob:https://mangaplus.shueisha.co.jp/page',
      src: '',
      complete: true,
      naturalWidth: 1200,
      naturalHeight: 1800,
    } as HTMLImageElement;

    await expect(
      acquire(img, profileFor(new URL('https://mangaplus.shueisha.co.jp/viewer/1007468'))),
    ).rejects.toMatchObject({
      code: 'ACQUIRE_FAILED',
      message: expect.stringContaining('decoded-image fallback failed'),
    });
  });
});
