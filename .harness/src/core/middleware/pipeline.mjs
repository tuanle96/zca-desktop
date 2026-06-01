/**
 * @typedef {(input: any) => Promise<any>} ProviderExecutor
 * @typedef {(next: ProviderExecutor) => ProviderExecutor} ProviderMiddleware
 */

/**
 * Compose middleware around a provider executor. Middleware are applied in
 * declaration order, Koa-style: the first middleware is the outer wrapper.
 *
 * @param {ProviderExecutor} base
 * @param {ProviderMiddleware[]} [middleware]
 * @returns {ProviderExecutor}
 */
export function composeMiddleware(base, middleware = []) {
  return middleware.reduceRight((next, mw) => mw(next), base);
}

/**
 * Retry transient provider failures.
 * @returns {ProviderMiddleware}
 */
export function withRetry({ attempts = 2, shouldRetry = () => true } = {}) {
  return next => async input => {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try { return await next(input); }
      catch (error) {
        lastError = error;
        if (!shouldRetry(error, i + 1) || i === attempts - 1) throw error;
      }
    }
    throw lastError;
  };
}

/**
 * Cache deterministic provider calls by a caller-supplied key.
 * @returns {ProviderMiddleware}
 */
export function withCaching({ key = input => JSON.stringify(input), cache = new Map() } = {}) {
  return next => async input => {
    const k = key(input);
    if (cache.has(k)) return cache.get(k);
    const value = await next(input);
    cache.set(k, value);
    return value;
  };
}

/**
 * Bound provider call duration.
 * @returns {ProviderMiddleware}
 */
export function withTimeout({ ms = 30000 } = {}) {
  return next => async input => Promise.race([
    next(input),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`middleware timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Emit a success/failure event after each provider call.
 * @returns {ProviderMiddleware}
 */
export function withTelemetry({ sink = () => {}, event = 'middleware_call' } = {}) {
  return next => async input => {
    const start = Date.now();
    try {
      const output = await next(input);
      sink({ event, ok: true, duration_ms: Date.now() - start });
      return output;
    } catch (error) {
      sink({ event, ok: false, duration_ms: Date.now() - start, error: error.message });
      throw error;
    }
  };
}

/**
 * Reject provider inputs whose estimated prompt size exceeds the configured
 * token budget.
 * @returns {ProviderMiddleware}
 */
export function withBudget({ maxInputTokens = Infinity, estimate = input => String(input?.prompt ?? input ?? '').length / 4 } = {}) {
  return next => async input => {
    const estimatedTokens = Math.ceil(estimate(input));
    if (estimatedTokens > maxInputTokens) throw new Error(`budget exceeded: ${estimatedTokens} > ${maxInputTokens}`);
    return next(input);
  };
}
