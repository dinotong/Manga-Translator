import { describe, expect, it } from 'vitest';
import { serialQueue } from './serial';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('serialQueue', () => {
  it('runs tasks one at a time in call order', async () => {
    const run = serialQueue();
    const log: string[] = [];
    const task = (id: string) => async () => {
      log.push(`start ${id}`);
      await tick();
      log.push(`end ${id}`);
      return id;
    };
    expect(await Promise.all([run(task('a')), run(task('b'))])).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('a failure rejects only its own caller', async () => {
    const run = serialQueue();
    const failed = run(async () => {
      throw new Error('boom');
    });
    const after = run(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  it('separate queues do not wait for each other', async () => {
    const a = serialQueue();
    const b = serialQueue();
    let release!: () => void;
    const blocked = a(() => new Promise<void>((r) => (release = r)));
    await expect(b(async () => 'free')).resolves.toBe('free');
    release();
    await blocked;
  });
});
