import { describe, expect, it } from 'vitest';
import { parsePlanMarkdown, planCommentBody, planItemDigest, planItemDigests, removePlanCommentMarker } from './plan';

const plan = `# ログイン改善

## 目的
OAuth ログインの失敗率を下げる。

- [ ] エラー表示を整理する
  invalid_oauth_callback と invalid_oauth_state を区別する。
- [ ] リトライ導線を追加する
- [x] ログを追加する
`;

describe('parsePlanMarkdown', () => {
  it('parses the title, description, items, and item bodies', () => {
    const parsed = parsePlanMarkdown(plan);
    expect(parsed.title).toBe('ログイン改善');
    expect(parsed.body).toBe(plan);
    expect(parsed.items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(parsed.items[0].title).toBe('エラー表示を整理する');
    expect(parsed.items[0].body).toBe('invalid_oauth_callback と invalid_oauth_state を区別する。');
    expect(parsed.items[0].completed).toBe(false);
    expect(parsed.items[2].completed).toBe(true);
  });

  it('parses a plan comment body after the marker', () => {
    const parsed = parsePlanMarkdown(removePlanCommentMarker(planCommentBody(plan)));
    expect(parsed.title).toBe('ログイン改善');
    expect(parsed.items).toHaveLength(3);
  });
});

describe('plan item digests', () => {
  it('gives identical items different digests', async () => {
    const parsed = parsePlanMarkdown('- [ ] 同じタイトル\n- [ ] 同じタイトル');
    const digests = await planItemDigests(100, parsed.items);
    expect(digests.get(1)).not.toBe(digests.get(2));
  });

  it('keeps the digest stable for the same item', async () => {
    const first = await planItemDigest(100, { title: 'タイトル', body: '本文' });
    const second = await planItemDigest(100, { title: ' タイトル ', body: '本文\n' });
    expect(first).toBe(second);
  });
});
