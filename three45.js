const WebSocket = require('ws');
const fs = require('fs');

class DerivTradingBot {
    constructor() {
        this.connections = new Map();
        this.app_id = "1089";
        this.api_token = "sEcAT5qfmp52HYX";
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.digitHistories = new Map();
        this.isAnyTradePending = false;
        this.excludedSymbols = new Set();
        this.isTradingActive = false;
        this.isRecovering = false;
        this.activeTrades = new Map();
        this.contractToTradeType = {};
        this.totalProfit = 0;
        this.martingaleMultiplier = 5.66;
        this.takeProfitTarget = 20.00;
        this.isRunning = true;
        this.currentTradingSymbol = null;
        this.patternReadySymbols = new Set();

        this.symbols = [
            "1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50",
            "1HZ75V", "R_75", "1HZ100V", "R_100", "RDBEAR", "RDBULL",
            "JD10", "JD25", "JD50", "JD75", "JD100"
        ];

        this.logFile = 'trading_log.log';
        fs.writeFileSync(this.logFile, `Deriv Trading Bot - Started ${new Date().toLocaleString()}\nSymbols: ${this.symbols.join(', ')}\nStrategy: Wait for three 4s or 5s, then trade UNDER4/OVER5 on 45 or 54\n\n`, 'utf8');

        this.symbols.forEach(symbol => {
            this.digitHistories.set(symbol, []);
            this.activeTrades.set(symbol, { under4: { status: null, profit: 0 }, over5: { status: null, profit: 0 } });
        });

        this.log(`Starting Deriv Trading Bot`);
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
        const history = this.digitHistories.get(symbol);
        history.push(lastDigit);
        if (history.length > 3) history.shift();
        this.log(`${symbol} - Last digit: ${lastDigit}`);

        if (history.length >= 3) {
            const lastThreeDigits = history.slice(-3);
            const isThreePattern = lastThreeDigits.every(digit => digit === 4 || digit === 5) && 
                                  lastThreeDigits.length === 3;

            if (isThreePattern && !this.patternReadySymbols.has(symbol)) {
                this.patternReadySymbols.add(symbol);
                this.log(`${symbol} - Three 4s or 5s detected: ${lastThreeDigits.join('-')} - Waiting for 45/54`);
                return;
            }

            if (this.patternReadySymbols.has(symbol)) {
                const lastTwoDigits = history.slice(-2);
                const isTradePattern = (lastTwoDigits[0] === 4 && lastTwoDigits[1] === 5) || 
                                      (lastTwoDigits[0] === 5 && lastTwoDigits[1] === 4);

                if (isTradePattern && !this.isAnyTradePending) {
                    const isExcluded = this.excludedSymbols.has(symbol);
                    if (!isExcluded) {
                        this.executeTrades(symbol, lastTwoDigits);
                        this.patternReadySymbols.delete(symbol);
                        this.isTradingActive = true;
                        this.log(`${symbol} - Trading after three 4/5s then ${lastTwoDigits.join('-')}`);
                    }
                }
            }
        }
    }

    executeTrades(symbol, lastTwoDigits) {
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
                duration: 1,
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
                duration: 1,
                duration_unit: "t",
                symbol: symbol,
                barrier: "5"
            },
            passthrough: { trade_type: "over5" }
        }));

        this.log(`${symbol} - Placed trades after pattern: ${lastTwoDigits.join('-')} | Stake: $${stake.toFixed(2)}`, true);
        this.log(`${symbol} - UNDER4 @4 | OVER5 @5`);
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
        this.log(`${symbol} - ${tradeType.toUpperCase()} contract purchased`);
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

        this.log(`${symbol} - ${tradeType.toUpperCase()} ${contract.status.toUpperCase()}: $${profit.toFixed(2)}`, true);

        if (trades.under4.status && trades.over5.status) {
            const bothLost = trades.under4.status === "lost" && trades.over5.status === "lost";

            if (bothLost) {
                this.excludedSymbols.add(symbol);
                this.currentStake = Number((this.currentStake * this.martingaleMultiplier).toFixed(2));
                this.isRecovering = true;
                this.log(`${symbol} - ❌ Both trades lost | Excluded symbol | New stake: $${this.currentStake.toFixed(2)} | Recovery on any symbol`, true);
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

new DerivTradingBot();