import { describe, it, expect, vi } from 'vitest';
import { summarize, statusLabel, startLive } from '../../public/js/live.js';

describe('summarize', () => {
  it('says who did what', () => {
    expect(summarize([])).toBe('');
    expect(summarize([{ actor: 'Hermes', summary: 'added 2 card(s)' }])).toBe('Hermes added 2 card(s)');
    expect(summarize([{ actor: 'Hermes' }, { actor: 'Ekko' }, { actor: 'Hermes' }])).toBe(
      'Hermes and Ekko made 3 changes'
    );
    expect(summarize([{ actor: 'A' }, { actor: 'B' }, { actor: 'C' }])).toBe('A, B and others made 3 changes');
    expect(summarize([{ summary: 'moved x' }, { summary: 'y' }])).toBe('An agent made 2 changes');
  });
});

describe('statusLabel', () => {
  it('puts the state in words', () => {
    expect(statusLabel(null)).toBeNull();
    expect(statusLabel({ state: 'odd' })).toBeNull();
    expect(statusLabel({ state: 'doing', by: 'Hermes', detail: 'drafting' })).toEqual({
      text: 'Doing · Hermes',
      title: 'Hermes: doing (drafting)',
    });
    expect(statusLabel({ state: 'blocked' })).toEqual({ text: 'Blocked', title: 'An agent: blocked' });
  });
});

describe('startLive', () => {
  const setup = (answers, extra = {}) => {
    const calls = [];
    const opts = {
      every: 1e9,
      fetchActivity: vi.fn(async since => {
        calls.push(since);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a;
      }),
      boardId: () => 'c_1',
      canReload: () => true,
      reload: vi.fn(async () => {}),
      notify: vi.fn(),
      visible: () => true,
      ...extra,
    };
    return { opts, calls };
  };
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('reloads the open board when an agent changed it, and says so', async () => {
    const { opts, calls } = setup([
      { latest: 5, items: [] },
      {
        latest: 7,
        items: [
          { id: 7, canvasId: 'c_1', actor: 'Hermes', summary: 'moved "A" to Done' },
          { id: 6, canvasId: 'c_2' },
        ],
      },
      { latest: 7, items: [] },
    ]);
    const live = startLive(opts);
    await flush();
    await live.tick();
    expect(opts.reload).toHaveBeenCalledTimes(1);
    expect(opts.notify).toHaveBeenCalledWith('Hermes moved "A" to Done');
    await live.tick();
    expect(calls).toEqual([0, 5, 7]);
    expect(opts.reload).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it('waits while you are editing, and skips hidden pages and errors', async () => {
    let editing = true,
      visible = true;
    const { opts } = setup(
      [
        { latest: 1, items: [] },
        new Error('offline'),
        { latest: 2, items: [{ canvasId: 'c_1', actor: 'Ekko', summary: 'added card "x"' }] },
        { latest: 2, items: [] },
      ],
      { canReload: () => !editing, visible: () => visible }
    );
    const live = startLive(opts);
    await flush();
    await live.tick(); // error
    await live.tick(); // editing: waits
    expect(opts.reload).not.toHaveBeenCalled();
    visible = false;
    await live.tick(); // hidden: nothing fetched
    visible = true;
    editing = false;
    await live.tick();
    expect(opts.reload).toHaveBeenCalledTimes(1);
    expect(opts.notify).toHaveBeenCalledWith('Ekko added card "x"');
    live.stop();
  });
});
