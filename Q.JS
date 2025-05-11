const WebSocket = require('ws');
const fs = require('fs');

const SYMBOL = "1HZ100V"; // Volatility 100 Index, adjust as needed
const MULTIPLIER = 100; // Adjust based on tick quote precision

class DerivBot {
    constructor() {
        this.ws = null;
        this.app_id = "1089"; // Replace with your Deriv app ID
        this.api_token = "sEcAT5qfmp52HYX"; // Replace with your actual API token
        this.logFile = 'patterns.log';
        this.isWaitingForResults = false;
        this.isStopped = false;

        // Martingale configuration
        this.maxLevels = 6;
        this.martingaleMultiplier = 1.00;
        this.currentMultiplier = 1;
        this.consecutiveLosses = 0;

        // Profit and trade tracking
        this.totalProfit = 0; // Local profit tracking
        this.takeProfitTarget = 10003;
        this.trades = 0;
        this.totalLosses = 0;
        this.cumulativeStakes = 0;

        // Recognized patterns and their predictions
        this.patterns = {
            "01234": 5,
            "12345": 6,
            "23456": 7,
            "34567": 8,
            "45678": 9
        };

        // Active trade
        this.activeTrade = null;
        this.currentStake = 0;
        this.currentPrediction = null;

        // Tick history
        this.tickHistory = [];

        // Trading configuration
        this.tradingConfig = {
            digitDiffers: {
                baseStake: 145.00 // Set your base stake value here
            }
        };

        this.run();
    }

    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    async run() {
        this.log("🚀 Starting Deriv Bot...");
        await this.connect();
        await this.fetchHistory();
        this.subscribeToTicks();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
            this.ws.on('open', () => {
                this.log("🔗 Connected to Deriv API");
                this.waitForOpen(() => {
                    this.authenticate();
                    resolve();
                });
            });
            this.ws.on('message', (data) => this.handleMessage(data));
            this.ws.on('error', (error) => {
                this.log(`❌ WebSocket Error: ${error}`);
                reject(error);
            });
            this.ws.on('close', () => {
                this.log("WebSocket closed");
            });
        });
    }

    waitForOpen(callback) {
        if (this.ws.readyState === WebSocket.OPEN) {
            callback();
        } else {
            setTimeout(() => this.waitForOpen(callback), 100);
        }
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
                    this.log("📜 Fetched historical data");
                    resolve();
                }
            };
            this.ws.on('message', handler);
        });
    }

    subscribeToTicks() {
        this.ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));
        this.log("🔔 Subscribed to real-time ticks");
    }

    handleMessage(data) {
        const response = JSON.parse(data);
        switch (response.msg_type) {
            case "authorize":
                this.log("🔑 Authentication successful");
                break;
            case "tick":
                if (response.tick && typeof response.tick.quote !== 'undefined') {
                    this.processTick(response.tick);
                } else {
                    this.log("⚠️ Invalid tick data received: " + JSON.stringify(response));
                }
                break;
            case "buy":
                this.handleBuyResponse(response);
                break;
            case "proposal_open_contract":
                this.handleContractUpdate(response);
                break;
            default:
                this.log("Unhandled message type: " + response.msg_type);
                break;
        }
    }

    processTick(tick) {
        if (this.shouldStop()) return;

        const quote = parseFloat(tick.quote);
        const currentDigit = Math.floor((quote * MULTIPLIER) % 10);
        this.log(`🕒 Tick Update | Last Digit: ${currentDigit}`);

        this.tickHistory.push(currentDigit);
        if (this.tickHistory.length > 30) {
            this.tickHistory.shift();
        }

        if (this.tickHistory.length >= 3 && !this.isWaitingForResults) {
            const lastThree = this.tickHistory.slice(-3);
            const pattern = lastThree.join('');
            if (this.patterns[pattern] !== undefined) {
                this.currentPrediction = this.patterns[pattern];
                this.log(`📊 Pattern Detected: ${pattern}, Predicting: ${this.currentPrediction}`);
                this.logPattern(lastThree);
                this.executeTrade(lastThree);
            }
        }
    }

    shouldStop() {
        if (this.isStopped) return true;
        const currentTotalProfit = Math.round(this.totalProfit * 100) / 100;
        if (currentTotalProfit >= this.takeProfitTarget) {
            this.log(`🎯 TAKE PROFIT HIT: $${this.takeProfitTarget} REACHED!`);
            this.stopBot();
            return true;
        }
        return false;
    }

    executeTrade(lastThree) {
        this.isWaitingForResults = true;
        this.currentStake = this.getStake();

        this.cumulativeStakes += parseFloat(this.currentStake);

        this.ws.send(JSON.stringify({
            buy: 1,
            subscribe: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: SYMBOL,
                barrier: this.currentPrediction.toString()
            }
        }));

        this.trades += 1;
        this.log(`📊 Placed Trade (Pattern: [${lastThree.join(', ')}]):\n        ╔══════════════════════════╗\n        ║ DIGIT MATCH ${this.currentPrediction} @ $${this.currentStake} ║\n        ╚══════════════════════════╝`);
    }

    handleBuyResponse(response) {
        if (this.isStopped) return;
        if (response.error) {
            this.log(`❌ Trade Error: ${response.error.message}`);
            this.resetTrades();
            return;
        }

        if (!this.activeTrade) {
            this.log("⚠️ activeTrade undefined in handleBuyResponse, reinitializing...");
            this.activeTrade = null;
        }

        this.log(`📥 Buy Response: DIGITMATCH - Contract ID: ${response.buy.contract_id}`);
        this.activeTrade = response.buy.contract_id;
    }

    calculateTradeProfit(contract, stake) {
        const payout = parseFloat(contract.payout) || 0;
        const buyPrice = parseFloat(contract.buy_price) || stake;
        return contract.status === "won" ? payout - buyPrice : -buyPrice;
    }

    handleContractUpdate(response) {
        if (this.isStopped) return;
        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;

        const profit = this.calculateTradeProfit(contract, this.currentStake);

        if (!this.activeTrade) {
            this.log("⚠️ activeTrade undefined in handleContractUpdate, reinitializing...");
            this.activeTrade = null;
        }

        this.activeTrade = { status: contract.status, profit: profit, payout: parseFloat(contract.payout) || 0 };

        if (contract.status === "lost") {
            this.totalLosses += parseFloat(this.currentStake);
        }

        const totalStakeThisRound = parseFloat(this.currentStake);
        const totalReturn = contract.status === "won" ? totalStakeThisRound + profit : 0;
        const combinedProfit = (contract.status === "lost") 
            ? -totalStakeThisRound 
            : (this.consecutiveLosses > 0 ? totalReturn - this.cumulativeStakes : totalReturn - totalStakeThisRound);

        if (combinedProfit > 0) {
            this.totalProfit += combinedProfit;
        }

        this.displayResults();
        this.updateMartingale();
        this.resetTrades();

        this.shouldStop();
    }

    displayResults() {
        const profit = this.activeTrade ? this.activeTrade.profit : 0;
        const totalStakeThisRound = parseFloat(this.currentStake);
        const totalReturn = this.activeTrade && this.activeTrade.status === "won" ? totalStakeThisRound + profit : 0;
        const combinedProfit = (this.activeTrade && this.activeTrade.status === "lost") 
            ? -totalStakeThisRound 
            : (this.consecutiveLosses > 0 ? totalReturn - this.cumulativeStakes : totalReturn - totalStakeThisRound);

        this.log(`📈 Trade Results:
        ╔════════════════════════════════════════╗
        ║ DIGIT MATCH: ${this.activeTrade ? (this.activeTrade.status === "won" ? "✅ WON" : "❌ LOST") : "N/A"} (${profit > 0 ? '+' : ''}$${profit.toFixed(2)}) ║
        ╟────────────────────────────────────────╢
        ║ Total Stake This Round: $${totalStakeThisRound.toFixed(2)}                     ║
        ║ Cumulative Stakes: $${this.cumulativeStakes.toFixed(2)}                     ║
        ║ Total Return: $${totalReturn.toFixed(2)}                     ║
        ║ Trade Profit: ${combinedProfit > 0 ? '+' : ''}$${combinedProfit.toFixed(2)}              ║
        ║ Total Profit (Positive Only): ${this.totalProfit > 0 ? '+' : ''}$${this.totalProfit.toFixed(2)}              ║
        ╚════════════════════════════════════════╝`);
    }

    updateMartingale() {
        const status = this.activeTrade ? this.activeTrade.status : "won";
        if (status === "lost") {
            this.consecutiveLosses++;
            if (this.consecutiveLosses <= this.maxLevels) {
                this.currentMultiplier = Math.pow(this.martingaleMultiplier, this.consecutiveLosses);
                this.log(`📉 Loss Detected: Consecutive Losses: ${this.consecutiveLosses}, New Multiplier: ${this.currentMultiplier.toFixed(2)}x`);
            } else {
                this.currentMultiplier = 1;
                this.consecutiveLosses = 0;
                this.cumulativeStakes = 0;
                this.log("🔄 Max Martingale levels reached. Resetting multiplier and cumulative stakes.");
            }
        } else {
            this.consecutiveLosses = 0;
            this.currentMultiplier = 1;
            this.cumulativeStakes = 0;
            this.log("🎉 Win: Resetting Martingale multiplier and cumulative stakes to 1x");
        }
    }

    resetTrades() {
        this.isWaitingForResults = false;
        this.activeTrade = null;
        this.currentStake = 0;
        this.currentPrediction = null;
        this.log("🔄 Trade reset.");
    }

    stopBot() {
        if (this.isStopped) return;
        this.log("🛑 Stopping bot...");
        this.isStopped = true;
        this.ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 0 }));
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
        setTimeout(() => process.exit(0), 1000);
    }

    getStake() {
        return (this.tradingConfig.digitDiffers.baseStake * this.currentMultiplier).toFixed(2);
    }

    logPattern(sequence) {
        const pattern = sequence.join('');
        const length = sequence.length;
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp} Detected pattern of ${length} connective digits: ${pattern}\n`;
        fs.appendFile(this.logFile, logMessage, (err) => {
            if (err) {
                console.error(`Error writing to log file: ${err}`);
            }
        });
    }
}

const bot = new DerivBot();
bot.run().catch(error => console.error(error));