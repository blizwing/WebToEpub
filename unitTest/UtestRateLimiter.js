/*
    Unit tests for RateLimiter
*/
"use strict";

// Mock util.sleep for testing
if (typeof util === 'undefined') {
    window.util = {
        sleep: function(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }
    };
}

QUnit.module("RateLimiter");

QUnit.test("Constructor", function (assert) {
    let limiter = new RateLimiter(3, 100);
    let config = limiter.getConfig();
    assert.equal(config.maxConcurrent, 3);
    assert.equal(config.minDelayBetweenStarts, 100);
    assert.equal(config.activeCount, 0);
    assert.equal(config.waitingQueueLength, 0);
});

QUnit.test("Execute single task", async function (assert) {
    let limiter = new RateLimiter(3, 10);
    let executed = false;

    await limiter.execute(async () => {
        executed = true;
    });

    assert.ok(executed, "Task should be executed");
    assert.equal(limiter.getConfig().activeCount, 0, "Active count should be 0 after completion");
});

QUnit.test("Execute multiple tasks concurrently", async function (assert) {
    let limiter = new RateLimiter(3, 10);
    let executionOrder = [];

    let promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(limiter.execute(async () => {
            executionOrder.push(i);
            await util.sleep(20);
        }));
    }

    await Promise.all(promises);

    assert.equal(executionOrder.length, 5, "All tasks should execute");
});

QUnit.test("Rate limiting delay", async function (assert) {
    let limiter = new RateLimiter(5, 50);
    let startTime = Date.now();
    let firstTaskTime = 0;
    let secondTaskTime = 0;

    let task1 = limiter.execute(async () => {
        firstTaskTime = Date.now();
    });

    let task2 = limiter.execute(async () => {
        secondTaskTime = Date.now();
    });

    await Promise.all([task1, task2]);

    let timeDiff = secondTaskTime - firstTaskTime;
    assert.ok(timeDiff >= 45, "Second task should start at least 45ms after first (with some tolerance)");
});

QUnit.test("SetMaxConcurrent", function (assert) {
    let limiter = new RateLimiter(3, 100);
    limiter.setMaxConcurrent(5);
    assert.equal(limiter.getConfig().maxConcurrent, 5);

    limiter.setMaxConcurrent(0);
    assert.equal(limiter.getConfig().maxConcurrent, 1, "Should not allow maxConcurrent less than 1");
});

QUnit.test("SetMinDelayBetweenStarts", function (assert) {
    let limiter = new RateLimiter(3, 100);
    limiter.setMinDelayBetweenStarts(200);
    assert.equal(limiter.getConfig().minDelayBetweenStarts, 200);

    limiter.setMinDelayBetweenStarts(-50);
    assert.equal(limiter.getConfig().minDelayBetweenStarts, 0, "Should not allow negative delay");
});

QUnit.test("Reset", async function (assert) {
    let limiter = new RateLimiter(3, 10);

    // Start a task but don't await it
    limiter.execute(async () => {
        await util.sleep(100);
    });

    // Give it a moment to start
    await util.sleep(5);

    // Reset should clear the state
    limiter.reset();
    let config = limiter.getConfig();

    assert.equal(config.activeCount, 0, "Active count should be 0 after reset");
    assert.equal(config.waitingQueueLength, 0, "Waiting queue should be empty after reset");
});

QUnit.test("Concurrent limit enforcement", async function (assert) {
    let limiter = new RateLimiter(2, 10);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    let promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(limiter.execute(async () => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await util.sleep(30);
            currentConcurrent--;
        }));
    }

    await Promise.all(promises);

    assert.ok(maxConcurrent <= 2, "Should never exceed max concurrent limit of 2");
});

QUnit.test("Rate limiting prevents too fast downloads", async function (assert) {
    let limiter = new RateLimiter(3, 200); // 200ms minimum delay between starts
    let startTimes = [];

    let promises = [];
    for (let i = 0; i < 4; i++) {
        promises.push(limiter.execute(async () => {
            startTimes.push(Date.now());
            await util.sleep(10);
        }));
    }

    await Promise.all(promises);

    // Check that there's at least 200ms between most task starts
    let minDelaysBetweenStarts = [];
    for (let i = 1; i < startTimes.length; i++) {
        minDelaysBetweenStarts.push(startTimes[i] - startTimes[i-1]);
    }

    // At least some delays should be >= 200ms (with some tolerance for execution)
    let hasProperDelay = minDelaysBetweenStarts.some(delay => delay >= 180);
    assert.ok(hasProperDelay, "Should have at least 180ms+ delay between some task starts (configured 200ms)");
});
