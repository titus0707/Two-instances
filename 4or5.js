const WebSocket = require('ws');
const fs = require('fs');

class DerivTickAnalyzer {
    constructor() {
        this.ws = null;
        this.app_id = "1089"; // Replace with your app ID
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your API token
        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];
        this.tickCount = 5000; // Number of ticks to fetch per symbol
        this.results = {};
        this.logFile = 'multi_symbol_tick_analysis_5th_digit.log';

        fs.writeFileSync(this.logFile, `Analysis of ${this.tickCount} ticks for ${this.symbols.length} symbols - 3-digit (4/5) sequences with 5th digit outcome - Started ${new Date().toLocaleString()}\n\n`, 'utf8');

        this.log(`Starting Deriv Tick Analyzer for ${this.symbols.length} symbols`);
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
        for (const symbol of this.symbols) {
            this.results[symbol] = { digitHistory: [], outcomes: [] };
            await this.fetchHistory(symbol);
            this.analyzeTicks(symbol);
        }
        this.generateTable();
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

    async fetchHistory(symbol) {
        return new Promise((resolve) => {
            this.currentSymbol = symbol;
            this.historyResolve = resolve;
            this.ws.send(JSON.stringify({
                ticks_history: symbol,
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
                    this.results[this.currentSymbol].digitHistory = digits;
                    this.log(`Fetched ${digits.length} ticks for ${this.currentSymbol}`);
                    this.historyResolve();
                    this.historyResolve = null;
                }
                break;
            case "error":
                this.log(`API Error: ${response.error.message}`);
                break;
        }
    }

    analyzeTicks(symbol) {
        const digitHistory = this.results[symbol].digitHistory;
        if (digitHistory.length < 5) { // Need 5 digits now instead of 4
            this.log(`Not enough tick data for ${symbol} (need at least 5 ticks)`);
            return;
        }

        let sequencesFound = 0;
        const outcomes = [];
        const winStreaks = {};
        const lossStreaks = {};
        let currentWinStreak = 0;
        let currentLossStreak = 0;

        this.log(`\nDetailed analysis for ${symbol} (using 5th digit):`, true);

        for (let i = 0; i < digitHistory.length - 4; i++) { // Adjusted to -4 for 5 digits
            const first = digitHistory[i];
            const second = digitHistory[i + 1];
            const third = digitHistory[i + 2];
            const fifth = digitHistory[i + 4]; // Use 5th digit instead of 4th

            if ((first === 4 || first === 5) &&
                (second === 4 || second === 5) &&
                (third === 4 || third === 5)) {
                sequencesFound++;
                const sequence = `${first}${second}${third}`;
                const outcome = (fifth === 4 || fifth === 5) ? "Lost" : "Won";
                outcomes.push(outcome);
                this.log(`[${symbol}] Sequence ${sequence} at position ${i}-${i+2}, 5th digit ${fifth}: ${outcome}`, true);

                // Track consecutive wins and losses
                if (outcome === "Won") {
                    currentWinStreak++;
                    if (currentLossStreak > 0) {
                        lossStreaks[currentLossStreak] = (lossStreaks[currentLossStreak] || 0) + 1;
                        currentLossStreak = 0;
                    }
                } else {
                    currentLossStreak++;
                    if (currentWinStreak > 0) {
                        winStreaks[currentWinStreak] = (winStreaks[currentWinStreak] || 0) + 1;
                        currentWinStreak = 0;
                    }
                }
            }
        }

        // Record the last streak
        if (currentWinStreak > 0) winStreaks[currentWinStreak] = (winStreaks[currentWinStreak] || 0) + 1;
        if (currentLossStreak > 0) lossStreaks[currentLossStreak] = (lossStreaks[currentLossStreak] || 0) + 1;

        this.results[symbol].outcomes = outcomes;
        this.results[symbol].sequencesFound = sequencesFound;
        this.results[symbol].winStreaks = winStreaks;
        this.results[symbol].lossStreaks = lossStreaks;
    }

    generateTable() {
        this.log("\nSummary Table of Analysis Results (5th Digit Outcomes):", true);

        const tableData = this.symbols.map(symbol => {
            const outcomes = this.results[symbol].outcomes;
            const totalWins = outcomes.filter(o => o === "Won").length;
            const totalLosses = outcomes.filter(o => o === "Lost").length;
            const winStreaks = this.results[symbol].winStreaks;
            const lossStreaks = this.results[symbol].lossStreaks;

            const maxWinStreak = Object.keys(winStreaks).length > 0 ? Math.max(...Object.keys(winStreaks).map(Number)) : 0;
            const maxLossStreak = Object.keys(lossStreaks).length > 0 ? Math.max(...Object.keys(lossStreaks).map(Number)) : 0;

            return {
                Symbol: symbol,
                "Total Wins": totalWins,
                "Total Losses": totalLosses,
                "Max Win Streak": maxWinStreak,
                "Max Loss Streak": maxLossStreak,
                "Sequences Found": this.results[symbol].sequencesFound
            };
        });

        // Calculate column widths
        const columnWidths = {
            Symbol: Math.max(...tableData.map(d => d.Symbol.length), "Symbol".length),
            "Total Wins": Math.max(...tableData.map(d => String(d["Total Wins"]).length), "Total Wins".length),
            "Total Losses": Math.max(...tableData.map(d => String(d["Total Losses"]).length), "Total Losses".length),
            "Max Win Streak": Math.max(...tableData.map(d => String(d["Max Win Streak"]).length), "Max Win Streak".length),
            "Max Loss Streak": Math.max(...tableData.map(d => String(d["Max Loss Streak"]).length), "Max Loss Streak".length),
            "Sequences Found": Math.max(...tableData.map(d => String(d["Sequences Found"]).length), "Sequences Found".length)
        };

        // Generate table
        let table = `+${"-".repeat(columnWidths.Symbol + 2)}+${"-".repeat(columnWidths["Total Wins"] + 2)}+${"-".repeat(columnWidths["Total Losses"] + 2)}+${"-".repeat(columnWidths["Max Win Streak"] + 2)}+${"-".repeat(columnWidths["Max Loss Streak"] + 2)}+${"-".repeat(columnWidths["Sequences Found"] + 2)}+\n`;
        table += `| ${"Symbol".padEnd(columnWidths.Symbol)} | ${"Total Wins".padEnd(columnWidths["Total Wins"])} | ${"Total Losses".padEnd(columnWidths["Total Losses"])} | ${"Max Win Streak".padEnd(columnWidths["Max Win Streak"])} | ${"Max Loss Streak".padEnd(columnWidths["Max Loss Streak"])} | ${"Sequences Found".padEnd(columnWidths["Sequences Found"])} |\n`;
        table += `+${"-".repeat(columnWidths.Symbol + 2)}+${"-".repeat(columnWidths["Total Wins"] + 2)}+${"-".repeat(columnWidths["Total Losses"] + 2)}+${"-".repeat(columnWidths["Max Win Streak"] + 2)}+${"-".repeat(columnWidths["Max Loss Streak"] + 2)}+${"-".repeat(columnWidths["Sequences Found"] + 2)}+\n`;

        tableData.forEach(row => {
            table += `| ${row.Symbol.padEnd(columnWidths.Symbol)} | ${String(row["Total Wins"]).padEnd(columnWidths["Total Wins"])} | ${String(row["Total Losses"]).padEnd(columnWidths["Total Losses"])} | ${String(row["Max Win Streak"]).padEnd(columnWidths["Max Win Streak"])} | ${String(row["Max Loss Streak"]).padEnd(columnWidths["Max Loss Streak"])} | ${String(row["Sequences Found"]).padEnd(columnWidths["Sequences Found"])} |\n`;
        });

        table += `+${"-".repeat(columnWidths.Symbol + 2)}+${"-".repeat(columnWidths["Total Wins"] + 2)}+${"-".repeat(columnWidths["Total Losses"] + 2)}+${"-".repeat(columnWidths["Max Win Streak"] + 2)}+${"-".repeat(columnWidths["Max Loss Streak"] + 2)}+${"-".repeat(columnWidths["Sequences Found"] + 2)}+\n`;

        this.log(table, true);
        this.log(`Detailed analysis saved to ${this.logFile}`);
    }
}

new DerivTickAnalyzer();