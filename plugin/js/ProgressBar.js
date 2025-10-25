
"use strict";

/**
   Code to manipulate the Progress Bar on the UI
*/
class ProgressBar { // eslint-disable-line no-unused-vars
    constructor() {
    }

    static getUiElement() {
        return document.getElementById("fetchProgress");
    }

    static setValue(value) {
        ProgressBar.getUiElement().value = value;
        ProgressBar.updateText();
        ProgressBar.updateTimeInfo();
    }

    static updateValue(increment) {
        ProgressBar.getUiElement().value += increment;
        ProgressBar.updateText();
        ProgressBar.updateTimeInfo();
    }

    static setMax(max) {
        ProgressBar.getUiElement().max = max;
        ProgressBar.updateText();
        ProgressBar.updateTimeInfo();
    }

    static updateText() {
        let element = ProgressBar.getUiElement();
        let text = "";
        if (1 < element.max) {
            text = `${element.value}/${element.max}`;
            ProgressBar.updateTabTitle(element.value, element.max);
        }
        // Add failed images count if available
        if (ProgressBar.failedImageCount && ProgressBar.failedImageCount > 0) {
            text += ` (${ProgressBar.failedImageCount} images failed)`;
        }
        document.getElementById("progressString").textContent = text;
    }

    static updateTabTitle(value, max) {
        value = (value*100/max).toFixed(1);
        if (value == "100.0") {
            value = "100";
        }
        document.title = value + "% WebToEpub";
    }

    // Timer tracking for elapsed time and ETA
    static startTimer() {
        ProgressBar.startTime = Date.now();
        ProgressBar.lastUpdateTime = ProgressBar.startTime;

        // Update timer display every second
        if (ProgressBar.timerInterval) {
            clearInterval(ProgressBar.timerInterval);
        }
        ProgressBar.timerInterval = setInterval(() => {
            ProgressBar.updateTimeInfo();
        }, 1000);
    }

    static stopTimer() {
        if (ProgressBar.timerInterval) {
            clearInterval(ProgressBar.timerInterval);
            ProgressBar.timerInterval = null;
        }
        // Clear time displays
        let elapsedElement = document.getElementById("elapsedTime");
        let etaElement = document.getElementById("etaTime");
        if (elapsedElement) {
            elapsedElement.textContent = "";
        }
        if (etaElement) {
            etaElement.textContent = "";
        }
    }

    /**
     * Update failed image count display
     * @param {number} count Number of failed images
     */
    static setFailedImageCount(count) {
        ProgressBar.failedImageCount = count;
        ProgressBar.updateText();
    }

    /**
     * Get current failed image count
     * @returns {number} Number of failed images
     */
    static getFailedImageCount() {
        return ProgressBar.failedImageCount || 0;
    }

    static formatTime(milliseconds) {
        let totalSeconds = Math.floor(milliseconds / 1000);
        let hours = Math.floor(totalSeconds / 3600);
        let minutes = Math.floor((totalSeconds % 3600) / 60);
        let seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    static updateTimeInfo() {
        if (!ProgressBar.startTime) {
            return;
        }

        let element = ProgressBar.getUiElement();
        let elapsedElement = document.getElementById("elapsedTime");
        let etaElement = document.getElementById("etaTime");

        if (!elapsedElement || !etaElement) {
            return;
        }

        let now = Date.now();
        let elapsed = now - ProgressBar.startTime;
        let currentValue = element.value;
        let maxValue = element.max;

        // Update elapsed time
        elapsedElement.textContent = `Elapsed: ${ProgressBar.formatTime(elapsed)}`;

        // Calculate and update ETA
        if (currentValue > 0 && currentValue < maxValue) {
            let progress = currentValue / maxValue;
            let estimatedTotal = elapsed / progress;
            let remaining = estimatedTotal - elapsed;

            // Only show ETA if we have reasonable data (at least 2 seconds elapsed and >1% progress)
            if (elapsed > 2000 && progress > 0.01) {
                etaElement.textContent = `ETA: ${ProgressBar.formatTime(remaining)}`;
            } else {
                etaElement.textContent = "ETA: Calculating...";
            }
        } else if (currentValue >= maxValue && maxValue > 1) {
            // Completed
            etaElement.textContent = "Completed!";
            ProgressBar.stopTimer();
        } else {
            etaElement.textContent = "";
        }
    }
}

// Initialize timer state
ProgressBar.startTime = null;
ProgressBar.lastUpdateTime = null;
ProgressBar.timerInterval = null;
ProgressBar.failedImageCount = 0;
