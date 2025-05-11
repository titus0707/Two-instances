const WebSocket = require('ws');

class DerivBot {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.api_token = "TiJJw4oekZjgVHm"; // Replace with your token
        this.isWaitingForResults = false;
        this.isStopped = false;

        // Martingale configuration
        this.maxLevels = 6;
        this.martingaleMultiplier = 6.0;
        this.currentMultiplier = 1;

        // Profit tracking
        this.totalProfit = 0;
        this.dailyProfit = 0;
        this.takeProfitTarget = 2;
        this.trades = 0;
        this.consecutiveLosses = 0;

        // Trading configuration
        this.tradingConfig = {
            under: 4,
            over: 5,
            under_stake: 0.35,
            over_stake: 0.35
        };

        // Prediction system
        this.patternTracker = new PatternTracker();
        this.previousDigit = null;
        this.activeTrades = { under: null, over: null };

        this.run();
    }

    getStakes() {
        return {
            under: this.tradingConfig.under_stake * this.currentMultiplier,
            over: this.tradingConfig.over_stake * this.currentMultiplier
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
                ticks_history: "RDBULL",
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
            ticks: "RDBULL",
            subscribe: 1
        }));
        console.log("🔔 Subscribed to real-time ticks");
    }

    handleMessage(data) {
        if (this.isStopped) return;

        const response = JSON.parse(data);
        switch (response.msg_type) {
            case "authorize":
                console.log("🔑 Authentication successful");
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

        const currentDigit = Math.floor((parseFloat(tick.quote) * 10000) % 10);
        console.log(`🕒 Tick Update | Digit: ${currentDigit}`);

        // Update pattern tracker
        if (this.previousDigit !== null) {
            this.patternTracker.addSequence(this.previousDigit, currentDigit);
        }

        // Get prediction and place trades
        if (this.previousDigit !== null) {
            const predictions = this.patternTracker.predictNext(this.previousDigit);
            if (predictions.length > 0) {
                const topPrediction = predictions[0];
                console.log(`🔮 Prediction: ${this.previousDigit} → ${topPrediction.digit} (confidence: ${topPrediction.score})`);
                
                // Place trades if prediction is not 4/5 with sufficient confidence
                if (topPrediction.score > 5 && ![4, 5].includes(topPrediction.digit)) {
                    this.executeTrades();
                }
            }
        }

        this.previousDigit = currentDigit;
    }

    executeTrades() {
        if (this.isWaitingForResults || this.shouldStop()) return;

        this.isWaitingForResults = true;
        const stakes = this.getStakes();

        console.log(`🎯 Placing simultaneous UNDER 4/OVER 5 trades`);
        
        // Place UNDER 4 trade
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
                symbol: "RDBULL",
                barrier: this.tradingConfig.under.toString()
            }
        }));

        // Place OVER 5 trade
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
                symbol: "RDBULL",
                barrier: this.tradingConfig.over.toString()
            }
        }));

        this.trades += 2;
        console.log(`📊 Placed Both Trades:
        ╔══════════════════════════╗
        ║ UNDER 4 @ $${stakes.under.toFixed(2)} ║
        ║ OVER 5 @ $${stakes.over.toFixed(2)}  ║
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
            this.activeTrades.under = response.buy.contract_id;
        } else {
            this.activeTrades.over = response.buy.contract_id;
        }
    }

    handleContractUpdate(response) {
        if (this.isStopped) return;

        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;

        const profit = parseFloat(contract.profit);
        this.totalProfit += profit;
        this.dailyProfit += profit;

        if (contract.contract_id === this.activeTrades.under) {
            this.activeTrades.under = contract.status === "won" ? "won" : "lost";
        } else {
            this.activeTrades.over = contract.status === "won" ? "won" : "lost";
        }

        if (typeof this.activeTrades.under === "string" &&
            typeof this.activeTrades.over === "string") {
            
            this.displayResults();
            this.updateMartingale();
            this.resetTrades();
        }

        this.shouldStop();
    }

    displayResults() {
        console.log(`📈 Trade Results:
        ╔════════════════════════════╗
        ║ UNDER: ${this.activeTrades.under === "won" ? "✅ WON" : "❌ LOST"}  ║
        ║ OVER:  ${this.activeTrades.over === "won" ? "✅ WON" : "❌ LOST"}  ║
        ╟────────────────────────────╢
        ║ Daily Profit: $${this.dailyProfit.toFixed(2)}     ║
        ║ Total Profit: $${this.totalProfit.toFixed(2)}     ║
        ╚════════════════════════════╝`);
    }

    updateMartingale() {
        if (this.activeTrades.under === "lost" && this.activeTrades.over === "lost") {
            this.consecutiveLosses++;
            if (this.consecutiveLosses <= this.maxLevels) {
                this.currentMultiplier = Math.pow(this.martingaleMultiplier, this.consecutiveLosses);
                console.log(`📉 Loss Streak: ${this.consecutiveLosses} → Multiplier: ${this.currentMultiplier}x`);
            }
        } else {
            this.consecutiveLosses = 0;
            this.currentMultiplier = 1;
        }
    }

    resetTrades() {
        this.isWaitingForResults = false;
        this.activeTrades = { under: null, over: null };
    }

    shouldStop() {
        if (this.isStopped) return true;
        if (this.dailyProfit >= this.takeProfitTarget) {
            console.log(`\n🎯 Target Reached: $${this.takeProfitTarget} Profit!`);
            this.stopBot();
            return true;
        }
        return false;
    }

    stopBot() {
        if (this.isStopped) return;

        console.log("🛑 Stopping bot...");
        this.isStopped = true;

        this.ws.send(JSON.stringify({
            ticks: "RDBULL",
            subscribe: 0
        }));

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }

        setTimeout(() => process.exit(0), 1000);
    }
}

class PatternTracker {
    constructor() {
        this.sequenceMap = new Map();
    }

    addSequence(prevDigit, currentDigit) {
        if (!this.sequenceMap.has(prevDigit)) {
            this.sequenceMap.set(prevDigit, Array(10).fill(0));
        }
        this.sequenceMap.get(prevDigit)[currentDigit]++;
    }

    predictNext(prevDigit) {
        const probabilities = this.sequenceMap.get(prevDigit) || Array(10).fill(0);
        return probabilities
            .map((count, digit) => ({ digit, score: count }))
            .filter(d => ![4, 5].includes(d.digit))
            .sort((a, b) => b.score - a.score);
    }
}

// Initialize bot
new DerivBot();