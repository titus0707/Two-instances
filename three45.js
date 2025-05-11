const WebSocket = require('ws');
const fs = require('fs');

class DerivTickAnalyzer {
    constructor() {
        this.ws = null;
        this.app_id = "1089"; // Replace with your app ID
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your API token
        this.symbol = "R_75"; // Fixed symbol
        this.tickCount = 5000; // Number of ticks to fetch
        this.digitHistory = [];
        this.logFile = 'tick_pattern_analysis_5th_digit.log';

        fs.writeFileSync(this.logFile, `Analysis of ${this.tickCount} ticks for ${this.symbol} - 3-digit (4/5) sequences with 5th digit outcome - Started ${new Date().toLocaleString()}\n\n`, 'utf8');

        this.log(`Starting Deriv Tick Analyzer`);
        this.log(`Fetching ${this.tickCount} ticks for ${this.symbol}`);
        this.run();
    }

    log(message, toFile = false) {
        const timestamp = new Date().toLocaleString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        if (toFile) {
            fs.appendFileSync(this.logFile, `${logMessage}\n`, 'utf8');
        }
    }

    async run() {
        await this.connect();
        await this.fetchHistory();
        this.analyzeTicks();
        this.ws.close();
    }

    connect() {
        return new Promise((resolve) => {
            this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
            this.ws.on('open', () => {
                this.authenticate();
                resolve();
            });
            this.ws.on('message', (data) => this.handleMessage(data));
            this.ws.on('close', () => this.log("WebSocket connection closed"));
            this.ws.on('error', (error) => this.log(`WebSocket error: ${error.message}`));
        });
    }

    authenticate() {
        this.ws.send(JSON.stringify({ authorize: this.api_token }));
    }

    async fetchHistory() {
        return new Promise((resolve) => {
            this.historyResolve = resolve;
            this.ws.send(JSON.stringify({
                ticks_history: this.symbol,
                count: this.tickCount,
                end: "latest",
                style: "ticks"
            }));
        });
    }

    handleMessage(data) {
        const response = JSON.parse(data);
        switch (response.msg_type) {
            case "authorize":
                this.log("Authorized successfully");
                break;
            case "history":
                if (this.historyResolve) {
                    const digits = response.history.prices.map(price => {
                        const priceStr = String(price).replace(/[^0-9]/g, '');
                        return parseInt(priceStr.slice(-1));
                    });
                    this.digitHistory = digits;
                    this.log(`Fetched ${digits.length} ticks`);
                    this.historyResolve();
                    this.historyResolve = null;
                }
                break;
            case "error":
                this.log(`API Error: ${response.error.message}`);
                break;
        }
    }

    analyzeTicks() {
        if (this.digitHistory.length < 5) { // Adjusted to 5 since we need the 5th digit
            this.log("Not enough tick data to analyze (need at least 5 ticks)");
            return;
        }

        let sequencesFound = 0;
        const outcomes = [];
        const winStreaks = {};
        const lossStreaks = {};
        let currentWinStreak = 0;
        let currentLossStreak = 0;

        this.log("Detailed analysis of 3-digit (4/5) sequences with 5th digit outcome:", true);

        for (let i = 0; i < this.digitHistory.length - 4; i++) { // Adjusted to -4 for 5 digits
            const first = this.digitHistory[i];
            const second = this.digitHistory[i + 1];
            const third = this.digitHistory[i + 2];
            const fifth = this.digitHistory[i + 4]; // Use 5th digit instead of 4th

            // Check if first 3 digits are 4 or 5
            if ((first === 4 || first === 5) &&
                (second === 4 || second === 5) &&
                (third === 4 || third === 5)) {
                sequencesFound++;
                const sequence = `${first}${second}${third}`;
                const outcome = (fifth === 4 || fifth === 5) ? "Lost" : "Won"; // Outcome based on 5th digit
                outcomes.push(outcome);
                this.log(`Sequence ${sequence} at position ${i}-${i+2}, 5th digit ${fifth}: ${outcome}`, true);

                // Track consecutive wins and losses
                if (outcome === "Won") {
                    currentWinStreak++;
                    if (currentLossStreak > 0) {
                        lossStreaks[currentLossStreak] = (lossStreaks[currentLossStreak] || 0) + 1;
                        currentLossStreak = 0;
                    }
                } else { // Lost
                    currentLossStreak++;
                    if (currentWinStreak > 0) {
                        winStreaks[currentWinStreak] = (winStreaks[currentWinStreak] || 0) + 1;
                        currentWinStreak = 0;
                    }
                }
            }
        }

        // Record the last streak if it exists
        if (currentWinStreak > 0) {
            winStreaks[currentWinStreak] = (winStreaks[currentWinStreak] || 0) + 1;
        }
        if (currentLossStreak > 0) {
            lossStreaks[currentLossStreak] = (lossStreaks[currentLossStreak] || 0) + 1;
        }

        // Summary
        this.log("Summary of 3-digit (4/5) sequences with 5th digit outcome:", true);
        this.log(`Total sequences found: ${sequencesFound} time(s)`, true);
        const totalWins = outcomes.filter(o => o === "Won").length;
        const totalLosses = outcomes.filter(o => o === "Lost").length;
        this.log(`Won (5th digit not 4 or 5): ${totalWins} time(s)`, true);
        this.log(`Lost (5th digit 4 or 5): ${totalLosses} time(s)`, true);
        this.log(`Total sequences analyzed: ${totalWins + totalLosses}`, true);
        this.log(`Percentage Won: ${totalWins + totalLosses > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(2) : 0}%`, true);

        // Consecutive Wins and Losses Summary
        this.log("\nConsecutive Wins Summary:", true);
        if (Object.keys(winStreaks).length === 0) {
            this.log("No consecutive win streaks found", true);
        } else {
            for (const [length, count] of Object.entries(winStreaks)) {
                this.log(`Win streaks of length ${length}: ${count} time(s)`, true);
            }
        }

        this.log("\nConsecutive Losses Summary:", true);
        if (Object.keys(lossStreaks).length === 0) {
            this.log("No consecutive loss streaks found", true);
        } else {
            for (const [length, count] of Object.entries(lossStreaks)) {
                this.log(`Loss streaks of length ${length}: ${count} time(s)`, true);
            }
        }

        this.log(`Detailed analysis saved to ${this.logFile}`);
    }
}

new DerivTickAnalyzer();