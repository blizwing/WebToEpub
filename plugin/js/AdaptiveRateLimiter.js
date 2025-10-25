/*
    Adaptive Rate Limiter that measures throughput when rate limit is hit,
    then automatically adjusts delay to avoid future rate limits
*/

"use strict";

class AdaptiveRateLimiter {
    constructor(initialMaxConcurrent = 3, initialMinDelay = 500) {
        this.rateLimiter = new RateLimiter(initialMaxConcurrent, initialMinDelay);

        // Tracking metrics during download
        this.requestCount = 0;
        this.firstRequestTime = 0;
        this.rateLimitHitTime = 0;
        this.rateLimitHit = false;
        this.requestTimestamps = [];

        // Configuration
        this.safetyFactor = 1.5; // Multiply calculated delay by this to be safe
        this.minDelayFloor = 100; // Don't go below this delay (in ms)
    }

    /**
     * Execute a task with adaptive rate limiting
     * Tracks request metrics and adjusts rate limit if 429 is encountered
     * @param {Function} task - Async function to execute
     * @param {string} url - URL being requested (for debugging)
     * @returns {Promise} - Result of the task
     */
    async execute(task, url = "") {
        if (this.firstRequestTime === 0) {
            this.firstRequestTime = Date.now();
        }

        this.requestCount++;
        const requestTimestamp = Date.now();
        this.requestTimestamps.push(requestTimestamp);

        // Check if we've recovered from rate limit
        if (this.rateLimitHit && this.rateLimitHitTime > 0) {
            const timeSinceLimit = Date.now() - this.rateLimitHitTime;
            // If enough time has passed, try to reset and resume at normal speed
            if (timeSinceLimit > 60000) { // 60 seconds without hitting limit
                console.log("Adaptive Rate Limiter: Recovered from rate limit. Resuming at adjusted speed.");
                this.rateLimitHit = false;
            }
        }

        try {
            // Execute the actual task using the rate limiter
            const result = await this.rateLimiter.execute(task);
            return result;
        } catch (error) {
            // Check if this is a rate limit error (429, 509, 503, etc.)
            if (this.isRateLimitError(error)) {
                await this.handleRateLimitError(url, this.requestCount - 1);
            }
            throw error;
        }
    }

    /**
     * Check if an error is a rate limit error
     * @param {Error} error - The error to check
     * @returns {boolean} - True if it's a rate limit error
     */
    isRateLimitError(error) {
        if (!error || !error.message) return false;

        const statusPatterns = [
            /429/,  // Too Many Requests
            /509/,  // Bandwidth Limit Exceeded
            /503/,  // Service Unavailable
            /Too Many Requests/i,
            /Rate limit/i,
            /Rate-limit/i,
            /Ratelimit/i,
            /bandwidth/i
        ];

        return statusPatterns.some(pattern => pattern.test(error.message));
    }

    /**
     * Handle rate limit error by measuring throughput and adjusting delay
     * @param {string} url - URL where rate limit was hit
     * @param {number} successfulRequests - Number of successful requests before hitting limit
     * @private
     */
    async handleRateLimitError(url, successfulRequests) {
        if (this.rateLimitHit) {
            // Already handling a rate limit, don't recalculate
            return;
        }

        this.rateLimitHit = true;
        this.rateLimitHitTime = Date.now();

        // Calculate metrics
        const totalTimeMs = this.rateLimitHitTime - this.firstRequestTime;

        if (successfulRequests <= 0 || totalTimeMs <= 0) {
            console.warn("Adaptive Rate Limiter: Insufficient data for rate limit calculation");
            return;
        }

        // Calculate the optimal delay based on measured throughput
        const avgTimePerRequest = totalTimeMs / successfulRequests;
        const calculatedDelay = Math.ceil(avgTimePerRequest * this.safetyFactor);
        const newDelay = Math.max(this.minDelayFloor, calculatedDelay);

        console.log(
            `Adaptive Rate Limiter: Rate limit hit at URL: ${url}\n` +
            `  Successful requests before limit: ${successfulRequests}\n` +
            `  Time elapsed: ${totalTimeMs}ms\n` +
            `  Average time per request: ${avgTimePerRequest.toFixed(2)}ms\n` +
            `  Calculated delay (with ${this.safetyFactor}x safety factor): ${calculatedDelay}ms\n` +
            `  New delay setting: ${newDelay}ms`
        );

        // Adjust the rate limiter with the new delay
        this.rateLimiter.setMinDelayBetweenStarts(newDelay);

        // Reset tracking for the next batch
        this.requestCount = 0;
        this.firstRequestTime = Date.now();
        this.requestTimestamps = [];
    }

    /**
     * Update max concurrent tasks
     * @param {number} maxConcurrent - New max concurrent limit
     */
    setMaxConcurrent(maxConcurrent) {
        this.rateLimiter.setMaxConcurrent(maxConcurrent);
    }

    /**
     * Update minimum delay between starts
     * @param {number} minDelay - New minimum delay in milliseconds
     */
    setMinDelayBetweenStarts(minDelay) {
        this.rateLimiter.setMinDelayBetweenStarts(minDelay);
    }

    /**
     * Get current configuration and metrics
     * @returns {Object} Current state
     */
    getConfig() {
        return {
            ...this.rateLimiter.getConfig(),
            requestCount: this.requestCount,
            rateLimitHit: this.rateLimitHit,
            totalElapsedTime: Date.now() - this.firstRequestTime
        };
    }

    /**
     * Reset the adaptive rate limiter
     */
    reset() {
        this.rateLimiter.reset();
        this.requestCount = 0;
        this.firstRequestTime = 0;
        this.rateLimitHitTime = 0;
        this.rateLimitHit = false;
        this.requestTimestamps = [];
    }

    /**
     * Get the underlying RateLimiter for advanced usage
     * @returns {RateLimiter}
     */
    getRateLimiter() {
        return this.rateLimiter;
    }
}
