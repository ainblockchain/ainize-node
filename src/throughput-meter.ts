/**
 * How fast a model actually generates, measured from the calls it served.
 *
 * The node used to know one number, `OPENAI_TOKENS_PER_SECOND = 20`, chosen rather than measured. A page that
 * tells somebody "you get N tokens a second, deposit X and you get M" needs the real rate, so every successful
 * chat reports its completion tokens and wall time here and the rate is their ratio over a recent window.
 *
 * Sums, not an average of per-call rates: a 5-token answer that took 400 ms is mostly latency, and averaging it
 * equally with a 900-token answer would report a speed the model never ran at. Tiny calls are skipped outright.
 */

export interface ThroughputRate {
  tokPerSec: number;
  samples: number;
  windowMs: number;
}

interface ThroughputSample { at: number; tokens: number; ms: number }

export const THROUGHPUT_WINDOW_MS = 30 * 60_000;
const THROUGHPUT_MAX_SAMPLES = 200;
const THROUGHPUT_MIN_TOKENS = 8;
const THROUGHPUT_MIN_MS = 100;

export class ThroughputMeter {
  private readonly byModel = new Map<string, ThroughputSample[]>();

  constructor(private readonly now: () => number = Date.now, private readonly windowMs = THROUGHPUT_WINDOW_MS) {}

  record(model: string, completionTokens: number, latencyMs: number): void {
    if (!model || !(completionTokens >= THROUGHPUT_MIN_TOKENS) || !(latencyMs >= THROUGHPUT_MIN_MS)) return;
    const list = this.byModel.get(model) ?? [];
    list.push({ at: this.now(), tokens: completionTokens, ms: latencyMs });
    if (list.length > THROUGHPUT_MAX_SAMPLES) list.splice(0, list.length - THROUGHPUT_MAX_SAMPLES);
    this.byModel.set(model, list);
  }

  /** The model's recent rate, or null when it served nothing measurable within the window. */
  rateOf(model: string): ThroughputRate | null {
    return this.rateOver(this.byModel.get(model) ?? []);
  }

  /**
   * Every model together. For a node whose runtime reports its model under a different name than the one it is
   * listed by (a served alias), this is still the one model's rate; with several models it is a blend.
   */
  overall(): ThroughputRate | null {
    return this.rateOver([...this.byModel.values()].flat());
  }

  private rateOver(samples: ThroughputSample[]): ThroughputRate | null {
    const cutoff = this.now() - this.windowMs;
    const recent = samples.filter((s) => s.at >= cutoff);
    if (!recent.length) return null;
    const tokens = recent.reduce((n, s) => n + s.tokens, 0);
    const ms = recent.reduce((n, s) => n + s.ms, 0);
    return { tokPerSec: tokens / (ms / 1000), samples: recent.length, windowMs: this.windowMs };
  }
}
