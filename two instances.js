const WebSocket = require('ws');
const fs = require('fs');

class TradingInstance {
    constructor(name, parentBot, strategyType) {
        this.name = name;
        this.parentBot = parentBot;
        this.strategyType = strategyType; // 'normal' or 'reverse'

        // Trading parameters
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.martingaleMultiplier = 2.06;

        // Digit tracking
        this.oddStreak = { count: 0, digits: [], traded: false, lost: false };
        this.evenStreak = { count: 0, digits: [], traded: false, lost: false };

        // Trade tracking
        this.activeTrade = null;

        // Results tracking
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalProfit = 0;

        // State
        this.stopped = false;
    }

    log(message) {
        const prefix = this.name === 'A' ? '\x1b[36m' : '\x1b[35m';
        console.log(`${prefix}[${this.name}] ${message}\x1b[0m`);
    }

    getLastDigit(price) {
        return parseInt(parseFloat(price).toFixed(2).slice(-1), 10);
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

    executeTrade(streakType) {
        if (this.activeTrade || this.stopped) return;

        this.totalTrades++;
        this.activeTrade = {
            contractType: this.getContractType(streakType),
            stake: this.currentStake,
            digitAfter: null,
            streakType,
        };

        this.log(`\x1b[32mPLACING TRADE: ${this.activeTrade.contractType} with $${this.currentStake.toFixed(2)} stake\x1b[0m`);

        this.parentBot.sendTradeRequest(this.activeTrade);
    }

    resolveTrade(digit) {
        if (!this.activeTrade || this.stopped) return;

        const trade = this.activeTrade;
        const isWin = (trade.contractType === 'DIGITEVEN' && this.isEven(digit)) ||
                      (trade.contractType === 'DIGITODD' && this.isOdd(digit));

        const payout = isWin ? trade.stake * 0.95 : -trade.stake;
        this.totalProfit += payout;

        if (isWin) {
            this.winningTrades++;
            this.currentStake = this.baseStake;
            this.resetStreaks();
            this.log(`\x1b[42mWIN: +$${payout.toFixed(2)} | Next digit: ${digit} | Total: $${this.totalProfit.toFixed(2)}\x1b[0m`);
        } else {
            this.losingTrades++;
            this.currentStake = parseFloat((this.currentStake * this.martingaleMultiplier).toFixed(2));
            this.markStreakLost(trade.streakType);
            this.log(`\x1b[41mLOSS: -$${Math.abs(payout).toFixed(2)} | Next digit: ${digit} | Next Stake: $${this.currentStake.toFixed(2)}\x1b[0m`);
        }

        this.activeTrade = null;

        const winRate = this.totalTrades > 0
            ? ((this.winningTrades / this.totalTrades) * 100).toFixed(2)
            : 0;

        this.log(`STATS: Trades ${this.totalTrades} | Win Rate ${winRate}% | Profit $${this.totalProfit.toFixed(2)}\n`);

        if (this.totalProfit >= 0.3) {
            this.stop();
        }
    }

    resetStreaks() {
        this.oddStreak = { count: 0, digits: [], traded: false, lost: false };
        this.evenStreak = { count: 0, digits: [], traded: false, lost: false };
    }

    markStreakLost(streakType) {
        if (streakType === 'odd') {
            this.oddStreak.lost = true;
            this.oddStreak.traded = true;
        } else {
            this.evenStreak.lost = true;
            this.evenStreak.traded = true;
        }
    }

    stop() {
        this.stopped = true;
        this.log(`\x1b[44mINSTANCE STOPPED: Target Profit Reached ($${this.totalProfit.toFixed(2)})\x1b[0m`);
        this.parentBot.checkShutdownCondition();
    }

    hasReachedTarget() {
        return this.totalProfit >= 0.3;
    }
}

class StreakReversalBot {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.symbol = "1HZ10V";
        this.api_token = "sEcAT5qfmp52HYX";

        // Tick tracking
        this.tickCount = 0;
        this.digitHistory = [];

        // Initialize two trading instances
        this.instanceA = new TradingInstance('A', this, 'normal'); // Normal strategy
        this.instanceB = new TradingInstance('B', this, 'reverse'); // Reverse strategy

        // Log file
        this.logFile = 'dual_instance_trading_bot.log';
        this.initLogFile();

        // Connect
        this.connect();
    }

    initLogFile() {
        const header = `Dual Instance Trading Bot\n`;
        fs.writeFileSync(this.logFile, header, 'utf8');
    }

    connect() {
        this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);
        this.ws.on('open', () => {
            this.log('Connected to Deriv WS API');
            this.ws.send(JSON.stringify({ authorize: this.api_token }));
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());

                if (response.msg_type === "authorize") {
                    if (!response.error) {
                        this.log('Authorization successful');
                        this.subscribeToTicks();
                    } else {
                        this.log(`Authorization failed: ${response.error.message}`);
                    }
                }

                if (response.msg_type === "tick" && response.tick) {
                    this.processTick(response.tick);
                }

                if (response.msg_type === "buy") {
                    this.handleBuyResponse(response);
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

    subscribeToTicks() {
        this.ws.send(JSON.stringify({
            ticks: this.symbol,
            subscribe: 1
        }));
    }

    sendTradeRequest(trade) {
        this.ws.send(JSON.stringify({
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
        }));
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(this.logFile, logMessage, 'utf8');
        console.log(logMessage.trim());
    }

    processTick(tick) {
        this.tickCount++;
        const digit = this.instanceA.getLastDigit(tick.quote);
        const isOdd = this.instanceA.isOdd(digit);
        const isEven = this.instanceA.isEven(digit);

        // Resolve any active trades
        this.instanceA.resolveTrade(digit);
        this.instanceB.resolveTrade(digit);

        // Track digit history
        this.digitHistory.push(digit);
        if (this.digitHistory.length > 100) this.digitHistory.shift();

        // Skip if both stopped
        if (this.instanceA.stopped && this.instanceB.stopped) return;

        // Display tick
        this.log(`Tick ${this.tickCount} | Price: ${parseFloat(tick.quote).toFixed(2)} | Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})`);

        // Process streaks for both instances
        this.processInstance(this.instanceA, isOdd, isEven, digit);
        this.processInstance(this.instanceB, isOdd, isEven, digit);
    }

    handleBuyResponse(response) {
        if (response.error) {
            this.log(`\x1b[31mTRADE ERROR: ${response.error.message}\x1b[0m`);
        } else {
            this.log(`\x1b[32mTRADE CONFIRMED (ID: ${response.buy.contract_id})\x1b[0m`);
        }
    }

    processInstance(instance, isOdd, isEven, digit) {
        if (instance.stopped || instance.activeTrade) return;

        // Process ODD digit
        if (isOdd) {
            if (instance.evenStreak.count > 0) {
                instance.evenStreak = { count: 0, digits: [], traded: false, lost: false };
            }
            if (!instance.oddStreak.lost) {
                instance.oddStreak.count++;
                instance.oddStreak.digits.push(digit);
                if (instance.oddStreak.count === 3 && !instance.oddStreak.traded) {
                    instance.executeTrade('odd');
                }
            }
        }

        // Process EVEN digit
        else if (isEven) {
            if (instance.oddStreak.count > 0) {
                instance.oddStreak = { count: 0, digits: [], traded: false, lost: false };
            }
            if (!instance.evenStreak.lost) {
                instance.evenStreak.count++;
                instance.evenStreak.digits.push(digit);
                if (instance.evenStreak.count === 3 && !instance.evenStreak.traded) {
                    instance.executeTrade('even');
                }
            }
        }
    }

    checkShutdownCondition() {
        if (this.instanceA.hasReachedTarget() && this.instanceB.hasReachedTarget()) {
            this.shutdown();
        }
    }

    shutdown() {
        this.log('\x1b[44mBOT SHUTDOWN: Both Instances Have Achieved Target Profit (>=$0.3)\x1b[0m');
        this.log(`Final Profits: A = $${this.instanceA.totalProfit.toFixed(2)}, B = $${this.instanceB.totalProfit.toFixed(2)}`);
        if (this.ws) this.ws.close();
        process.exit(0);
    }
}

// Start the bot
const bot = new StreakReversalBot();

process.on('SIGINT', () => {
    bot.log('\x1b[41mManual exit triggered. Shutting down...\x1b[0m');
    process.exit(0);
});