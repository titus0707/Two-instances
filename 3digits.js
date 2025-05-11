const WebSocket = require('ws');

class EnhancedDigitBot {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.api_token = "Q9YGOA0Lsi8ldrX";
        

        // Trading Configuration
        this.config = {
            symbol: "R_10",
            baseStake: 1.06,
            martingaleMultiplier: 12,
            maxMartingaleSteps: 5,
            takeProfit: 500,
            stopLoss: -1000,
            tradeCoolDown: 1500

        };

        // State Management
        this.state = {
            active: true,
            currentStake: this.config.baseStake,
            martingaleStep: 0,
            lastThreeDigits: [],
            activeTrade: null,
            lastTradeTime: null
        };

        // Analytics & Reporting
        this.analytics = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfit: 0,
            dailyProfit: 0,
            maxWinStreak: 0,
            maxLossStreak: 0,
            currentWinStreak: 0,
            currentLossStreak: 0,
            profitHistory: [],
            tradeHistory: [],
            startTime: Date.now()
        };

        this.run();
    }

    async run() {
        console.log("🚀 Starting Enhanced Digit Bot...");
        await this.connect();
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

    subscribeToTicks() {
        this.ws.send(JSON.stringify({
            ticks: this.config.symbol,
            subscribe: 1
        }));
        console.log("🔔 Subscribed to real-time ticks");
    }

    handleMessage(data) {
        if (!this.state.active) return;

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
        if (!this.state.active || this.state.activeTrade) return;

        if (this.state.lastTradeTime && 
            Date.now() - this.state.lastTradeTime < this.config.tradeCoolDown) {
            return;
        }

        const currentDigit = Math.floor((parseFloat(tick.quote) * 1000) % 10);
        this.state.lastThreeDigits.push(currentDigit);
        
        if (this.state.lastThreeDigits.length > 3) {
            this.state.lastThreeDigits.shift();
        }

        if (this.state.lastThreeDigits.length === 3) {
            const [d1, d2, d3] = this.state.lastThreeDigits;
            if (d1 === d2 && d2 === d3) {
                console.log(`\n🚨 Triple ${d1} Detected!`);
                this.placeTrade(d1);
            }
        }
    }

    placeTrade(predictedDigit) {
        this.state.activeTrade = {
            id: null,
            digit: predictedDigit,
            stake: this.state.currentStake,
            startTime: Date.now(),
            outcome: 'pending'
        };

        this.ws.send(JSON.stringify({
            buy: 1,
            price: this.state.currentStake.toFixed(2),
            parameters: {
                amount: this.state.currentStake.toFixed(2),
                basis: "stake",
                contract_type: "DIGITMATCH",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: this.config.symbol,
                barrier: predictedDigit.toString()
            }
        }));

        console.log(
            `📊 Placing Trade:\n` +
            `▸ Prediction: ${predictedDigit}\n` +
            `▸ Stake: $${this.state.currentStake.toFixed(2)}\n` +
            `▸ Martingale Step: ${this.state.martingaleStep}`
        );
    }

    handleBuyResponse(response) {
        if (response.error) {
            console.error(`❌ Trade Error: ${response.error.message}`);
            this.resetTrade();
            return;
        }
        
        this.state.activeTrade.id = response.buy.contract_id;
        this.state.lastTradeTime = Date.now();
    }

    handleContractUpdate(response) {
        const contract = response.proposal_open_contract;
        if (!contract.is_sold || !this.state.activeTrade) return;

        const profit = parseFloat(contract.profit);
        const tradeDuration = Date.now() - this.state.activeTrade.startTime;
        
        this.analytics.totalTrades++;
        this.analytics.totalProfit += profit;
        this.analytics.dailyProfit += profit;
        this.analytics.profitHistory.push(profit);
        
        if (contract.status === "won") {
            this.handleWin(profit, tradeDuration);
        } else {
            this.handleLoss(profit, tradeDuration);
        }

        this.generateTradeReport(contract.status, profit);
        this.checkStopConditions();
        this.resetTrade();
    }

    handleWin(profit, duration) {
        this.analytics.totalWins++;
        this.analytics.currentWinStreak++;
        this.analytics.currentLossStreak = 0;
        
        if (this.analytics.currentWinStreak > this.analytics.maxWinStreak) {
            this.analytics.maxWinStreak = this.analytics.currentWinStreak;
        }

        this.state.martingaleStep = 0;
        this.state.currentStake = this.config.baseStake;
    }

    handleLoss(profit, duration) {
        this.analytics.totalLosses++;
        this.analytics.currentLossStreak++;
        this.analytics.currentWinStreak = 0;
        
        if (this.analytics.currentLossStreak > this.analytics.maxLossStreak) {
            this.analytics.maxLossStreak = this.analytics.currentLossStreak;
        }

        this.state.martingaleStep++;
        if (this.state.martingaleStep <= this.config.maxMartingaleSteps) {
            this.state.currentStake = this.config.baseStake * 
                Math.pow(this.config.martingaleMultiplier, this.state.martingaleStep);
        } else {
            console.log("⚠️ Max Martingale Steps Reached! Resetting...");
            this.state.martingaleStep = 0;
            this.state.currentStake = this.config.baseStake;
        }
    }

    generateTradeReport(status, profit) {
        const winRate = (this.analytics.totalWins / this.analytics.totalTrades * 100).toFixed(1);
        const avgProfit = (this.analytics.totalProfit / this.analytics.totalTrades).toFixed(2);
        
        console.log("\n📈 TRADE REPORT");
        console.log("══════════════════════════════════════");
        console.log(`Outcome: ${status === "won" ? 'WON' : 'LOST'} $${Math.abs(profit).toFixed(2)}`);
        console.log(`Trades: ${this.analytics.totalTrades} | Wins: ${this.analytics.totalWins} | Losses: ${this.analytics.totalLosses}`);
        console.log(`Win Rate: ${winRate}% | Avg. Profit: $${avgProfit}`);
        console.log(`Current Streak: ${status === "won" ? this.analytics.currentWinStreak : this.analytics.currentLossStreak}`);
        console.log(`Daily Profit: $${this.analytics.dailyProfit.toFixed(2)} | Total Profit: $${this.analytics.totalProfit.toFixed(2)}`);
        console.log("══════════════════════════════════════\n");
    }

    resetTrade() {
        this.state.activeTrade = null;
        this.state.lastThreeDigits = [];
    }

    checkStopConditions() {
        if (this.analytics.dailyProfit >= this.config.takeProfit) {
            console.log(`\n🎯 Take Profit Reached: $${this.config.takeProfit}!`);
            this.stopBot();
        }
        
        if (this.analytics.totalProfit <= this.config.stopLoss) {
            console.log(`\n🛑 Stop Loss Triggered: $${this.config.stopLoss}!`);
            this.stopBot();
        }
    }

    stopBot() {
        console.log("\n🛑 Stopping bot...");
        this.state.active = false;

        this.ws.send(JSON.stringify({
            ticks: this.config.symbol,
            subscribe: 0
        }));

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }

        this.generateFinalReport();
        setTimeout(() => process.exit(0), 1000);
    }

    generateFinalReport() {
        const sessionDuration = Date.now() - this.analytics.startTime;
        const hours = Math.floor(sessionDuration / (1000 * 60 * 60));
        const minutes = Math.floor((sessionDuration % (1000 * 60 * 60)) / (1000 * 60));
        
        console.log("\n📊 FINAL SESSION REPORT");
        console.log("══════════════════════════════════════");
        console.log(`Session Duration: ${hours}h ${minutes}m`);
        console.log(`Total Trades: ${this.analytics.totalTrades} | W/R: ${(this.analytics.totalWins / this.analytics.totalTrades * 100).toFixed(1)}%`);
        console.log(`Daily Profit: $${this.analytics.dailyProfit.toFixed(2)} | Total Profit: $${this.analytics.totalProfit.toFixed(2)}`);
        console.log(`Max Drawdown: $${Math.min(...this.analytics.profitHistory).toFixed(2)} | Best Trade: $${Math.max(...this.analytics.profitHistory).toFixed(2)}`);
        console.log("══════════════════════════════════════\n");
    }
}

// Initialize and run the enhanced bot
new EnhancedDigitBot();