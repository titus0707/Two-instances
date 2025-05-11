const WebSocket = require('ws');
const fs = require('fs');

class DerivTradingBot {
    constructor() {
        this.connections = new Map();
        this.app_id = "1089";
        this.api_token = "sEcAT5qfmp52HYX";
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.martingaleMultiplier = 2.04;
        this.takeProfitTarget = 10.00;
        this.totalProfit = 0;
        this.isAnyTradePending = false;
        this.isRunning = true;
        this.digitHistories = new Map();
        this.streakStats = new Map(); // New: Tracks streak statistics
        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];

        this.logFile = 'trading_log.log';
        fs.writeFileSync(this.logFile, `Deriv Trading Bot - Started ${new Date().toLocaleString()}\nSymbols: ${this.symbols.join(', ')}\nStrategy: Trade after 5 consecutive odd or even digits\n\n`, 'utf8');

        // Initialize histories and streak stats for each symbol
        this.symbols.forEach(symbol => {
            this.digitHistories.set(symbol, []);
            this.streakStats.set(symbol, { oddStreaks: {}, evenStreaks: {} });
        });
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
        // Periodically display streak stats
        setInterval(() => this.displayStreakStats(), 60000); // Every 60 seconds
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
            ws.on('close', () => {
                this.log(`Connection lost for ${symbol} - reconnecting...`);
                this.connect(symbol);
            });
            ws.on('error', (error) => this.log(`WebSocket error for ${symbol}: ${error.message}`));
        });
    }

    authenticate(ws) {
        ws.send(JSON.stringify({ authorize: this.api_token }));
    }

    subscribeToTicks(symbol) {
        this.connections.get(symbol).send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }

    handleMessage(symbol, data) {
        const response = JSON.parse(data);
        switch (response.msg_type) {
            case "authorize":
                if (!response.error) {
                    this.log(`${symbol} - Successfully authorized`);
                    this.subscribeToTicks(symbol);
                } else {
                    this.log(`${symbol} - Authorization failed: ${response.error.message}`);
                }
                break;
            case "tick":
                if (response.tick && response.tick.quote) {
                    this.processTick(symbol, response.tick);
                }
                break;
            case "buy":
                this.handleBuyResponse(symbol, response);
                break;
            case "proposal_open_contract":
                this.handleContractUpdate(symbol, response);
                break;
            case "error":
                this.log(`API Error for ${symbol}: ${response.error.message}`);
                break;
        }
    }

    processTick(symbol, tick) {
        if (!this.isRunning) return;
        const quoteStr = String(tick.quote);
        const lastDigit = parseInt(quoteStr.slice(-1));
        const history = this.digitHistories.get(symbol);
        const stats = this.streakStats.get(symbol);
        const isOdd = lastDigit % 2 !== 0;

        // Track streaks
        if (history.length === 0 || (isOdd === (history[history.length - 1] % 2 !== 0))) {
            history.push(lastDigit);
        } else {
            // Streak broken, record it
            const streakLength = history.length;
            const streakType = history[0] % 2 !== 0 ? 'oddStreaks' : 'evenStreaks';
            stats[streakType][streakLength] = (stats[streakType][streakLength] || 0) + 1;
            history.length = 0; // Clear history
            history.push(lastDigit); // Start new streak
        }

        // Limit history to avoid memory issues
        if (history.length > 5) history.shift();

        // Check for trading opportunity
        if (history.length === 5 && !this.isAnyTradePending) {
            this.log(`${symbol} - Last 5 digits: ${history.join(',')}`);
            const allOdd = history.every(digit => digit % 2 !== 0);
            const allEven = history.every(digit => digit % 2 === 0);
            if (allOdd) {
                this.log(`${symbol} - Trading opportunity found: 5 consecutive odd digits`);
                this.executeTrade(symbol, "DIGITEVEN");
            } else if (allEven) {
                this.log(`${symbol} - Trading opportunity found: 5 consecutive even digits`);
                this.executeTrade(symbol, "DIGITODD");
            }
        }
    }

    executeTrade(symbol, contractType) {
        const stake = this.currentStake;
        const ws = this.connections.get(symbol);
        ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: "stake",
                contract_type: contractType,
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: symbol
            },
            passthrough: { contractType: contractType }
        }));
        this.isAnyTradePending = true;
        this.log(`${symbol} - Placed ${contractType} trade with stake $${stake.toFixed(2)}`, true);
    }

    handleBuyResponse(symbol, response) {
        if (response.error) {
            this.log(`Trade error: ${response.error.message}`, true);
            this.isAnyTradePending = false;
            return;
        }
        this.log(`${symbol} - ${response.passthrough.contractType} contract purchased`);
    }

    handleContractUpdate(symbol, response) {
        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;
        const profit = parseFloat(contract.profit);
        this.totalProfit += profit;
        this.log(`${symbol} - ${contract.contract_type} ${contract.status}: $${profit.toFixed(2)}`, true);
        if (profit < 0) {
            this.currentStake = Number((this.currentStake * this.martingaleMultiplier).toFixed(2));
            this.log(`Loss detected. Increasing stake to $${this.currentStake.toFixed(2)}`, true);
        } else {
            this.currentStake = this.baseStake;
            this.log(`Win detected. Resetting stake to $${this.baseStake.toFixed(2)}`, true);
        }
        if (this.totalProfit >= this.takeProfitTarget) {
            this.log(`Target profit reached: $${this.totalProfit.toFixed(2)}. Stopping trading.`, true);
            this.isRunning = false;
            this.displayStreakStats(); // Final stats display
        }
        this.isAnyTradePending = false;
    }

    displayStreakStats() {
        this.log('Streak Analysis Results:');
        this.symbols.forEach(symbol => {
            const stats = this.streakStats.get(symbol);
            this.log(`${symbol} - Odd Streak Counts:`);
            Object.entries(stats.oddStreaks)
                .sort((a, b) => a[0] - b[0])
                .forEach(([length, count]) => {
                    this.log(`  Streak of ${length} odd digits: ${count} times`);
                });
            this.log(`${symbol} - Even Streak Counts:`);
            Object.entries(stats.evenStreaks)
                .sort((a, b) => a[0] - b[0])
                .forEach(([length, count]) => {
                    this.log(`  Streak of ${length} even digits: ${count} times`);
                });
        });
        this.log('End of Streak Analysis');
    }
}

new DerivTradingBot();