// 登录限流 —— 内存滑动窗口。
//
// 只挡「反复试密码」这一件事：check 看有没有超、fail 记一次失败、succeed 清零。
// 不挡正常请求，所以不用令牌桶，也不用落库。

/**
 * @param {{windowMs?: number, max?: number, now?: () => number}} opts
 */
export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} key -> 失败时间戳（升序） */
  const hits = new Map();

  function live(key) {
    const list = hits.get(key);
    if (!list) return [];
    const cutoff = now() - windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
    return kept;
  }

  return {
    /** 只读检查，不记数 */
    check(key) {
      const list = live(key);
      if (list.length < max) {
        return { ok: true, remaining: max - list.length, retryAfterMs: 0 };
      }
      // 最早那次失败滑出窗口时才能再试
      const oldest = list[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - now());
      return { ok: false, remaining: 0, retryAfterMs };
    },

    /** 记一次失败 */
    fail(key) {
      const list = live(key);
      list.push(now());
      hits.set(key, list);
      return { count: list.length, exceeded: list.length >= max };
    },

    /** 成功后清零 */
    succeed(key) {
      hits.delete(key);
    },

    /** 定期清掉过期条目的钩子，server 可以挂 setInterval */
    prune() {
      const cutoff = now() - windowMs;
      let removed = 0;
      for (const [key, list] of hits) {
        const kept = list.filter((t) => t > cutoff);
        if (kept.length === 0) {
          hits.delete(key);
          removed += 1;
        } else if (kept.length !== list.length) {
          hits.set(key, kept);
        }
      }
      return { removed, keys: hits.size };
    },

    /** 测试用 */
    size() {
      return hits.size;
    },
  };
}
