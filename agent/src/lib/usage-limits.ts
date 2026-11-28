/**
 * Per-user and global spend limits, enforced before a turn starts.
 *
 * - Turns per user per rolling hour (default 20).
 * - Tokens per user per UTC day, and tokens across all users per UTC day.
 *   Tokens are input + output + cache reads + cache writes, the same
 *   "working tokens" the agent loop budgets per turn.
 *
 * State is in memory, which is correct for the single agent task this
 * stack runs (desired_count = 1) and resets on restart. More than one task
 * needs a shared store; that arrives with Postgres in Phase 3. The
 * Anthropic workspace spend cap is the backstop for both.
 */

export interface LimitConfig {
  turnsPerHour: number;
  userTokensPerDay: number;
  globalTokensPerDay: number;
}

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "turns_per_hour" | "user_tokens_per_day" | "global_tokens_per_day"; retryAfterSeconds: number; message: string };

const HOUR_MS = 60 * 60 * 1000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export class UsageLimiter {
  private turns = new Map<string, number[]>();
  private userTokens = new Map<string, { day: string; tokens: number }>();
  private global = { day: "", tokens: 0 };

  constructor(private readonly config: LimitConfig) {}

  /** Checks the limits and, when allowed, counts the turn as started. */
  begin(userId: string, now = Date.now()): LimitDecision {
    const day = utcDay(now);
    if (this.global.day !== day) this.global = { day, tokens: 0 };
    if (this.global.tokens >= this.config.globalTokensPerDay) {
      return {
        allowed: false, reason: "global_tokens_per_day", retryAfterSeconds: secondsUntilNextUtcDay(now),
        message: "The demo has used its model budget for today. Please try again tomorrow.",
      };
    }
    const used = this.userTokens.get(userId);
    if (used && used.day === day && used.tokens >= this.config.userTokensPerDay) {
      return {
        allowed: false, reason: "user_tokens_per_day", retryAfterSeconds: secondsUntilNextUtcDay(now),
        message: "You've used today's token budget. It resets at midnight UTC.",
      };
    }
    const recent = (this.turns.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.config.turnsPerHour) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 1000));
      return {
        allowed: false, reason: "turns_per_hour", retryAfterSeconds,
        message: `You've sent ${this.config.turnsPerHour} questions in the last hour. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
      };
    }
    recent.push(now);
    this.turns.set(userId, recent);
    return { allowed: true };
  }

  /** Records what a finished (or failed) turn actually used. */
  record(userId: string, tokens: number, now = Date.now()): void {
    if (!(tokens > 0)) return;
    const day = utcDay(now);
    const used = this.userTokens.get(userId);
    this.userTokens.set(userId, { day, tokens: (used?.day === day ? used.tokens : 0) + tokens });
    if (this.global.day !== day) this.global = { day, tokens: 0 };
    this.global.tokens += tokens;
  }
}
