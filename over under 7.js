const WebSocket = require('ws');

// ======================
//    CONFIGURATION
// ======================
const APP_ID = "1089";
const API_TOKEN = "CDhyUERTio77vpQ";
const TICK_HISTORY_COUNT = 1000;
const RECONNECT_INTERVAL = 5000;
const MARKET = 'R_10';
const MINIMUM_STAKE = 0; // No minimum stake limit
const MAXIMUM_STAKE = Infinity; // No maximum stake limit
const BARRIER = 7;
const CONTRACT_TIMEOUT = 10000;
const ONE_HOUR_MS = 60 * 60 * 1000; // One hour in milliseconds

// Map of markets to expected decimal digits
const DECIMAL_DIGITS = {
    'R_10': 2
};

// ======================
//    DerivBot Class
// ======================
class DerivBot {
    constructor() {
        this.ws = null;
        this.tickHistory = [];
        this.lastDigits = [];
        this.waitTicks = 0;
        this.isWaiting = false;
        this.contractId = null;
        this.balance = 0; // Balance will be set by API
        this.tradeCount = 0;
        this.winCount = 0;
        this.startTime = Date.now();
        this.contractTimeouts = new Map();
        this.isAuthenticated = false;
        this.lastProposalPayout = null;
        this.lastTradeTime = null;
        this.isFirstTrade = true;
        this.run();
    }

    log(message) {
        const timestamp = new Date().toLocaleString();
        console.log(`[${timestamp}] ${message}`);
    }

    formatElapsedTime() {
        const elapsedMs = Date.now() - this.startTime;
        const seconds = Math.floor((elapsedMs / 1000) % 60);
        const minutes = Math.floor((elapsedMs / (1000 * 60)) % 60);
        const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    async run() {
        this.log(`Starting Deriv Bot (App ID: ${APP_ID}) for Under 7 trades on ${MARKET}`);
        await this.connect();
        // Schedule first trade with random delay (0 to 1 hour)
        const randomDelay = Math.random() * ONE_HOUR_MS;
        this.log(`Scheduling first trade in ${(randomDelay / 1000 / 60).toFixed(2)} minutes`);
        setTimeout(() => {
            this.isFirstTrade = false;
            this.log("First trade ready to be placed upon meeting conditions");
        }, randomDelay);
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
            this.ws.on('open', () => {
                this.log("Connected to Deriv API");
                this.authenticate();
                resolve();
            });
            this.ws.on('message', (data) => this.handleMessage(data));
            this.ws.on('close', () => {
                this.log(`Connection closed. Reconnecting in ${RECONNECT_INTERVAL / 1000} seconds...`);
                this.isAuthenticated = false;
                setTimeout(() => this.connect(), RECONNECT_INTERVAL);
            });
            this.ws.on('error', (err) => {
                this.log(`WebSocket error: ${err.message}`);
                reject(err);
                this.ws.close();
            });
        });
    }

    authenticate() {
        this.ws.send(JSON.stringify({ authorize: API_TOKEN }));
    }

    fetchBalance() {
        this.ws.send(JSON.stringify({
            balance: 1,
            subscribe: 1
        }));
    }

    fetchHistory() {
        this.log(`Fetching history for ${MARKET}`);
        this.ws.send(JSON.stringify({
            ticks_history: MARKET,
            count: TICK_HISTORY_COUNT,
            end: "latest",
            style: "ticks"
        }));
    }

    subscribeToTicks() {
        this.ws.send(JSON.stringify({ ticks: MARKET, subscribe: 1 }));
    }

    subscribeToContract(contractId) {
        this.log(`Subscribing to contract updates for Contract ID: ${contractId}`);
        this.ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        }));
    }

    requestProposal() {
        this.stake = this.balance; // Stake is always the full balance
        if (this.stake <= 0 || this.stake > this.balance) {
            this.log(`Invalid stake $${this.stake.toFixed(2)} (Balance: $${this.balance.toFixed(2)}). Stopping bot.`);
            this.ws.close();
            return;
        }
        this.log(`Preparing Trade ${this.tradeCount + 1}: Setting stake to full balance $${this.stake.toFixed(2)}`);
        this.log(`Requesting proposal for Under 7 trade on ${MARKET} with stake $${this.stake.toFixed(2)}`);
        this.ws.send(JSON.stringify({
            proposal: 1,
            amount: this.stake,
            barrier: BARRIER.toString(),
            basis: "stake",
            contract_type: "DIGITUNDER",
            duration: 1,
            duration_unit: "t",
            symbol: MARKET,
            currency: "USD",
            passthrough: { trade_id: Date.now() }
        }));
    }

    buyContract(proposalId, price) {
        this.log(`Placing Under 7 trade (Trade ${this.tradeCount + 1}) for $${this.stake.toFixed(2)} on ${MARKET}`);
        this.ws.send(JSON.stringify({
            buy: proposalId,
            price: parseFloat(price)
        }));
    }

    handleMessage(data) {
        try {
            const response = JSON.parse(data); // Fixed: Removed incorrect 'Akismet' reference
            switch (response.msg_type) {
                case "authorize":
                    if (response.error) {
                        this.log(`Authorization failed: ${response.error.message}`);
                        this.ws.close();
                        return;
                    }
                    this.log("Authorization successful");
                    this.isAuthenticated = true;
                    this.fetchBalance(); // Fetch balance after authorization
                    break;
                case "balance":
                    if (!this.isAuthenticated) return;
                    this.balance = response.balance.balance;
                    this.log(`Account balance updated: $${this.balance.toFixed(2)}`);
                    if (this.tradeCount === 0) {
                        this.fetchHistory(); // Fetch history after getting balance
                    }
                    break;
                case "history":
                    if (!this.isAuthenticated) return;
                    this.initializeTickHistory(response.history.prices);
                    this.subscribeToTicks();
                    break;
                case "tick":
                    if (!this.isAuthenticated) return;
                    this.processTick(response.tick);
                    break;
                case "proposal":
                    if (!this.isAuthenticated || !this.isWaiting || this.waitTicks !== 0) return;
                    if (response.error) {
                        this.log(`Proposal error: ${response.error.message}`);
                        this.isWaiting = false;
                        return;
                    }
                    const payout = response.proposal.payout;
                    const askPrice = response.proposal.ask_price;
                    this.lastProposalPayout = ((payout - askPrice) / askPrice) * 100;
                    this.log(`Proposal received: Payout percentage = ${this.lastProposalPayout.toFixed(2)}%`);
                    this.buyContract(response.proposal.id, response.proposal.ask_price);
                    break;
                case "buy":
                    if (response.error) {
                        this.log(`Buy error: ${response.error.message}`);
                        this.isWaiting = false;
                        return;
                    }
                    this.log(`Trade ${this.tradeCount + 1} placed successfully. Contract ID: ${response.buy.contract_id}`);
                    this.contractId = response.buy.contract_id;
                    this.tradeCount++;
                    this.lastTradeTime = Date.now(); // Update last trade time when trade is placed
                    this.subscribeToContract(this.contractId);
                    const timeoutId = setTimeout(() => {
                        if (this.contractId === response.buy.contract_id) {
                            this.log(`Timeout: No updates for Contract ID ${this.contractId}`);
                            this.contractTimeouts.delete(this.contractId);
                            this.contractId = null;
                            this.isWaiting = false;
                        }
                    }, CONTRACT_TIMEOUT);
                    this.contractTimeouts.set(this.contractId, timeoutId);
                    break;
                case "proposal_open_contract":
                    if (!this.isAuthenticated || !this.contractId) return;
                    if (response.proposal_open_contract.contract_id === this.contractId) {
                        const status = response.proposal_open_contract.is_sold ? "Closed" : "Open";
                        const profit = response.proposal_open_contract.profit || 0;
                        const isWin = profit > 0;
                        const entrySpot = response.proposal_open_contract.entry_spot;
                        const exitSpot = response.proposal_open_contract.exit_spot;
                        const entryDigit = entrySpot ? parseInt(entrySpot.toString().slice(-1)) : null;
                        const exitDigit = exitSpot ? parseInt(exitSpot.toString().slice(-1)) : entryDigit;

                        if (status === "Closed") {
                            if (isWin) {
                                this.log(`Trade won (Deriv API): Profit $${profit.toFixed(2)}, Exit digit ${exitDigit}, Entry digit ${entryDigit}`);
                            } else {
                                this.log(`Trade lost (Deriv API): Loss $${Math.abs(profit).toFixed(2)}, Exit digit ${exitDigit}, Entry digit ${entryDigit}`);
                            }
                        }

                        this.balance += profit;

                        this.log(`=== Trade ${this.tradeCount} Result ===`);
                        this.log(`Status: ${status}`);
                        this.log(`Entry Spot: ${entrySpot}, Exit Spot: ${exitSpot}`);
                        if (exitDigit !== null) this.log(`Outcome Digit: ${exitDigit}`);
                        this.log(`Profit/Loss (Deriv API): $${profit.toFixed(2)}`);
                        this.log(`New Balance: $${this.balance.toFixed(2)}`);
                        this.log(`New Stake for Next Trade: Full balance $${this.balance.toFixed(2)}`);
                        this.log(`============================`);

                        if (profit > 0) this.winCount++;
                        clearTimeout(this.contractTimeouts.get(this.contractId));
                        this.contractTimeouts.delete(this.contractId);
                        this.contractId = null;
                        this.isWaiting = false;
                    }
                    break;
                case "error":
                    this.log(`API Error: ${response.error.message}`);
                    if (response.error.code === "InvalidToken") {
                        this.log("Invalid API token. Please check your APP_ID and API_TOKEN.");
                        this.ws.close();
                    } else if (response.error.code === "InvalidStake") {
                        this.log("Trade rejected due to invalid stake. Check Deriv's minimum/maximum stake limits.");
                        this.isWaiting = false;
                    }
                    break;
                default:
                    this.log(`Unhandled message type: ${response.msg_type}`);
            }
        } catch (err) {
            this.log(`Error parsing message: ${err.message}`);
        }
    }

    extractLastDigit(price) {
        const expectedDigits = DECIMAL_DIGITS[MARKET] || 2;
        const priceStr = parseFloat(price).toFixed(expectedDigits);
        const lastDigit = parseInt(priceStr.slice(-1));
        this.log(`Extracted digit from ${priceStr}: Last Digit = ${lastDigit}`);
        return lastDigit;
    }

    initializeTickHistory(prices) {
        this.tickHistory = prices.map(price => this.extractLastDigit(price)).slice(-TICK_HISTORY_COUNT);
        this.lastDigits = this.tickHistory.slice(-2);
        this.log(`Initialized ${this.tickHistory.length} ticks for ${MARKET}`);
    }

    processTick(tick) {
        const digit = this.extractLastDigit(tick.quote);
        this.tickHistory.push(digit);
        if (this.tickHistory.length > TICK_HISTORY_COUNT) this.tickHistory.shift();

        this.lastDigits.push(digit);
        if (this.lastDigits.length > 2) this.lastDigits.shift();

        const now = Date.now();
        const canInitiateTrade = this.isFirstTrade || (this.lastTradeTime && (now - this.lastTradeTime) >= ONE_HOUR_MS);

        if (!canInitiateTrade) {
            const timeUntilNextTrade = ONE_HOUR_MS - (now - this.lastTradeTime);
            this.log(`Trade skipped: One trade per hour limit. Time until next trade: ${(timeUntilNextTrade / 1000 / 60).toFixed(2)} minutes`);
            return;
        }

        if (!this.isWaiting && !this.contractId && this.lastDigits.length === 2 && this.lastDigits[0] === 7 && this.lastDigits[1] === 8) {
            this.log(`Condition met: 7, 8 sequence detected. Waiting for 2 ticks before placing Trade ${this.tradeCount + 1}`);
            this.isWaiting = true;
            this.waitTicks = 2;
        }

        if (this.isWaiting) {
            this.waitTicks--;
            this.log(`Waiting... Ticks remaining: ${this.waitTicks}`);
            if (this.waitTicks === 0) {
                this.log(`Wait complete. Initiating Under 7 trade (Trade ${this.tradeCount + 1}) with stake = full balance $${this.balance.toFixed(2)}`);
                this.requestProposal();
            }
        }
    }
}

new DerivBot();