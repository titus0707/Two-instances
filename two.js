const WebSocket = require('ws');
const fs = require('fs');

class DerivTickAnalyzer {
    constructor() {
        this.connections = new Map();
        this.app_id = "1089"; // Replace with your Deriv app ID
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your Deriv API token
        this.historyResolves = new Map();
        this.tickHistories = new Map(); // Store tick data for each symbol
        this.historySize = 5000;

        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];

        this.logFile = 'tick_analysis.log';
        fs.writeFileSync(this.logFile, `Deriv Tick Analysis - Started ${new Date().toLocaleString()}\nSymbols: ${this.symbols.join(', ')}\nAnalyzing "45" patterns over ${this.historySize} ticks\n\n`, 'utf8');

        this.log(`Starting Deriv Tick Analyzer for ${this.historySize} ticks`);
        this.run();
    }

    log(message, toFile = false) {
        const timestamp = new Date().toLocaleString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        if (toFile) fs.appendFileSync(this.logFile, `${logMessage}\n`, 'utf8');
    }

    async run() {
        await Promise.all(this.symbols.map(symbol => this.connect(symbol)));
        await Promise.all(this.symbols.map(symbol => this.fetchHistory(symbol)));
        this.generateReportTable();
    }

    connect(symbol) {
        return new Promise((resolve) => {
            const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
            this.connections.set(symbol, ws);

            ws.on('open', () => {
                this.authenticate(ws);
                resolve();
            });
            ws.on('message', (data) => this.handleMessage(symbol, data));
            ws.on('close', () => this.log(`Connection lost for ${symbol}`));
            ws.on('error', (error) => this.log(`WebSocket error for ${symbol}: ${error.message}`));
        });
    }

    authenticate(ws) {
        ws.send(JSON.stringify({ authorize: this.api_token }));
    }

    async fetchHistory(symbol) {
        return new Promise((resolve) => {
            this.historyResolves.set(symbol, resolve);
            this.connections.get(symbol).send(JSON.stringify({
                ticks_history: symbol,
                count: this.historySize,
                end: "latest"
            }));
            this.log(`Requesting ${this.historySize} ticks for ${symbol}`);
        });
    }

    handleMessage(symbol, data) {
        const response = JSON.parse(data);
        if (response.msg_type === "history" && this.historyResolves.has(symbol)) {
            this.log(`Received ${response.history.prices.length} ticks for ${symbol}`);
            const digits = response.history.prices.map(price => parseInt(String(price).slice(-1)));
            this.tickHistories.set(symbol, digits); // Store the tick data
            this.historyResolves.get(symbol)(digits);
            this.historyResolves.delete(symbol);
        } else if (response.msg_type === "error") {
            this.log(`API Error for ${symbol}: ${response.error.message}`);
            if (this.historyResolves.has(symbol)) {
                this.tickHistories.set(symbol, []); // Store empty array on error
                this.historyResolves.get(symbol)([]);
                this.historyResolves.delete(symbol);
            }
        }
    }

    analyzePatternHistory(digits) {
        if (!digits || digits.length < 3) {
            return { patterns: 0, wins: 0, losses: 0, longestWinStreak: 0, longestLoseStreak: 0 };
        }

        let wins = 0;
        let losses = 0;
        let currentWinStreak = 0;
        let currentLoseStreak = 0;
        let longestWinStreak = 0;
        let longestLoseStreak = 0;
        let patternCount = 0;

        for (let i = 0; i < digits.length - 2; i++) {
            if (digits[i] === 4 && digits[i + 1] === 5) {
                patternCount++;
                const nextDigit = digits[i + 2];
                if (nextDigit === 4 || nextDigit === 5) {
                    losses++;
                    currentLoseStreak++;
                    currentWinStreak = 0;
                    longestLoseStreak = Math.max(longestLoseStreak, currentLoseStreak);
                } else {
                    wins++;
                    currentWinStreak++;
                    currentLoseStreak = 0;
                    longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
                }
            }
        }

        return { patterns: patternCount, wins, losses, longestWinStreak, longestLoseStreak };
    }

    generateReportTable() {
        const tableHeader = [
            "Symbol      | Patterns | Wins | Losses | Win %   | Longest Win Streak | Longest Loss Streak",
            "------------|----------|------|--------|---------|--------------------|---------------------"
        ];
        const tableRows = [];

        this.symbols.forEach(symbol => {
            const digits = this.tickHistories.get(symbol) || []; // Use stored history, default to empty array
            const { patterns, wins, losses, longestWinStreak, longestLoseStreak } = this.analyzePatternHistory(digits);
            const winPercentage = patterns > 0 ? ((wins / patterns) * 100).toFixed(2) : "0.00";
            tableRows.push(
                `${symbol.padEnd(12)}| ${String(patterns).padEnd(8)}| ${String(wins).padEnd(4)}| ${String(losses).padEnd(6)}| ${winPercentage.padEnd(7)}| ${String(longestWinStreak).padEnd(18)}| ${longestLoseStreak}`
            );
        });

        const fullTable = [...tableHeader, ...tableRows].join('\n');
        this.log("Analysis Report for 5000 Ticks ('45' Pattern):", true);
        this.log(fullTable, true);

        // Close all connections after report
        this.connections.forEach(ws => ws.close());
    }
}

new DerivTickAnalyzer();