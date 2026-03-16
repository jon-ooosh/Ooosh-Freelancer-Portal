/**
 * HireHop Request Broker
 *
 * Centralised gateway for ALL HireHop API communication.
 * - Priority queue (user-initiated = high, background sync = low)
 * - Redis cache with configurable TTL per endpoint type
 * - Token bucket rate limiter (50 req/min, HireHop allows 60)
 * - Request deduplication (same GET within TTL = cache hit)
 * - Write-through for POST/PUT (no cache, still rate-limited)
 *
 * All modules should use this broker instead of calling hireHopGet/Post directly.
 */
import redisClient from '../config/redis';
import { getHireHopConfig, type HireHopResponse } from '../config/hirehop';

// ── Types ────────────────────────────────────────────────────────────────

export type BrokerPriority = 'high' | 'low';

export interface BrokerRequestOptions {
  /** Request priority: 'high' for user-initiated, 'low' for background sync */
  priority?: BrokerPriority;
  /** Cache TTL in seconds. 0 or undefined = use default for endpoint type. -1 = no cache. */
  cacheTTL?: number;
  /** Skip cache lookup (force fresh fetch), but still store result in cache */
  skipCache?: boolean;
}

export interface BrokerBatchRequest {
  endpoint: string;
  params?: Record<string, string | number>;
  options?: BrokerRequestOptions;
}

interface QueuedRequest {
  priority: BrokerPriority;
  execute: () => Promise<void>;
  enqueuedAt: number;
}

// ── Configuration ────────────────────────────────────────────────────────

/** Default cache TTLs by endpoint pattern (seconds) */
const DEFAULT_CACHE_TTLS: Array<{ pattern: RegExp; ttl: number }> = [
  // Static data: contacts, stock lists — 30 min
  { pattern: /\/modules\/contacts\//, ttl: 1800 },
  { pattern: /\/api\/contact_/, ttl: 1800 },
  // Job data — 5 min
  { pattern: /\/api\/job_data/, ttl: 300 },
  { pattern: /\/php_functions\/search_list/, ttl: 300 },
  // Everything else — 2 min
  { pattern: /.*/, ttl: 120 },
];

/** Rate limiter config */
const RATE_LIMIT = {
  maxTokens: 50,          // Max requests per window (HireHop allows 60, we leave 10 headroom)
  windowMs: 60_000,       // 1 minute window
  minDelayMs: 350,        // Min delay between requests (~3/sec max)
};

const CACHE_KEY_PREFIX = 'hh:cache:';
const METRICS_KEY = 'hh:broker:metrics';

// ── Token Bucket Rate Limiter ────────────────────────────────────────────

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private lastRequestTime: number = 0;

  constructor(
    private maxTokens: number,
    private windowMs: number,
    private minDelayMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.windowMs) * this.maxTokens);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();

    // Wait for minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minDelayMs) {
      const waitMs = this.minDelayMs - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // Wait for token availability
    while (this.tokens < 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      this.refill();
    }

    this.tokens--;
    this.lastRequestTime = Date.now();
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

// ── Priority Queue ───────────────────────────────────────────────────────

class PriorityRequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private rateLimiter: TokenBucketRateLimiter;

  constructor() {
    this.rateLimiter = new TokenBucketRateLimiter(
      RATE_LIMIT.maxTokens,
      RATE_LIMIT.windowMs,
      RATE_LIMIT.minDelayMs,
    );
  }

  enqueue(request: QueuedRequest): void {
    this.queue.push(request);
    // Sort: high priority first, then by enqueue time
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority === 'high' ? -1 : 1;
      }
      return a.enqueuedAt - b.enqueuedAt;
    });
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      await this.rateLimiter.acquire();
      try {
        await request.execute();
      } catch (err) {
        console.error('[HH Broker] Request execution error:', err);
      }
    }

    this.processing = false;
  }

  get depth(): number {
    return this.queue.length;
  }

  get availableTokens(): number {
    return this.rateLimiter.availableTokens;
  }
}

// ── Cache Helpers ────────────────────────────────────────────────────────

function getCacheKey(endpoint: string, params: Record<string, string | number>): string {
  // Sort params for consistent cache keys
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'token') // Never include token in cache key
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return `${CACHE_KEY_PREFIX}${endpoint}?${sortedParams}`;
}

function getDefaultTTL(endpoint: string): number {
  for (const rule of DEFAULT_CACHE_TTLS) {
    if (rule.pattern.test(endpoint)) {
      return rule.ttl;
    }
  }
  return 120;
}

// ── Metrics ──────────────────────────────────────────────────────────────

interface BrokerMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  lastRequestAt: string | null;
}

// ── HireHop Broker ───────────────────────────────────────────────────────

class HireHopBroker {
  private queue = new PriorityRequestQueue();
  private metrics: BrokerMetrics = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    errors: 0,
    lastRequestAt: null,
  };

  /**
   * Make a GET request to HireHop API with caching and rate limiting.
   */
  async get<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
    options: BrokerRequestOptions = {},
  ): Promise<HireHopResponse<T>> {
    const priority = options.priority || 'low';
    const cacheTTL = options.cacheTTL ?? getDefaultTTL(endpoint);

    this.metrics.totalRequests++;

    // Check cache first (unless skipCache or TTL is -1)
    if (!options.skipCache && cacheTTL > 0) {
      const cached = await this.getFromCache<T>(endpoint, params);
      if (cached) {
        this.metrics.cacheHits++;
        return cached;
      }
    }

    this.metrics.cacheMisses++;

    // Enqueue the actual request
    return new Promise<HireHopResponse<T>>((resolve) => {
      this.queue.enqueue({
        priority,
        enqueuedAt: Date.now(),
        execute: async () => {
          try {
            const result = await this.executeGet<T>(endpoint, params);
            this.metrics.lastRequestAt = new Date().toISOString();

            // Cache successful responses
            if (result.success && cacheTTL > 0) {
              await this.setCache(endpoint, params, result, cacheTTL);
            }

            resolve(result);
          } catch (err) {
            this.metrics.errors++;
            console.error(`[HH Broker] GET ${endpoint} failed:`, err);
            resolve({ success: false, error: String(err) });
          }
        },
      });
    });
  }

  /**
   * Make a POST request to HireHop API (no caching, still rate-limited).
   */
  async post<T = unknown>(
    endpoint: string,
    body: Record<string, unknown> = {},
    options: BrokerRequestOptions = {},
  ): Promise<HireHopResponse<T>> {
    const priority = options.priority || 'low';

    this.metrics.totalRequests++;
    this.metrics.cacheMisses++; // POSTs always miss cache

    return new Promise<HireHopResponse<T>>((resolve) => {
      this.queue.enqueue({
        priority,
        enqueuedAt: Date.now(),
        execute: async () => {
          try {
            const result = await this.executePost<T>(endpoint, body);
            this.metrics.lastRequestAt = new Date().toISOString();
            resolve(result);
          } catch (err) {
            this.metrics.errors++;
            console.error(`[HH Broker] POST ${endpoint} failed:`, err);
            resolve({ success: false, error: String(err) });
          }
        },
      });
    });
  }

  /**
   * Execute a batch of GET requests sequentially with rate limiting.
   */
  async batch<T = unknown>(
    requests: BrokerBatchRequest[],
    options?: { delayMs?: number },
  ): Promise<HireHopResponse<T>[]> {
    const results: HireHopResponse<T>[] = [];
    const delayMs = options?.delayMs;

    for (const req of requests) {
      const result = await this.get<T>(req.endpoint, req.params, req.options);
      results.push(result);
      if (delayMs && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }

  /**
   * Get current broker metrics.
   */
  getMetrics(): BrokerMetrics & { queueDepth: number; availableTokens: number; cacheHitRate: string } {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    const hitRate = total > 0 ? ((this.metrics.cacheHits / total) * 100).toFixed(1) : '0.0';
    return {
      ...this.metrics,
      queueDepth: this.queue.depth,
      availableTokens: this.queue.availableTokens,
      cacheHitRate: `${hitRate}%`,
    };
  }

  /**
   * Persist metrics to Redis (called periodically or on demand).
   */
  async persistMetrics(): Promise<void> {
    try {
      if (redisClient.isOpen) {
        await redisClient.set(METRICS_KEY, JSON.stringify(this.getMetrics()), { EX: 3600 });
      }
    } catch {
      // Non-critical — silently ignore
    }
  }

  /**
   * Invalidate cache for a specific endpoint + params combination.
   */
  async invalidateCache(endpoint: string, params: Record<string, string | number> = {}): Promise<void> {
    try {
      if (redisClient.isOpen) {
        const key = getCacheKey(endpoint, params);
        await redisClient.del(key);
      }
    } catch {
      // Non-critical
    }
  }

  // ── Private Methods ──────────────────────────────────────────────────

  private async getFromCache<T>(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<HireHopResponse<T> | null> {
    try {
      if (!redisClient.isOpen) return null;
      const key = getCacheKey(endpoint, params);
      const cached = await redisClient.get(key);
      if (cached) {
        return JSON.parse(cached) as HireHopResponse<T>;
      }
    } catch {
      // Cache miss on error
    }
    return null;
  }

  private async setCache<T>(
    endpoint: string,
    params: Record<string, string | number>,
    data: HireHopResponse<T>,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      if (!redisClient.isOpen) return;
      const key = getCacheKey(endpoint, params);
      await redisClient.set(key, JSON.stringify(data), { EX: ttlSeconds });
    } catch {
      // Non-critical
    }
  }

  private async executeGet<T>(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<HireHopResponse<T>> {
    const { token, domain } = getHireHopConfig();

    const url = new URL(`https://${domain}${endpoint}`);
    url.searchParams.set('token', token);
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, String(val));
    }

    const response = await fetch(url.toString());
    return this.parseResponse<T>(response);
  }

  private async executePost<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<HireHopResponse<T>> {
    const { token, domain } = getHireHopConfig();

    const url = `https://${domain}${endpoint}?token=${encodeURIComponent(token)}`;

    const formData = new URLSearchParams();
    for (const [key, val] of Object.entries(body)) {
      if (val !== undefined && val !== null) {
        formData.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<HireHopResponse<T>> {
    const text = await response.text();

    // HTML response = auth failure
    if (text.trim().startsWith('<')) {
      return { success: false, error: 'Authentication failed — check API token', isAuthError: true };
    }

    // Rate limited
    if (response.status === 429) {
      return { success: false, error: 'Rate limited — max 60 requests/minute' };
    }

    try {
      const data = JSON.parse(text);
      if (data.error) {
        return { success: false, error: String(data.error) };
      }
      return { success: true, data: data as T };
    } catch {
      console.error('[HH Broker] Failed to parse response:', text.substring(0, 200));
      return { success: false, error: 'Invalid response format' };
    }
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────

export const hhBroker = new HireHopBroker();
export default hhBroker;
