const WebSocket = require('ws');
const fs = require('fs');

class StreakReversalTrader {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.symbol = "1HZ10V";
        this.api_token = "sEcAT5qfmp52HYX";

        // Trading parameters
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.martingaleMultiplier = 2.04;

        // Digit tracking
        this.digitHistory = [];
        this.oddStreak = { count: 0, digits: [], traded: false };
        this.evenStreak = { count: 0, digits: [], traded: false };

        // Trade tracking
        this.tickCount = 0;
        this.activeTrade = null;

        // Results tracking
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalProfit = 0;

        // Logging
        this.logFile = 'streak_reversal_trades_real_digit_result.log';
        this.initLogFile();
        this.connect();
    }

    initLogFile() {
        const header = `Streak Reversal Trading Bot (Real Digit Result)
Symbol: ${this.symbol}
Strategy: Trade ODD after 3 ODD | Trade EVEN after 3 EVEN
Base Stake: $${this.baseStake.toFixed(2)}
Martingale: ${this.martingaleMultiplier}x on loss
Started: ${new Date().toLocaleString()}
`;
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

    getLastDigit(price) {
        return parseInt(parseFloat(price).toFixed(2).slice(-1), 10);
    }

    isOdd(digit) {
        return digit % 2 !== 0;
    }

    isEven(digit) {
        return digit % 2 === 0;
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(this.logFile, logMessage, 'utf8');
        console.log(logMessage.trim());
    }

    processTick(tick) {
        this.tickCount++;
        const digit = this.getLastDigit(tick.quote);
        const isOdd = this.isOdd(digit);
        const isEven = this.isEven(digit);
        const formattedPrice = parseFloat(tick.quote).toFixed(2);

        // Store digit history
        this.digitHistory.push(digit);
        if (this.digitHistory.length > 100) this.digitHistory.shift();

        // Resolve trade if one is active and we just got a new tick
        if (this.activeTrade) {
            this.resolveTrade(digit, isOdd, isEven);
            return;
        }

        // Display tick
        this.log(`${isOdd ? '\x1b[33m' : '\x1b[36m'}Tick ${this.tickCount} | Price: ${formattedPrice} | Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})\x1b[0m`);

        // Check profit targets
        if (this.totalProfit >= 1003 || this.totalProfit <= -10000) {
            this.shutdown();
            return;
        }

        // Process ODD streak
        if (isOdd) {
            if (this.evenStreak.count > 0) {
                this.evenStreak = { count: 0, digits: [], traded: false };
            }
            this.oddStreak.count++;
            this.oddStreak.digits.push(digit);
            if (this.oddStreak.count === 3 && !this.oddStreak.traded) {
                this.oddStreak.traded = true;
                this.executeTrade('DIGITODD');
            }
        }

        // Process EVEN streak
        else if (isEven) {
            if (this.oddStreak.count > 0) {
                this.oddStreak = { count: 0, digits: [], traded: false };
            }
            this.evenStreak.count++;
            this.evenStreak.digits.push(digit);
            if (this.evenStreak.count === 3 && !this.evenStreak.traded) {
                this.evenStreak.traded = true;
                this.executeTrade('DIGITEVEN');
            }
        }
    }

    executeTrade(contractType) {
        if (this.activeTrade) return;

        this.totalTrades++;
        this.activeTrade = {
            contractType: contractType,
            stake: this.currentStake
        };

        this.log(`\x1b[32mPLACING TRADE: ${contractType} with $${this.currentStake.toFixed(2)} stake\x1b[0m`);

        this.ws.send(JSON.stringify({
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: "stake",
                contract_type: contractType,
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: this.symbol
            }
        }));
    }

    handleBuyResponse(response) {
        if (response.error) {
            this.log(`\x1b[31mTRADE ERROR: ${response.error.message}\x1b[0m`);
            this.activeTrade = null;
            this.currentStake = this.baseStake;
            return;
        }
        this.log(`\x1b[32mTRADE CONFIRMED (ID: ${response.buy.contract_id})\x1b[0m`);
    }

    resolveTrade(digit, isOdd, isEven) {
        const trade = this.activeTrade;
        const result = (trade.contractType === 'DIGITEVEN' && isEven) ||
                       (trade.contractType === 'DIGITODD' && isOdd);

        const payout = result ? trade.stake * 0.95 : -trade.stake;
        this.totalProfit += payout;

        if (result) {
            this.winningTrades++;
            this.currentStake = this.baseStake;

            // Reset streak
            if (trade.contractType === 'DIGITEVEN') {
                this.evenStreak = { count: 0, digits: [], traded: false };
            } else {
                this.oddStreak = { count: 0, digits: [], traded: false };
            }

            this.log(`\x1b[42mWIN: +$${payout.toFixed(2)} | Digit: ${digit} | Total: $${this.totalProfit.toFixed(2)}\x1b[0m`);
        } else {
            this.losingTrades++;
            this.currentStake = parseFloat((this.currentStake * this.martingaleMultiplier).toFixed(2));

            this.log(`\x1b[41mLOSS: -$${Math.abs(payout).toFixed(2)} | Digit: ${digit} | Next stake: $${this.currentStake.toFixed(2)}\x1b[0m`);
        }

        this.activeTrade = null;

        const winRate = this.totalTrades > 0
            ? ((this.winningTrades / this.totalTrades) * 100).toFixed(2)
            : 0;

        this.log(`STATS: Trades ${this.totalTrades} | Win Rate ${winRate}% | Profit $${this.totalProfit.toFixed(2)}\n`);

        if (this.totalProfit >= 1003 || this.totalProfit <= -10000) {
            this.shutdown();
        }
    }

    shutdown() {
        this.log('\n=== FINAL TRADING SUMMARY ===');
        this.log(`Total ticks processed: ${this.tickCount}`);
        this.log(`Total trades executed: ${this.totalTrades}`);
        this.log(`Winning trades: ${this.winningTrades}`);
        this.log(`Losing trades: ${this.losingTrades}`);
        this.log(`Final profit: $${this.totalProfit.toFixed(2)}`);
        this.log(`Last 100 digits: ${this.digitHistory.join(', ')}`);

        if (this.ws) this.ws.close();
        process.exit(0);
    }
}

// Start the bot
const trader = new StreakReversalTrader();

process.on('SIGINT', () => {
    trader.shutdown();
});

process.on('exit', () => {
    trader.shutdown();
});