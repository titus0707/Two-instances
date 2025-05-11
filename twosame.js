const WebSocket = require('ws');
const fs = require('fs');

class GapTradingBot {
    constructor() {
        this.connections = new Map();
        this.app_id = "1089"; // Replace with your Deriv app ID
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your Deriv API token
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.isAnyTradePending = false;
        this.isTradingActive = false;
        this.isRecovering = false;
        this.activeTrades = new Map();
        this.contractToTradeType = {};
        this.totalProfit = 0;
        this.martingaleMultiplier = 12;
        this.takeProfitTarget = 10.00;
        this.isRunning = true;
        this.currentTradingSymbol = null;
        this.lastPatternTicks = new Map(); // Tracks last pattern occurrence
        this.tickCounters = new Map(); // Counts ticks
        this.recentLastDigits = new Map(); // Stores last three digits
        this.tickHistory = new Map(); // Stores recent ticks

        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];

        this.logFile = 'gap_trading_log.log';
        fs.writeFileSync(this.logFile, `Gap Trading Bot - Started ${new Date().toLocaleString()}\nSymbols: ${this.symbols.join(', ')}\nStrategy: Trade 1-tick DIGITMATCH when last digits of three consecutive ticks are identical, logging last 10 ticks after pattern, trading every pattern if no pending trade\n\n`, 'utf8');

        this.symbols.forEach(symbol => {
            this.activeTrades.set(symbol, { match: { status: null, profit: 0 } });
            this.lastPatternTicks.set(symbol, null);
            this.tickCounters.set(symbol, 0);
            this.recentLastDigits.set(symbol, []);
            this.tickHistory.set(symbol, []);
        });

        this.log(`Starting Gap Trading Bot`);
        this.log(`Tracking ${this.symbols.length} symbols`);
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
        this.symbols.forEach(symbol => this.subscribeToTicks(symbol));
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
                this.log(`${symbol} - Successfully authorized`);
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
        // Extract last digit, handling 0 correctly
        const parts = quoteStr.split('.');
        const lastDigit = parts.length > 1 && parts[1].length > 0 ? parseInt(parts[1].slice(-1)) : 0;

        let tickCounter = this.tickCounters.get(symbol);
        tickCounter++;
        this.tickCounters.set(symbol, tickCounter);

        // Update tick history
        let history = this.tickHistory.get(symbol);
        history.push({ quote: quoteStr, lastDigit, tickNumber: tickCounter });
        if (history.length > 10) history.shift(); // Store up to 10 ticks
        this.tickHistory.set(symbol, history);

        // Update recent digits for pattern detection
        let recentDigits = this.recentLastDigits.get(symbol);
        recentDigits.push(lastDigit);
        if (recentDigits.length > 3) recentDigits.shift(); // Keep last 3 digits

        // Check for three identical digits
        const isIdenticalDigits = recentDigits.length === 3 && 
                                 recentDigits[0] === recentDigits[1] && 
                                 recentDigits[1] === recentDigits[2];

        this.recentLastDigits.set(symbol, recentDigits);

        this.log(`${symbol} - Last digit: ${lastDigit} | Recent digits: ${recentDigits.join(', ')} | Ticks since last pattern: ${this.lastPatternTicks.get(symbol) === null ? 'N/A' : tickCounter - this.lastPatternTicks.get(symbol)}`);

        if (isIdenticalDigits) {
            this.lastPatternTicks.set(symbol, tickCounter);
            this.log(`${symbol} - Pattern found: Last digits ${recentDigits[0]}, ${recentDigits[1]}, ${recentDigits[2]} at tick ${tickCounter}`, true);
            // Log last 10 ticks
            this.log(`${symbol} - Last 10 ticks:`, true);
            const ticksToLog = history.slice(-10); // Get up to last 10 ticks
            ticksToLog.forEach((tick, index) => {
                this.log(`${symbol} - Tick ${index + 1}: Quote = ${tick.quote}, Last Digit = ${tick.lastDigit}`, true);
            });
        }

        if (!this.isAnyTradePending && isIdenticalDigits) {
            this.executeTrades(symbol, lastDigit);
            this.isTradingActive = true;
            this.log(`${symbol} - Trading triggered: Three consecutive last digits = ${lastDigit}, Predicting digit = ${lastDigit}`, true);
        }
    }

    executeTrades(symbol, digit) {
        if (this.isAnyTradePending) {
            this.log(`${symbol} - Skipping trade: Trade pending on ${this.currentTradingSymbol}`);
            return;
        }

        this.isAnyTradePending = true;
        this.currentTradingSymbol = symbol;
        const stake = this.currentStake;
        const ws = this.connections.get(symbol);

        ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: symbol,
                barrier: String(digit) // Predict the same digit
            },
            passthrough: { trade_type: "match" }
        }));

        this.log(`${symbol} - Placed 1-tick DIGITMATCH trade | Stake: $${stake.toFixed(2)} | Digit: ${digit}`, true);
    }

    handleBuyResponse(symbol, response) {
        if (response.error) {
            this.log(`${symbol} - Trade error: ${response.error.message}`, true);
            this.isAnyTradePending = false;
            this.currentTradingSymbol = null;
            return;
        }
        const tradeType = response.passthrough?.trade_type;
        if (tradeType) {
            this.contractToTradeType[response.buy.contract_id] = tradeType;
            this.log(`${symbol} - ${tradeType.toUpperCase()} contract purchased (1 tick)`);
        } else {
            this.log(`${symbol} - Warning: Missing trade_type in buy response`, true);
        }
    }

    handleContractUpdate(symbol, response) {
        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;

        const tradeType = this.contractToTradeType[contract.contract_id];
        if (!tradeType) {
            this.log(`${symbol} - Warning: No tradeType for contract_id ${contract.contract_id}`, true);
            return;
        }

        const trades = this.activeTrades.get(symbol);
        if (!trades || !trades[tradeType]) {
            this.log(`${symbol} - Error: Invalid trades structure for tradeType ${tradeType}`, true);
            return;
        }

        const profit = parseFloat(contract.profit);
        this.totalProfit += profit;
        trades[tradeType].status = contract.status;
        trades[tradeType].profit = profit;

        this.log(`${symbol} - ${tradeType.toUpperCase()} ${contract.status.toUpperCase()}: $${profit.toFixed(2)} (1 tick)`, true);

        if (trades.match.status) {
            if (trades.match.status === "lost") {
                this.currentStake = Number((this.currentStake * this.martingaleMultiplier).toFixed(2));
                this.isRecovering = true;
                this.log(`${symbol} - ❌ Trade lost | New stake: $${this.currentStake.toFixed(2)} | Recovery mode`, true);
            } else {
                this.currentStake = this.baseStake;
                this.isRecovering = false;
                this.log(`${symbol} - ✅ Reset stake to base: $${this.baseStake.toFixed(2)}`, true);
            }

            this.log(`${symbol} - 📊 Total Profit: $${this.totalProfit.toFixed(2)}`, true);

            if (this.totalProfit >= this.takeProfitTarget) {
                this.log(`🎯 Target reached! Stopping trading. Total Profit: $${this.totalProfit.toFixed(2)}`, true);
                this.isRunning = false;
            }

            trades.match.status = null;
            this.isAnyTradePending = false;
            this.currentTradingSymbol = null;
            delete this.contractToTradeType[contract.contract_id]; // Clear contract ID
            this.log(`${symbol} - Trade results processed`);
        }
    }
}

new GapTradingBot();