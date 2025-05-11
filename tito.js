const WebSocket = require('ws');

const SYMBOL = "RDBEAR";
const MULTIPLIER = 10000;

class DerivBot {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your token
        this.isWaitingForResults = false;
        this.isStopped = false;

        // Martingale configuration
        this.maxLevels = 6;
        this.martingaleMultiplier = 5.66;
        this.currentMultiplier = 1;

        // Profits for each Martingale level
        this.martingaleProfits = [0.13, 0.15, 0.11, 0.18, 0.42, 2.4];

        // Tracking properties
        this.totalProfit = 0;
        this.dailyProfit = 0;
        this.takeProfitTarget = 1.3;
        this.trades = 0;
        this.consecutiveLosses = 0;
        this.currentTradeLevel = 0;

        // Trading configuration
        this.tradingPairs = {
            '0': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '1': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '2': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '3': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '4': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '5': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '6': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '7': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '8': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
            '9': { under: 4, over: 5, under_stake: 0.35, over_stake: 0.35 },
        };

        // Active trades tracking
        this.activeTrades = {
            under: { contract_id: null, status: null },
            over: { contract_id: null, status: null }
        };

        // Trigger sequence tracking
        this.triggerSequence = ['0', '2', '4', '6', '8', '1', '3', '5', '7', '9'];
        this.currentTriggerIndex = 0;

        this.markedDigit = null;
        this.previousDigit = null;

        this.run();
    }

    getStakes() {
        const currentDigit = this.triggerSequence[this.currentTriggerIndex];
        return {
            under: this.tradingPairs[currentDigit].under_stake * this.currentMultiplier,
            over: this.tradingPairs[currentDigit].over_stake * this.currentMultiplier
        };
    }

    async run() {
        console.log("🚀 Starting Deriv Bot...");
        await this.connect();
        await this.fetchHistory();
        this.subscribeToTicks();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
            
            this.ws.on('open', () => {
                console.log("🔗 Connected to Deriv API");
                this.authenticate();
                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data));
            this.ws.on('error', (error) => {
                console.error('WebSocket Error:', error);
                reject(error);
            });
        });
    }

    authenticate() {
        this.ws.send(JSON.stringify({ authorize: this.api_token }));
    }

    async fetchHistory() {
        return new Promise((resolve) => {
            this.ws.send(JSON.stringify({
                ticks_history: SYMBOL,
                count: 50,
                end: "latest"
            }));

            const handler = (data) => {
                const response = JSON.parse(data);
                if (response.msg_type === "history") {
                    this.ws.off('message', handler);
                    console.log("📜 Fetched historical data");
                    resolve();
                }
            };

            this.ws.on('message', handler);
        });
    }

    subscribeToTicks() {
        this.ws.send(JSON.stringify({
            ticks: SYMBOL,
            subscribe: 1
        }));
        console.log("🔔 Subscribed to real-time ticks");
    }

    handleMessage(data) {
        if (this.isStopped) return;

        const response = JSON.parse(data);

        switch (response.msg_type) {
            case "authorize":
                if (response.authorize?.is_virtual) {
                    console.log("🔑 Authenticated to Virtual Account");
                }
                break;

            case "tick":
                this.processTick(response.tick);
                break;

            case "buy":
                this.handleBuyResponse(response);
                break;

            case "proposal_open_contract":
                this.handleContractUpdate(response);
                break;
        }
    }

    processTick(tick) {
        if (this.shouldStop()) return;

        const quote = parseFloat(tick.quote);
        const currentDigit = Math.floor((quote * MULTIPLIER) % 10);
        
        if (this.previousDigit === null) {
            this.previousDigit = currentDigit;
            return;
        }

        const twoDigits = `${this.previousDigit}${currentDigit}`;
        console.log(`🕒 Tick Update | Last Two Digits: ${twoDigits}`);

        if (currentDigit === 4 || currentDigit === 5) {
            this.markedDigit = this.previousDigit;
            console.log(`🔖 Marked Digit: ${this.markedDigit}`);
        }

        if (this.markedDigit !== null && currentDigit === this.markedDigit) {
            console.log(`🚨 Trigger Digit: ${currentDigit}`);
            this.executeTrades(currentDigit.toString());
            this.markedDigit = null;
        }

        this.previousDigit = currentDigit;
    }

    shouldStop() {
        if (this.isStopped) return true;

        const currentDailyProfit = Math.round(this.dailyProfit * 100) / 100;
        if (currentDailyProfit >= this.takeProfitTarget) {
            console.log(`\n🎯 TAKE PROFIT HIT: $${this.takeProfitTarget} REACHED!`);
            this.stopBot();
            return true;
        }
        return false;
    }

    executeTrades(triggerDigit) {
        if (this.isWaitingForResults || this.shouldStop()) return;

        this.isWaitingForResults = true;
        this.currentTradeLevel = this.consecutiveLosses;

        const stakes = this.getStakes();
        const pairConfig = this.tradingPairs[triggerDigit];

        // UNDER trade
        this.ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: stakes.under.toFixed(2),
            parameters: {
                amount: stakes.under.toFixed(2),
                basis: "stake",
                contract_type: "DIGITUNDER",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: SYMBOL,
                barrier: pairConfig.under.toString()
            }
        }));

        // OVER trade
        this.ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: stakes.over.toFixed(2),
            parameters: {
                amount: stakes.over.toFixed(2),
                basis: "stake",
                contract_type: "DIGITOVER",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: SYMBOL,
                barrier: pairConfig.over.toString()
            }
        }));

        this.trades += 2;
        console.log(`📊 Placed Trades (Level ${this.currentTradeLevel}):
        ╔══════════════════════════╗
        ║ UNDER ${pairConfig.under} @ $${stakes.under.toFixed(2)} ║
        ║ OVER ${pairConfig.over} @ $${stakes.over.toFixed(2)}  ║
        ╚══════════════════════════╝`);
    }

    handleBuyResponse(response) {
        if (this.isStopped) return;

        if (response.error) {
            console.error(`❌ Trade Error: ${response.error.message}`);
            this.resetTrades();
            return;
        }

        const contractType = response.echo_req.parameters.contract_type;
        if (contractType === "DIGITUNDER") {
            this.activeTrades.under.contract_id = response.buy.contract_id;
        } else {
            this.activeTrades.over.contract_id = response.buy.contract_id;
        }
    }

    handleContractUpdate(response) {
        if (this.isStopped) return;

        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;

        // Update contract status
        if (contract.contract_id === this.activeTrades.under.contract_id) {
            this.activeTrades.under.status = contract.status;
        } else if (contract.contract_id === this.activeTrades.over.contract_id) {
            this.activeTrades.over.status = contract.status;
        }

        // Check if both trades resolved
        if (this.activeTrades.under.status && this.activeTrades.over.status) {
            const underWon = this.activeTrades.under.status === 'won';
            const overWon = this.activeTrades.over.status === 'won';

            // Apply predefined profit
            const profit = this.martingaleProfits[this.currentTradeLevel] || 0;
            
            if (underWon || overWon) {
                this.totalProfit += profit;
                this.dailyProfit += profit;
                this.consecutiveLosses = 0;
                this.currentMultiplier = 1;
                console.log(`💰 Added Level ${this.currentTradeLevel} Profit: $${profit.toFixed(2)}`);
            } else {
                this.consecutiveLosses++;
                if (this.consecutiveLosses <= this.maxLevels) {
                    this.currentMultiplier = Math.pow(this.martingaleMultiplier, this.consecutiveLosses);
                    console.log(`📉 Consecutive Losses: ${this.consecutiveLosses} → Multiplier: ${this.currentMultiplier}x`);
                }
            }

            this.displayResults();
            this.resetTrades();
        }

        this.shouldStop();
    }

    displayResults() {
        const profit = this.martingaleProfits[this.currentTradeLevel] || 0;
        console.log(`📈 Trade Results:
        ╔════════════════════════════╗
        ║ UNDER: ${this.activeTrades.under.status === "won" ? "✅ WON" : "❌ LOST"}  ║
        ║ OVER:  ${this.activeTrades.over.status === "won" ? "✅ WON" : "❌ LOST"}  ║
        ╟────────────────────────────╢
        ║ Level Profit: $${profit.toFixed(2)}         ║
        ╟────────────────────────────╢
        ║ Daily Profit: $${this.dailyProfit.toFixed(2)}     ║
        ║ Total Profit: $${this.totalProfit.toFixed(2)}     ║
        ╚════════════════════════════╝`);
    }

    resetTrades() {
        this.isWaitingForResults = false;
        this.activeTrades = {
            under: { contract_id: null, status: null },
            over: { contract_id: null, status: null }
        };
    }

    stopBot() {
        if (this.isStopped) return;

        console.log("🛑 Stopping bot...");
        this.isStopped = true;

        this.ws.send(JSON.stringify({
            ticks: SYMBOL,
            subscribe: 0
        }));

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }

        setTimeout(() => process.exit(0), 1000);
    }
}

// Initialize bot
new DerivBot();