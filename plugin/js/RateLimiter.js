/*
    Rate Limiter for managing parallel chapter downloads with rate limiting
*/

"use strict";

class RateLimiter {
    constructor(maxConcurrent = 3, minDelayBetweenStarts = 500) {
        this.maxConcurrent = maxConcurrent;
        this.minDelayBetweenStarts = minDelayBetweenStarts;
        this.activeCount = 0;
        this.waitingQueue = [];
        this.lastStartTime = 0;
    }

    /**
     * Execute a task with rate limiting
     * Enforces both concurrent limit and minimum delay between task starts
     * @param {Function} task - Async function to execute
     * @returns {Promise} - Result of the task
     */
    async execute(task) {
        // Wait for an available slot and rate limit delay
        await this.waitForSlotAndRateLimit();

        this.activeCount++;
        this.lastStartTime = Date.now();

        try {
            const result = await task();
            return result;
        } finally {
            this.activeCount--;
            this.processWaitingQueue();
        }
    }

    /**
     * Wait for both an available execution slot AND rate limit delay
     * This ensures we never exceed maxConcurrent AND always respect the minimum delay
     * @returns {Promise<void>}
     */
    async waitForSlotAndRateLimit() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Check if we can start a new task
            if (this.activeCount < this.maxConcurrent) {
                // Calculate how long to wait for rate limiting
                const waitTime = this.calculateRateLimitDelay();
                if (waitTime > 0) {
                    await util.sleep(waitTime);
                }
                return; // Can proceed with execution
            }

            // No slots available - wait for a slot to become available
            await new Promise((resolve) => {
                this.waitingQueue.push(resolve);
            });
        }
    }

    /**
     * Calculate how long to wait before starting the next task
     * @returns {number} Milliseconds to wait (0 if no wait needed)
     */
    calculateRateLimitDelay() {
        if (this.lastStartTime === 0) {
            return 0; // First task, no delay needed
        }

        const timeSinceLastStart = Date.now() - this.lastStartTime;
        const remainingDelay = this.minDelayBetweenStarts - timeSinceLastStart;

        return Math.max(0, remainingDelay);
    }

    /**
     * Process the next item in waiting queue if there's capacity
     */
    processWaitingQueue() {
        if (this.waitingQueue.length > 0 && this.activeCount < this.maxConcurrent) {
            const resolve = this.waitingQueue.shift();
            resolve();
        }
    }

    /**
     * Update concurrency limit
     * @param {number} maxConcurrent - New max concurrent tasks
     */
    setMaxConcurrent(maxConcurrent) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        // Process waiting queue in case new slots are available
        while (this.waitingQueue.length > 0 && this.activeCount < this.maxConcurrent) {
            this.processWaitingQueue();
        }
    }

    /**
     * Update minimum delay between starts
     * @param {number} minDelay - New minimum delay in milliseconds
     */
    setMinDelayBetweenStarts(minDelay) {
        this.minDelayBetweenStarts = Math.max(0, minDelay);
    }

    /**
     * Get current configuration
     * @returns {Object} Current rate limiter configuration
     */
    getConfig() {
        return {
            maxConcurrent: this.maxConcurrent,
            minDelayBetweenStarts: this.minDelayBetweenStarts,
            activeCount: this.activeCount,
            waitingQueueLength: this.waitingQueue.length
        };
    }

    /**
     * Reset the rate limiter state
     */
    reset() {
        this.activeCount = 0;
        this.waitingQueue = [];
        this.lastStartTime = 0;
    }
}
