// stress/lib/parallel-cap.mjs — the GHA repo-wide 5-parallel-run cap, modeled
// (T7 from the a6 audit, stress-local per the s21-c2 brief: c1 hasn't landed
// it in gha-shim, so the battery owns its own minimal version — when c1's
// lands in sim/gha-shim.mjs this module should be deleted in favor of the ONE
// source; the semantics here are deliberately identical to the design's
// wording: "slots, queue-when-full, starvation counter").
//
// MODEL (the live physics the X21 burst and the AR overflow decision depend
// on — previously modeled NOWHERE, which made the overflow trigger
// conditions unfalsifiable offline):
//   - a repo has N parallel run slots (live: 5, the free-tier GHA cap).
//   - a submit while slots are free STARTS immediately; a submit when full
//     joins a FIFO queue (GHA's documented behavior: queued jobs are admitted
//     in submit order, no priority — the conductor's self-tick has NO lane
//     privilege over worker runs; that is exactly the starvation surface).
//   - runs complete at startedAt + durationMs on tick().
//   - the STARVATION COUNTER: a "starved window" is a watch window (the
//     caller picks the period — the compressed backstop) in which a named
//     workflow (the conductor) submitted ≥1 run AND completed ZERO runs of
//     that name. Consecutive starved windows is the metric the burst battery
//     bounds (the audit's assert: the backstop never starves > K ticks under
//     worker saturation).
//
// All on the injected virtual clock — the battery never sleeps.
export class ParallelCap {
  constructor({ slots = 5, clock, windowMs = 600_000, watch = 'conductor' } = {}) {
    if (!clock) throw new Error('ParallelCap: a virtual clock is required ({ now, advance, advanceTo, ms })');
    this.slots = slots;
    this.clock = clock;
    this.windowMs = windowMs;
    this.watch = watch;
    this.running = [];     // [{name, startedAt, durationMs, ...runSpec}]
    this.queue = [];       // FIFO [{name, enqueuedAt, ...runSpec}]
    this.completed = [];   // audit + metrics
    this._events = [];     // started transitions drained by tick()
    // metrics
    this.queueDepthSamples = [];
    this.waits = [];       // {name, waitMs} — every promotion's queue wait
    // starvation bookkeeping (the watch-name's consecutive starved windows):
    // a window is STARVED when the watch-name's run SAT IN THE QUEUE at any
    // point inside the window AND no watch-name run completed in it. (The
    // naive submit-time check misses waits that SPAN a window boundary —
    // exactly the long-grind starvation the counter exists to catch.)
    this.starvedWindows = 0;
    this.maxConsecutiveStarved = 0;
    this._windowStart = clock.ms;
    this._queuedInWindow = false;
  }

  submit(runSpec = {}) {
    const run = {
      id: runSpec.id ?? `cap-run-${this.completed.length + this.running.length + this.queue.length + 1}`,
      name: runSpec.name ?? 'run',
      durationMs: runSpec.durationMs ?? 60_000,
      ...runSpec,
      startedAt: null,
      enqueuedAt: this.clock.ms,
    };
    if (run.name === this.watch && this.queue.length) this._queuedInWindow = true;
    if (this.running.length < this.slots) {
      this._start(run);
      this._events.push({ type: 'started', run });
      return 'started';
    }
    this.queue.push(run);
    return 'queued';
  }

  _start(run) {
    run.startedAt = this.clock.ms;
    this.running.push(run);
  }

  tick() {
    const t = this.clock.ms;
    const events = this._events;
    this._events = [];
    // completions first (free the slots), then FIFO promotions
    for (const run of this.running) {
      if (run.startedAt != null && t >= run.startedAt + run.durationMs) {
        run.completedAt = t;
        this.completed.push(run);
        events.push({ type: 'completed', run });
      }
    }
    this.running = this.running.filter(r => !r.completedAt);
    while (this.queue.length && this.running.length < this.slots) {
      const run = this.queue.shift();
      run.waitMs = t - run.enqueuedAt;
      this.waits.push({ name: run.name, waitMs: run.waitMs, at: t });
      this._start(run);
      events.push({ type: 'started', run });
    }
    // the starvation window bookkeeping — evaluated on every tick() (the
    // driver's advance granularity is the sampling granularity): a queued
    // watch-name run marks the window; a completed watch-name run un-stars it.
    if (this.queue.some(r => r.name === this.watch)) this._queuedInWindow = true;
    while (t - this._windowStart >= this.windowMs) {
      this._windowStart += this.windowMs;
      const completedThisWindow = this.completed.some(r =>
        r.name === this.watch && r.completedAt > t - this.windowMs);
      if (this._queuedInWindow && !completedThisWindow) {
        this.starvedWindows += 1;
        this.maxConsecutiveStarved = Math.max(this.maxConsecutiveStarved, this.starvedWindows);
      } else {
        this.starvedWindows = 0;
      }
      this._queuedInWindow = false;
    }
    this.queueDepthSamples.push(this.queue.length);
    return events;
  }

  nextTickAt() {
    const cands = [];
    for (const r of this.running) cands.push(r.startedAt + r.durationMs);
    if (this.queue.length) cands.push(this._windowStart + this.windowMs);
    return cands.length ? Math.min(...cands) : null;
  }

  waitHistogram(name) {
    const ws = this.waits.filter(w => w.name === name).map(w => w.waitMs).sort((a, b) => a - b);
    if (!ws.length) return { n: 0, p50: 0, p95: 0, max: 0 };
    const pick = (q) => ws[Math.min(ws.length - 1, Math.floor(q * ws.length))];
    return { n: ws.length, p50: pick(0.5), p95: pick(0.95), max: ws[ws.length - 1] };
  }
}
