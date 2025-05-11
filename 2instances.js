const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();

// Stake Progression Data (9 levels)
const STAKE_A = [0.35, 0.45, 1.1, 2.6, 6.1, 14.2, 33.2, 78, 182];
const STAKE_B = [0.45, 0.64, 1.57, 3.72, 8.72, 20.31, 47.48, 111.54, 260.26];
const PROFIT_IF_WIN = [0.06, 0.01, 0.03, 0.06, 0.08, 0.12, 0.22, 0.66, 1.21];

class TradingInstance {
    constructor(name, parentBot, strategyType) {
        this.name = name;
        this.parentBot = parentBot;
        this.strategyType = strategyType;

        this.roundIndex = 0;
        this.activeTrade = null;
        this.stopped = false;

        // Digit streak tracking
        this.oddStreak = { count: 0, digits: [], traded: false };
        this.evenStreak = { count: 0, digits: [], traded: false };
    }

    log(message) {
        const prefix = this.name === 'A' ? '\x1b[96m' : '\x1b[95m';
        console.log(`${prefix}[${this.name}] ${message}\x1b[0m`);
    }

    getLastDigit(price) {
        // More robust digit extraction
        const priceStr = parseFloat(price).toFixed(2);
        if (!priceStr.includes('.')) return 0; // Handle whole numbers
        const decimalPart = priceStr.split('.')[1];
        return parseInt(decimalPart.slice(-1), 10);
    }

    isOdd(digit) {
        return digit % 2 !== 0;
    }

    isEven(digit) {
        return digit % 2 === 0;
    }

    getContractType(streakType) {
        if (this.strategyType === 'normal') {
            return streakType === 'odd' ? 'DIGITODD' : 'DIGITEVEN';
        } else {
            return streakType === 'odd' ? 'DIGITEVEN' : 'DIGITODD';
        }
    }

    getCurrentStake() {
        return this.name === 'A' ? STAKE_A[this.roundIndex] : STAKE_B[this.roundIndex];
    }

    executeTrade(streakType) {
        if (this.activeTrade || this.stopped) return;
        
        if (!this.parentBot.authorized) {
            this.log('\x1b[91mCannot trade - Not authorized\x1b[0m');
            return;
        }

        const stake = parseFloat(this.getCurrentStake().toFixed(2));
        
        if (stake > this.parentBot.balance) {
            this.log(`\x1b[91mInsufficient balance: Need $${stake} | Available $${this.parentBot.balance}\x1b[0m`);
            this.parentBot.stop();
            return;
        }

        this.activeTrade = {
            contractType: this.getContractType(streakType),
            stake,
            streakType,
            roundIndex: this.roundIndex,
            startTick: this.parentBot.lastTick // Store the tick when trade was placed
        };

        this.log(`\x1b[92mPLACING TRADE: ${this.activeTrade.contractType} with $${stake.toFixed(2)} stake | Round: ${this.roundIndex + 1}\x1b[0m`);
        this.parentBot.sendTradeRequest(this.activeTrade);
    }

    resolveTrade(tick) {
        if (!this.activeTrade || this.stopped) return;

        // Wait for the next tick after trade placement to determine result
        if (tick.epoch <= this.activeTrade.startTick.epoch) return;

        const digit = this.getLastDigit(tick.quote);
        const trade = this.activeTrade;
        const isWin = (trade.contractType === 'DIGITEVEN' && this.isEven(digit)) ||
                      (trade.contractType === 'DIGITODD' && this.isOdd(digit));

        if (isWin) {
            if (this.name === 'B') {
                // Instance B WIN = RESET to Round 1 + Take Profit
                this.parentBot.addProfit(trade.roundIndex);
                this.parentBot.instanceA.roundIndex = 0;
                this.parentBot.instanceB.roundIndex = 0;
                this.parentBot.log(`\x1b[93m[B WIN] Both instances reset to Round 1 | Profit: $${PROFIT_IF_WIN[trade.roundIndex].toFixed(4)}\x1b[0m`);
            } else {
                // Instance A WIN = PROGRESS to next round
                if (this.roundIndex < STAKE_A.length - 1) {
                    this.parentBot.instanceA.roundIndex++;
                    this.parentBot.instanceB.roundIndex++;
                    this.parentBot.log(`\x1b[96m[A WIN] Both instances moved to Round ${this.parentBot.instanceA.roundIndex + 1}\x1b[0m`);
                }
            }

            this.log(`\x1b[92mWIN: Round ${trade.roundIndex + 1} | Digit: ${digit}\x1b[0m`);
        } else {
            // On loss - do not reset, just continue with current round
            this.log(`\x1b[91mLOSS: Round ${trade.roundIndex + 1} | Digit: ${digit}\x1b[0m`);
        }

        this.activeTrade = null;
    }

    stop() {
        this.stopped = true;
        this.log(`\x1b[94mINSTANCE STOPPED\x1b[0m`);
    }
}

class StreakReversalBot {
    constructor() {
        this.ws = null;
        this.app_id = process.env.DERIV_APP_ID || "1089";
        this.symbol = process.env.DERIV_SYMBOL || "1HZ10V";
        this.api_token = process.env.DERIV_API_TOKEN || "sEcAT5qfmp52HYX";

        this.tickCount = 0;
        this.authorized = false;
        this.balance = 0;
        this.startingBalance = 0;
        this.lastTick = null;

        // Initialize instances
        this.instanceA = new TradingInstance('A', this, 'normal');
        this.instanceB = new TradingInstance('B', this, 'reverse');

        // Profit tracking (only from Instance B wins)
        this.totalProfit = 0;
        this.profitTarget = 0.3; // $0.30 profit target

        // Log file
        this.logFile = 'streak_reversal_bot.log';
        this.initLogFile();

        // Connect
        this.connect();
    }

    initLogFile() {
        const header = `Streak Reversal Bot\nStarted at: ${new Date().toISOString()}\n`;
        fs.writeFileSync(this.logFile, header, 'utf8');
    }

    connect() {
        this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
        
        this.ws.on('open', () => {
            this.log('Connected to Deriv WS API');
            this.ws.send(JSON.stringify({ 
                authorize: this.api_token 
            }));
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());

                if (response.error) {
                    this.log(`\x1b[91mError: ${response.error.message}\x1b[0m`);
                    if (response.error.code === 'AuthorizationFailed') {
                        process.exit(1);
                    }
                    return;
                }

                switch(response.msg_type) {
                    case "authorize":
                        this.handleAuthorization(response);
                        break;
                    case "balance":
                        this.handleBalanceUpdate(response);
                        break;
                    case "tick":
                        if (response.tick) this.processTick(response.tick);
                        break;
                    case "buy":
                        this.handleBuyResponse(response);
                        break;
                }
            } catch (error) {
                this.log(`Error processing message: ${error.message}`);
            }
        });

        this.ws.on('close', () => {
            this.log('Connection closed - reconnecting in 5 seconds...');
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            this.log(`WebSocket error: ${err.message}`);
        });
    }

    handleAuthorization(response) {
        this.authorized = true;
        this.balance = response.authorize.balance;
        this.startingBalance = this.balance;
        this.log(`Authorization successful | Balance: $${this.balance}`);
        
        this.ws.send(JSON.stringify({
            balance: 1,
            subscribe: 1
        }));
        
        this.subscribeToTicks();
    }

    handleBalanceUpdate(response) {
        this.balance = response.balance.balance;
        this.log(`Balance updated: $${this.balance}`);
    }

    subscribeToTicks() {
        this.ws.send(JSON.stringify({
            ticks: this.symbol,
            subscribe: 1
        }));
    }

    sendTradeRequest(trade) {
        if (!this.authorized) {
            this.log('\x1b[91mCannot send trade - Not authorized\x1b[0m');
            return;
        }

        const request = {
            buy: 1,
            price: trade.stake,
            parameters: {
                amount: trade.stake,
                basis: "stake",
                contract_type: trade.contractType,
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: this.symbol
            }
        };
        
        this.log(`Sending trade: ${JSON.stringify(request)}`);
        this.ws.send(JSON.stringify(request));
    }

    handleBuyResponse(response) {
        if (response.error) {
            this.log(`\x1b[91mTRADE ERROR: ${response.error.message}\x1b[0m`);
            if (this.instanceA.activeTrade) this.instanceA.activeTrade = null;
            if (this.instanceB.activeTrade) this.instanceB.activeTrade = null;
            return;
        }

        this.log(`\x1b[92mTRADE CONFIRMED (ID: ${response.buy.contract_id})\x1b[0m`);
        this.ws.send(JSON.stringify({ balance: 1 }));
    }

    processTick(tick) {
        this.tickCount++;
        this.lastTick = tick;
        const digit = this.instanceA.getLastDigit(tick.quote);
        const isOdd = this.instanceA.isOdd(digit);
        const isEven = !isOdd;

        const price = parseFloat(tick.quote).toFixed(2);
        this.log(`Tick ${this.tickCount} | Price: ${price} | Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})`);

        // Resolve any active trades first
        this.instanceA.resolveTrade(tick);
        this.instanceB.resolveTrade(tick);

        // Then process new potential trades
        this.processInstance(this.instanceA, isOdd, isEven, digit);
        this.processInstance(this.instanceB, isOdd, isEven, digit);
    }

    processInstance(instance, isOdd, isEven, digit) {
        if (instance.stopped || instance.activeTrade) return;

        if (isOdd) {
            if (instance.evenStreak.count > 0) {
                instance.evenStreak = { count: 0, digits: [], traded: false };
            }
            if (!instance.oddStreak.traded) {
                instance.oddStreak.count++;
                instance.oddStreak.digits.push(digit);
                if (instance.oddStreak.count === 3 && !instance.oddStreak.traded) {
                    instance.executeTrade('odd');
                }
            }
        } else if (isEven) {
            if (instance.oddStreak.count > 0) {
                instance.oddStreak = { count: 0, digits: [], traded: false };
            }
            if (!instance.evenStreak.traded) {
                instance.evenStreak.count++;
                instance.evenStreak.digits.push(digit);
                if (instance.evenStreak.count === 3 && !instance.evenStreak.traded) {
                    instance.executeTrade('even');
                }
            }
        }
    }

    addProfit(roundIndex) {
        if (roundIndex >= PROFIT_IF_WIN.length) return;
        this.totalProfit += PROFIT_IF_WIN[roundIndex];
        this.log(`\x1b[92mTOTAL PROFIT: $${this.totalProfit.toFixed(4)}\x1b[0m`);
        
        if (this.totalProfit >= this.profitTarget) {
            this.shutdown();
        }
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(this.logFile, logMessage, 'utf8');
        console.log(logMessage.trim());
    }

    stop() {
        this.log('\x1b[94mSTOPPING BOT\x1b[0m');
        if (this.ws) this.ws.close();
    }

    shutdown() {
        this.log('\x1b[94mBOT SHUTDOWN: Profit Target Reached\x1b[0m');
        this.log(`Final Profit: $${this.totalProfit.toFixed(4)} | Balance: $${this.balance.toFixed(2)}`);
        
        if (this.ws) this.ws.close();
        process.exit(0);
    }
}

// Start the bot
const bot = new StreakReversalBot();

process.on('SIGINT', () => {
    bot.log('\x1b[91mManual shutdown triggered\x1b[0m');
    process.exit(0);
});