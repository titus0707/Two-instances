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
        this.martingaleMultiplier = 5.66;
        this.takeProfitTarget = 10.00;
        this.isRunning = true;
        this.currentTradingSymbol = null;
        this.lastPatternTicks = new Map(); // Tracks last "45" or "54" occurrence
        this.tickCounters = new Map(); // Counts ticks since last pattern

        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];

        this.logFile = 'gap_trading_log.log';
        fs.writeFileSync(this.logFile, `Gap Trading Bot - Started ${new Date().toLocaleString()}\nSymbols: ${this.symbols.join(', ')}\nStrategy: Trade 10-tick contracts when gap > 10 ticks since last "45" or "54" and last digit is 4 or 5\n\n`, 'utf8');

        this.symbols.forEach(symbol => {
            this.activeTrades.set(symbol, { under4: { status: null, profit: 0 }, over5: { status: null, profit: 0 } });
            this.lastPatternTicks.set(symbol, null);
            this.tickCounters.set(symbol, 0);
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
        const lastDigit = parseInt(quoteStr.slice(-1));
        const lastTwoDigits = quoteStr.slice(-2);
        let tickCounter = this.tickCounters.get(symbol);
        tickCounter++;
        this.tickCounters.set(symbol, tickCounter);

        // Check for "45" or "54" pattern
        if (lastTwoDigits === "45" || lastTwoDigits === "54") {
            this.lastPatternTicks.set(symbol, tickCounter);
            this.log(`${symbol} - Pattern "${lastTwoDigits}" found at tick ${tickCounter}`);
        }

        this.log(`${symbol} - Last digit: ${lastDigit} | Ticks since last pattern: ${this.lastPatternTicks.get(symbol) === null ? 'N/A' : tickCounter - this.lastPatternTicks.get(symbol)}`);

        if (!this.isAnyTradePending) {
            const ticksSinceLastPattern = this.lastPatternTicks.get(symbol) === null ? Infinity : tickCounter - this.lastPatternTicks.get(symbol);
            const isTradeCondition = ticksSinceLastPattern > 10 && (lastDigit === 4 || lastDigit === 5);

            if (isTradeCondition) {
                this.executeTrades(symbol);
                this.isTradingActive = true;
                this.log(`${symbol} - Trading triggered: Gap = ${ticksSinceLastPattern} ticks, Last digit = ${lastDigit}`);
            }
        }
    }

    executeTrades(symbol) {
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
                contract_type: "DIGITUNDER",
                currency: "USD",
                duration: 1, // Changed to 10 ticks
                duration_unit: "t",
                symbol: symbol,
                barrier: "4"
            },
            passthrough: { trade_type: "under4" }
        }));

        ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: "stake",
                contract_type: "DIGITOVER",
                currency: "USD",
                duration: 1, // Changed to 10 ticks
                duration_unit: "t",
                symbol: symbol,
                barrier: "5"
            },
            passthrough: { trade_type: "over5" }
        }));

        this.log(`${symbol} - Placed 10-tick trades | Stake: $${stake.toFixed(2)}`, true);
        this.log(`${symbol} - UNDER4 @4 | OVER5 @5 (10 ticks)`);
    }

    handleBuyResponse(symbol, response) {
        if (response.error) {
            this.log(`${symbol} - Trade error: ${response.error.message}`, true);
            this.isAnyTradePending = false;
            this.currentTradingSymbol = null;
            return;
        }
        const tradeType = response.passthrough.trade_type;
        this.contractToTradeType[response.buy.contract_id] = tradeType;
        this.log(`${symbol} - ${tradeType.toUpperCase()} contract purchased (10 ticks)`);
    }

    handleContractUpdate(symbol, response) {
        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;

        const tradeType = this.contractToTradeType[contract.contract_id];
        if (!tradeType) return;

        const profit = parseFloat(contract.profit);
        this.totalProfit += profit;
        const trades = this.activeTrades.get(symbol);
        trades[tradeType].status = contract.status;
        trades[tradeType].profit = profit;

        this.log(`${symbol} - ${tradeType.toUpperCase()} ${contract.status.toUpperCase()}: $${profit.toFixed(2)} (10 ticks)`, true);

        if (trades.under4.status && trades.over5.status) {
            const bothLost = trades.under4.status === "lost" && trades.over5.status === "lost";

            if (bothLost) {
                this.currentStake = Number((this.currentStake * this.martingaleMultiplier).toFixed(2));
                this.isRecovering = true;
                this.log(`${symbol} - ❌ Both trades lost | New stake: $${this.currentStake.toFixed(2)} | Recovery mode`, true);
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

            trades.under4.status = null;
            trades.over5.status = null;
            this.isAnyTradePending = false;
            this.currentTradingSymbol = null;
            this.log(`${symbol} - Trade results processed`);
        }
    }
}

new GapTradingBot();