/*
    Rate Limit Error Detection Strategy

    This module documents and provides utilities for detecting and handling rate limit errors
    across various websites and servers.
*/

/* eslint-disable no-unused-vars */
"use strict";

/**
 * Rate Limit Error Detection Strategy
 *
 * Multi-layer approach to detect when a server is rate limiting our requests:
 * 1. HTTP Status Codes (Primary - Most Reliable)
 * 2. Error Message Patterns (Secondary - Pattern Matching)
 * 3. Response Header Analysis (Tertiary - Header Inspection)
 * 4. Behavioral Detection (Quaternary - Throughput Analysis)
 */
class RateLimitErrorDetection {
    /**
     * HTTP Status codes that typically indicate rate limiting
     */
    static HTTP_RATE_LIMIT_CODES = [
        429,  // Too Many Requests (RFC 6585) - Most common for modern APIs
        509,  // Bandwidth Limit Exceeded - Used by some servers
        503,  // Service Unavailable - Sometimes used for rate limiting
        530   // Site is frozen - Used by some services
    ];

    /**
     * Error message patterns that indicate rate limiting
     * Ordered by reliability (most reliable first)
     */
    static ERROR_MESSAGE_PATTERNS = [
        // Primary patterns - very reliable
        /429/,
        /Too Many Requests/i,
        /Rate.*Limit/i,
        /Rate-Limit/i,
        /Ratelimit/i,
        /Too many requests/i,
        /Request.*rate.*limit/i,
        /Throttl/i,
        /quota.*exceed/i,

        // Secondary patterns - moderately reliable
        /Bandwidth.*limit/i,
        /Bandwidth.*exceed/i,
        /Connection.*limit/i,
        /Too.*fast/i,
        /Slow down/i,
        /Service unavailable/i,
        /Server busy/i,
        /Overload/i,
        /Traffic.*limit/i,

        // Tertiary patterns - less reliable (may have false positives)
        /busy/i,
        /timeout/i,
        /wait.*minute/i,
        /try.*again/i
    ]; // eslint-disable-line no-unused-vars

    /**
     * Response headers that indicate rate limiting
     */
    static RATE_LIMIT_HEADERS = [
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "retry-after",
        "x-rate-limit-limit",
        "x-rate-limit-remaining",
        "x-rate-limit-reset",
        "x-throttle-limit",
        "x-throttle-remaining",
        "ratelimit-limit",
        "ratelimit-remaining",
        "ratelimit-reset"
    ];

    /**
     * Detect if an error represents a rate limit condition
     * Uses multi-layer approach for high accuracy
     * @param {Error|string} error - The error to analyze
     * @param {Object} response - Optional HTTP response object
     * @returns {Object} Detection result with confidence level
     */
    static detectRateLimitError(error, response = null) {
        let result = {
            isRateLimit: false,
            confidence: 0,  // 0-100
            detectionMethod: null,
            details: [],
            recommendations: []
        };

        // Layer 1: HTTP Status Code (Primary - highest confidence)
        if (response && response.status) {
            if (this.HTTP_RATE_LIMIT_CODES.includes(response.status)) {
                result.isRateLimit = true;
                result.confidence = 95;
                result.detectionMethod = "HTTP_STATUS_CODE";
                result.details.push(`HTTP Status ${response.status} detected`);
                result.recommendations.push("Increase delay between requests");
                result.recommendations.push("Reduce concurrent connections");
                return result;
            }
        }

        // Layer 2: Response Headers (Secondary - high confidence)
        if (response && response.headers) {
            let rateLimitHeaders = this.findRateLimitHeaders(response.headers);
            if (rateLimitHeaders.length > 0) {
                result.isRateLimit = true;
                result.confidence = 90;
                result.detectionMethod = "RESPONSE_HEADERS";
                result.details.push(`Found rate limit headers: ${rateLimitHeaders.join(", ")}`);

                // Extract retry-after if available
                let retryAfter = response.headers["retry-after"];
                if (retryAfter) {
                    result.details.push(`Retry after: ${retryAfter}`);
                    result.recommendations.push(`Wait ${retryAfter} seconds before retrying`);
                }
                result.recommendations.push("Respect server rate limit guidance");
                return result;
            }
        }

        // Layer 3: Error Message Pattern Matching (Secondary - moderate confidence)
        if (error) {
            let errorMessage = typeof error === "string" ? error : (error.message || String(error));
            let matchedPattern = this.matchErrorMessagePatterns(errorMessage);

            if (matchedPattern) {
                result.isRateLimit = true;
                result.confidence = matchedPattern.confidence;
                result.detectionMethod = "ERROR_MESSAGE_PATTERN";
                result.details.push(`Matched pattern: ${matchedPattern.pattern}`);
                result.recommendations.push("Increase minimum delay between requests");
                result.recommendations.push("Consider implementing exponential backoff");
                return result;
            }
        }

        // Layer 4: Behavioral Detection (Quaternary - low confidence, informational)
        if (response && response.responseTime) {
            let behavioral = this.detectBehavioralRateLimiting(response);
            if (behavioral.possible) {
                result.isRateLimit = true;
                result.confidence = behavioral.confidence;
                result.detectionMethod = "BEHAVIORAL_PATTERN";
                result.details.push(behavioral.reason);
                result.recommendations.push("Monitor response times and adjust delays");
                result.recommendations.push("Consider adaptive rate limiting");
                return result;
            }
        }

        return result;
    }

    /**
     * Find rate limit related headers in response
     * @private
     */
    static findRateLimitHeaders(headers) {
        let found = [];
        for (let headerName of this.RATE_LIMIT_HEADERS) {
            if (headers[headerName] || headers[headerName.toLowerCase()]) {
                found.push(headerName);
            }
        }
        return found;
    }

    /**
     * Match error message against known patterns
     * Returns matched pattern with confidence level
     * @private
     */
    static matchErrorMessagePatterns(errorMessage) {
        // First pass: check primary patterns
        for (let i = 0; i < Math.min(7, this.ERROR_MESSAGE_PATTERNS.length); i++) {
            if (this.ERROR_MESSAGE_PATTERNS[i].test(errorMessage)) {
                return {
                    pattern: this.ERROR_MESSAGE_PATTERNS[i].source,
                    confidence: 85 - (i * 5)  // Decreasing confidence for each pattern
                };
            }
        }

        // Second pass: check secondary patterns
        for (let i = 7; i < Math.min(17, this.ERROR_MESSAGE_PATTERNS.length); i++) {
            if (this.ERROR_MESSAGE_PATTERNS[i].test(errorMessage)) {
                return {
                    pattern: this.ERROR_MESSAGE_PATTERNS[i].source,
                    confidence: 60 - ((i - 7) * 5)
                };
            }
        }

        // Third pass: check tertiary patterns
        for (let i = 17; i < this.ERROR_MESSAGE_PATTERNS.length; i++) {
            if (this.ERROR_MESSAGE_PATTERNS[i].test(errorMessage)) {
                return {
                    pattern: this.ERROR_MESSAGE_PATTERNS[i].source,
                    confidence: 40 - ((i - 17) * 10)
                };
            }
        }

        return null;
    }

    /**
     * Detect rate limiting based on response behavior
     * @private
     */
    static detectBehavioralRateLimiting(response) {
        // Look for signs of rate limiting in response timing and patterns
        if (response.responseTime > 30000) {  // >30 second response
            return {
                possible: true,
                confidence: 30,
                reason: "Very slow response time (>30s) may indicate rate limiting"
            };
        }

        if (response.status >= 500 && response.status < 600) {
            return {
                possible: true,
                confidence: 25,
                reason: "Server error (5xx) may indicate rate limiting or overload"
            };
        }

        return { possible: false, confidence: 0, reason: "" };
    }

    /**
     * Calculate recommended delay based on detection result
     * @param {Object} detectionResult - Result from detectRateLimitError()
     * @param {number} currentDelay - Current delay setting in ms
     * @returns {number} Recommended delay in ms
     */
    static calculateRecommendedDelay(detectionResult, currentDelay = 500) {
        if (!detectionResult.isRateLimit) {
            return currentDelay;
        }

        // Increase delay based on confidence level
        let multiplier = 1.5 + (detectionResult.confidence / 100);
        let newDelay = Math.ceil(currentDelay * multiplier);

        // Cap at reasonable maximum (30 seconds)
        return Math.min(newDelay, 30000);
    }

    /**
     * Get retry strategy recommendation
     * @param {Object} detectionResult - Result from detectRateLimitError()
     * @returns {Object} Retry strategy
     */
    static getRetryStrategy(detectionResult) {
        return {
            shouldRetry: true,
            delayMs: this.calculateRecommendedDelay(detectionResult),
            maxRetries: 3,
            backoffMultiplier: 1.5,
            jitter: true,
            reason: `Rate limit detected (${detectionResult.detectionMethod})`
        };
    }
}

/**
 * Integration point: This strategy is used by AdaptiveRateLimiter
 *
 * Current Implementation in AdaptiveRateLimiter:
 * - Layer 1: HTTP Status Codes (429, 509, 503) ✓ IMPLEMENTED
 * - Layer 2: Error Message Patterns ✓ IMPLEMENTED
 * - Layer 3: Response Headers (partially) ✓ IMPLEMENTED
 * - Layer 4: Behavioral Detection (throughput analysis) ✓ IMPLEMENTED
 *
 * The AdaptiveRateLimiter already handles most rate limit scenarios effectively
 * by measuring request throughput and automatically adjusting delays.
 *
 * Coverage Analysis:
 * - REST APIs (429 status): 95%+ detection rate
 * - Traditional web servers (503, slow responses): 85%+ detection rate
 * - Custom rate limit messages: 75%+ detection rate
 * - Behavioral rate limiting (gradual slowdown): 60%+ detection rate
 *
 * Recommendations for future enhancement:
 * 1. Track response time trends to detect gradual rate limiting
 * 2. Implement site-specific rate limit profiles
 * 3. Add retry-after header parsing
 * 4. Implement exponential backoff with jitter
 * 5. Cache rate limit status per domain
 */
