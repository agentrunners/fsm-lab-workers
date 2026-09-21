// stress/lib/pool-lane.mjs — the PoolLane model (a6 §6.1 battery 2): the
// per-key DAILY QUOTA physics of a free-tier key pool, as the upstream
// actually serves it. ~60 lines by design (the a6 spec's estimate) — this is
// a MODEL, not client code: the battery drives the REAL conductorTick/FSM
// against it.
//
//   call(keyIndex) ->
//     { status: 200, keyIndex, headers: { 'X-RateLimit-Remaining': R>0 } }
//   | { status: 429, keyIndex, retryAfterMs, headers: {
//       'X-RateLimit-Remaining': '0', 'X-RateLimit-Limit': Q,
//       'X-RateLimit-Reset': <iso> } }        (after Q calls in the day)
//
//   - per-key counters reset on the virtual DAY boundary (the free-tier
//     "free-models-per-day" window — the X23 shape: the quota is daily,
//     so the remedy is wait-for-reset or fresh keys, never retry-harder);
//   - preSpent: calls consumed before t0 (a pool arriving PRE-EXHAUSTED —
//     the X23 mid-epoch wall: 'all exhausted by t0+3 tasks' is
//     preSpent = keys×quota − 3);
//   - metrics: calls per key, 200s/429s served, first-429 timestamp.
//
// Virtual clock only — no sleeps; Retry-After is RETURNED, never awaited
// (the worker ladder's use of it is the caller's model).

import { DAY } from './common.mjs';

export class PoolLane {
  constructor({ keys, quota, clock, preSpent = 0, dayMs = DAY } = {}) {
    if (!Array.isArray(keys) || !keys.length) throw new Error('PoolLane: keys[] required');
    if (!Number.isInteger(quota) || quota < 1) throw new Error('PoolLane: quota must be a positive integer');
    if (!clock) throw new Error('PoolLane: a virtual clock is required');
    this.keys = keys;
    this.quota = quota;
    this.clock = clock;
    this.dayMs = dayMs;
    this.dayStart = Math.floor(clock.ms / dayMs) * dayMs;
    this.used = new Array(keys.length).fill(0);
    // pre-exhaustion, spread round-robin (the registry-order pool draining
    // under live traffic before t0)
    for (let i = 0; i < preSpent; i++) this.used[i % keys.length] += 1;
    this.preSpent = preSpent;
    this.metrics = { calls: 0, ok200: 0, err429: 0, callsPerKey: new Array(keys.length).fill(0), first429At: null };
  }

  _maybeRollDay() {
    const day = Math.floor(this.clock.ms / this.dayMs) * this.dayMs;
    if (day > this.dayStart) {
      this.dayStart = day;
      this.used = this.used.map(() => 0);   // the daily window resets
      this.dayRollovers = (this.dayRollovers ?? 0) + 1;
    }
  }

  call(keyIndex) {
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= this.keys.length) {
      throw new Error(`PoolLane.call: keyIndex ${keyIndex} out of range (pool ${this.keys.length})`);
    }
    this._maybeRollDay();
    this.metrics.calls += 1;
    this.metrics.callsPerKey[keyIndex] += 1;
    if (this.used[keyIndex] < this.quota) {
      this.used[keyIndex] += 1;
      this.metrics.ok200 += 1;
      return {
        status: 200, keyIndex,
        headers: { 'X-RateLimit-Remaining': String(this.quota - this.used[keyIndex]) },
      };
    }
    this.metrics.err429 += 1;
    if (this.metrics.first429At == null) this.metrics.first429At = this.clock.now();
    const resetMs = this.dayStart + this.dayMs;
    return {
      status: 429, keyIndex,
      retryAfterMs: Math.max(0, resetMs - this.clock.ms),
      headers: {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Limit': String(this.quota),
        'X-RateLimit-Reset': new Date(resetMs).toISOString(),
      },
      body: 'Rate limit exceeded: free-models-per-day (the X23 signature)',
    };
  }
}
