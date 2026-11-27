"use strict";

/**
 * Token bucket: `burst` actions at once, refilling at `perSecond`.
 * `now` can be replaced in tests.
 */
function createBucket({ perSecond, burst, now = Date.now }) {
  let tokens = burst;
  let last = now();

  return {
    take(cost = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    }
  };
}

module.exports = { createBucket };
