import { describe, expect, it } from 'vitest';
import { bumpTrailingNumber } from './page-url';

describe('bumpTrailingNumber', () => {
  it('advances the page number of a real imhentai image URL', () => {
    expect(bumpTrailingNumber('https://m10.imhentai.xxx/029/yco3vdf5wj/1.webp', 1)).toBe(
      'https://m10.imhentai.xxx/029/yco3vdf5wj/2.webp',
    );
    expect(bumpTrailingNumber('https://m10.imhentai.xxx/029/yco3vdf5wj/9.webp', 3)).toBe(
      'https://m10.imhentai.xxx/029/yco3vdf5wj/12.webp',
    );
  });

  it('keeps zero padding, because a padded CDN 404s on an unpadded name', () => {
    expect(bumpTrailingNumber('https://cdn.example/a/007.jpg', 1)).toBe(
      'https://cdn.example/a/008.jpg',
    );
    expect(bumpTrailingNumber('https://cdn.example/a/098.jpg', 5)).toBe(
      'https://cdn.example/a/103.jpg',
    );
  });

  it('works without an extension', () => {
    expect(bumpTrailingNumber('https://cdn.example/page/4', 2)).toBe('https://cdn.example/page/6');
  });

  it('leaves query and hash alone', () => {
    expect(bumpTrailingNumber('https://cdn.example/a/1.webp?token=abc#x', 1)).toBe(
      'https://cdn.example/a/2.webp?token=abc#x',
    );
  });

  it('refuses to guess when the last segment is not a number', () => {
    expect(bumpTrailingNumber('https://cdn.example/a/cover.webp', 1)).toBeNull();
    expect(bumpTrailingNumber('https://cdn.example/a/page-3a.webp', 1)).toBeNull();
    expect(bumpTrailingNumber('https://cdn.example/a/', 1)).toBeNull();
  });

  it('refuses blob: and anything else with no path to bump', () => {
    expect(bumpTrailingNumber('blob:https://mangadex.org/2f1c-9a', 1)).toBeNull();
    expect(bumpTrailingNumber('not a url', 1)).toBeNull();
  });

  it('never produces page 0 or a negative page', () => {
    expect(bumpTrailingNumber('https://cdn.example/a/1.webp', -1)).toBeNull();
    expect(bumpTrailingNumber('https://cdn.example/a/3.webp', -2)).toBe(
      'https://cdn.example/a/1.webp',
    );
  });

  it('rejects a non-integer delta rather than building a URL with a decimal in it', () => {
    expect(bumpTrailingNumber('https://cdn.example/a/1.webp', 1.5)).toBeNull();
    expect(bumpTrailingNumber('https://cdn.example/a/1.webp', Number.NaN)).toBeNull();
  });
});
