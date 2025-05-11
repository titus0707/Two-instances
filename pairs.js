const WebSocket = require('ws');

// Configuration
const APP_ID = "1089"; // Replace with your Deriv APP_ID
const API_TOKEN = "t27ChRVRi2o1pj3"; // Replace with your Deriv API_TOKEN
const BASE_STAKE = 100;
const TICK_HISTORY_COUNT = 1000;
const RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;
const TRADE_TIMEOUT = 10000;
const CHECK_INTERVAL = 3600000; // Hourly check

const MARKETS = [
    'JD100', 'JD75', 'JD50', 'JD25', 'JD10',
    'RDBULL', 'RDBEAR', 'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
];

const DECIMAL_DIGITS = {
    'JD100': 2, 'JD75': 2, 'JD50': 2, 'JD25': 2, 'JD10': 2,
    'RDBULL': 6, 'RDBEAR': 4, 'R_10': 3, 'R_25': 3, 'R_50': 4, 'R_75': 4, 'R_100': 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2
};

class TradingEnvironment {
    constructor(parent) {
        this.parent = parent;
        this.ws = null;
        this.tickHistories = {};
        this.digitFrequencies = {};
        this.isWaitingForResults = false;
        this.reconnectAttempts = 0;
        this.tradeTimeoutId = null;
        this.isSubscribedToTicks = new Set();
        this.lastDigits = {};
        this.marketStats = {};
        this.isActive = true;
        this.pendingHistoryRequests = new Set(); // Track pending history requests
        MARKETS.forEach(market => {
            this.tickHistories[market] = [];
            this.digitFrequencies[market] = Array(10).fill(0);
            this.marketStats[market] = { wins: 0, losses: 0, winRate: 0 };
        });
    }

    log(message) {
        this.parent.log(`[Env 1] ${message}`);
    }

    async connect() {
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.log("Max reconnect attempts reached. Shutting down this environment.");
            this.isActive = false;
            return Promise.reject(new Error("Max reconnect attempts exceeded"));
        }

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
                this.ws.on('open', () => {
                    this.reconnectAttempts = 0;
                    this.log("Connected to Deriv API");
                    this.authenticate();
                    resolve();
                });
                this.ws.on('message', (data) => {
                    try {
                        this.handleMessage(data);
                    } catch (err) {
                        this.log(`Error processing message: ${err.message}`);
                    }
                });
                this.ws.on('close', () => {
                    this.log("Connection closed. Attempting to reconnect...");
                    this.isSubscribedToTicks.clear();
                    this.reconnectWithBackoff();
                });
                this.ws.on('error', (err) => {
                    this.log(`WebSocket error: ${err.message}`);
                    if (err.code === 'ECONNRESET') {
                        this.log("Connection reset by peer. Reconnecting...");
                        this.ws.close();
                    }
                    reject(err);
                });
            } catch (err) {
                this.log(`Failed to create WebSocket: ${err.message}`);
                reject(err);
            }
        }).catch(err => {
            this.log(`Connection failed: ${err.message}`);
            this.reconnectWithBackoff();
        });
    }

    reconnectWithBackoff() {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.log("Max reconnect attempts reached. Environment stopped.");
            this.isActive = false;
            return;
        }
        const maxDelay = 30000;
        const delay = Math.min(RECONNECT_INTERVAL * Math.pow(1.5, this.reconnectAttempts), maxDelay);
        this.log(`Reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);
        setTimeout(() => this.connect(), delay);
    }

    authenticate() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ authorize: API_TOKEN }));
        } else {
            this.log("Cannot authenticate: WebSocket not open.");
        }
    }

    fetchHistory(market) {
        this.log(`Fetching history for ${market}`);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                ticks_history: market,
                count: TICK_HISTORY_COUNT,
                end: "latest",
                style: "ticks",
                req_id: market // Use market as req_id for tracking
            }));
            this.pendingHistoryRequests.add(market);
        }
    }

    subscribeToTicks(market) {
        if (!this.isActive || this.isSubscribedToTicks.has(market)) return;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ticks: market, subscribe: 1 }));
            this.isSubscribedToTicks.add(market);
            this.log(`Subscribed to ticks for ${market}`);
        }
    }

    handleMessage(data) {
        let response;
        try {
            response = JSON.parse(data);
        } catch (err) {
            this.log(`Failed to parse message: ${err.message}`);
            return;
        }
        if (!this.isActive && response.msg_type !== "authorize") return;
        switch (response.msg_type) {
            case "authorize":
                this.log("Authorization successful");
                MARKETS.forEach(market => this.fetchHistory(market));
                break;
            case "history":
                const market = response.req_id; // Use req_id to identify market
                if (!market || !MARKETS.includes(market)) {
                    this.log(`Invalid market in history response: ${market}`);
                    return;
                }
                if (response.error) {
                    this.log(`History fetch error for ${market}: ${response.error.message}`);
                    this.pendingHistoryRequests.delete(market);
                    return;
                }
                this.log(`Received history for ${market}`);
                this.initializeFrequencyData(market, response.history?.prices || []);
                this.pendingHistoryRequests.delete(market);
                this.subscribeToTicks(market);
                break;
            case "tick":
                if (this.isActive) this.processTick(response.tick);
                break;
            case "buy":
                this.handleBuyResponse(response);
                break;
            case "proposal_open_contract":
                this.handleContractUpdate(response);
                break;
            case "error":
                this.log(`API Error: ${response.error?.message || "Unknown error"}`);
                break;
        }
    }

    extractLastDigit(price, market) {
        const expectedDigits = DECIMAL_DIGITS[market] || 2;
        const priceStr = String(price);
        const parts = priceStr.split('.');
        let decimalPart = parts[1] || '0';
        if (decimalPart.length < expectedDigits) {
            decimalPart += '0'.repeat(expectedDigits - decimalPart.length);
        }
        return parseInt(decimalPart.slice(-1));
    }

    initializeFrequencyData(market, prices) {
        this.tickHistories[market] = prices.map(price => this.extractLastDigit(price, market)).slice(-TICK_HISTORY_COUNT);
        this.updateFrequencyDistribution(market);
    }

    processTick(tick) {
        if (!this.isActive || this.isWaitingForResults) {
            this.log("Tick received but not processed: inactive or waiting for results.");
            return;
        }
        const market = tick.symbol;
        const digit = this.extractLastDigit(tick.quote, market);
        this.lastDigits[market] = digit;
        this.tickHistories[market].push(digit);
        if (this.tickHistories[market].length > TICK_HISTORY_COUNT) this.tickHistories[market].shift();
        this.updateFrequencyDistribution(market);

        const { highestDigit: marketHighest, lowestDigit: marketLowest } = this.getExtremeDigits(market);
        this.log(`Tick processed for ${market}. Last digit: ${digit}, Highest: ${marketHighest}, Lowest: ${marketLowest}`);

        // Find matching market pairs
        for (const otherMarket of MARKETS) {
            if (otherMarket === market) continue;
            const { highestDigit: otherHighest, lowestDigit: otherLowest } = this.getExtremeDigits(otherMarket);
            if (marketHighest === otherHighest && marketLowest === otherLowest &&
                this.lastDigits[market] === marketHighest && this.lastDigits[otherMarket] === otherHighest) {
                this.log(`Pair found: ${market} and ${otherMarket} - Highest: ${marketHighest}, Lowest: ${marketLowest}`);
                this.executeTrade(market, marketLowest);
                this.executeTrade(otherMarket, marketLowest);
                break; // Trade only one pair at a time
            }
        }
    }

    updateFrequencyDistribution(market) {
        this.digitFrequencies[market].fill(0);
        this.tickHistories[market].forEach(digit => this.digitFrequencies[market][digit]++);
    }

    getExtremeDigits(market) {
        let maxCount = -Infinity, minCount = Infinity;
        let highestDigit = 0, lowestDigit = 0;
        this.digitFrequencies[market].forEach((count, digit) => {
            if (count > maxCount) { maxCount = count; highestDigit = digit; }
            if (count < minCount) { minCount = count; lowestDigit = digit; }
        });
        return { highestDigit, lowestDigit };
    }

    executeTrade(market, barrier) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.log("Cannot execute trade: WebSocket not open.");
            return;
        }
        if (BASE_STAKE > this.parent.capitalPool) {
            this.log(`Insufficient capital ($${this.parent.capitalPool.toFixed(2)}) for stake $${BASE_STAKE.toFixed(2)}.`);
            return;
        }
        this.isWaitingForResults = true;
        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: BASE_STAKE,
            parameters: {
                amount: BASE_STAKE,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: market,
                barrier: String(barrier)
            }
        };
        this.log(`Executing trade on ${market} with stake $${BASE_STAKE.toFixed(2)} and barrier ${barrier}`);
        try {
            this.ws.send(JSON.stringify(tradeRequest));
            this.tradeTimeoutId = setTimeout(() => {
                this.log(`Trade timed out for ${market}.`);
                this.isWaitingForResults = false;
            }, TRADE_TIMEOUT);
        } catch (err) {
            this.log(`Failed to send trade request for ${market}: ${err.message}`);
            this.isWaitingForResults = false;
        }
    }

    handleBuyResponse(response) {
        if (response.error) {
            this.log(`Buy error: ${response.error.message}`);
            this.isWaitingForResults = false;
            clearTimeout(this.tradeTimeoutId);
        }
    }

    handleContractUpdate(response) {
        const contract = response.proposal_open_contract;
        if (!contract.is_sold) return;
        clearTimeout(this.tradeTimeoutId);

        const profit = parseFloat(contract.profit || 0);
        const isWin = contract.status === "won";
        const market = contract.symbol;

        this.marketStats[market][isWin ? "wins" : "losses"]++;
        this.parent.updateProfit(profit);
        this.log(`Trade completed on ${market}: ${isWin ? "Win" : "Loss"}, Profit: $${profit.toFixed(2)}`);
        this.isWaitingForResults = false;
    }
}

class DerivBot {
    constructor() {
        this.env1 = new TradingEnvironment(this);
        this.ws = null;
        this.capitalPool = null;
        this.totalProfit = 0;
        this.hourlyProfit = 0;
        this.dailyProfit = 0;
        this.cumulativeHourlyProfits = 0;
        this.cumulativeDailyProfits = 0;
        this.hourStart = Date.now();
        this.dayStart = Date.now();
        this.startTime = null;
        this.balanceReceived = null;
        this.run();
    }

    log(message) {
        console.log(`[${new Date().toLocaleString()}] ${message}`);
    }

    async run() {
        this.log("Starting Deriv Bot with 1 Environment");
        await this.connectBalanceWebSocket();
        await this.waitForInitialBalance();
        this.log("Initial balance received. Starting trading environment...");
        try {
            await this.env1.connect();
            this.scheduleHourlyCheck();
        } catch (err) {
            this.log(`Failed to start trading environment: ${err.message}`);
        }
    }

    connectBalanceWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
                this.ws.on('open', () => {
                    this.log("Balance WebSocket connected");
                    this.ws.send(JSON.stringify({ authorize: API_TOKEN }));
                    resolve();
                });
                this.ws.on('message', (data) => {
                    try {
                        this.handleBalanceMessage(data);
                    } catch (err) {
                        this.log(`Error processing balance message: ${err.message}`);
                    }
                });
                this.ws.on('close', () => {
                    this.log("Balance WebSocket closed. Reconnecting...");
                    this.connectBalanceWebSocket();
                });
                this.ws.on('error', (err) => {
                    this.log(`Balance WebSocket error: ${err.message}`);
                    if (err.code === 'ECONNRESET') {
                        this.log("Balance connection reset. Reconnecting...");
                        this.ws.close();
                    }
                    reject(err);
                });
            } catch (err) {
                this.log(`Failed to create balance WebSocket: ${err.message}`);
                reject(err);
            }
        }).catch(err => {
            this.log(`Balance WebSocket connection failed: ${err.message}`);
            setTimeout(() => this.connectBalanceWebSocket(), RECONNECT_INTERVAL);
        });
    }

    waitForInitialBalance() {
        return new Promise((resolve) => {
            this.balanceReceived = resolve;
        });
    }

    handleBalanceMessage(data) {
        let response;
        try {
            response = JSON.parse(data);
        } catch (err) {
            this.log(`Failed to parse balance message: ${err.message}`);
            return;
        }
        switch (response.msg_type) {
            case "authorize":
                this.log("Balance WebSocket authorized");
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
                }
                break;
            case "balance":
                this.capitalPool = parseFloat(response.balance.balance);
                this.log(`Live account balance updated: $${this.capitalPool.toFixed(2)}`);
                if (!this.startTime) {
                    this.startTime = Date.now();
                    if (this.balanceReceived) {
                        this.balanceReceived();
                        this.balanceReceived = null;
                    }
                }
                break;
            case "error":
                this.log(`Balance API Error: ${response.error.message}`);
                break;
        }
    }

    updateProfit(profit) {
        this.totalProfit += profit;
        this.hourlyProfit += profit;
        this.dailyProfit += profit;
        this.displayProfitUpdate();
    }

    displayProfitUpdate() {
        console.log("\nProfit Update:");
        console.log(`    Capital Pool (Live Balance): $${this.capitalPool ? this.capitalPool.toFixed(2) : 'N/A'}`);
        console.log(`    Hourly: $${this.hourlyProfit.toFixed(2)}`);
        console.log(`    Daily: $${this.dailyProfit.toFixed(2)}`);
        console.log(`    Total: $${this.totalProfit.toFixed(2)}`);
    }

    scheduleHourlyCheck() {
        setInterval(() => {
            if (Date.now() - this.hourStart >= CHECK_INTERVAL) {
                this.cumulativeHourlyProfits += this.hourlyProfit;
                this.hourlyProfit = 0;
                this.hourStart = Date.now();
            }
            if (Date.now() - this.dayStart >= CHECK_INTERVAL * 24) {
                this.cumulativeDailyProfits += this.dailyProfit;
                this.dailyProfit = 0;
                this.dayStart = Date.now();
            }
        }, 60000);
    }
}

new DerivBot();