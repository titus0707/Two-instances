const WebSocket = require('ws');
const fs = require('fs');

class OddEvenStreakTrader {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.symbol = "1HZ10V";
        this.api_token = "sEcAT5qfmp52HYX";
        
        // Trading parameters
        this.baseStake = 0.35;
        this.currentStake = this.baseStake;
        this.martingaleMultiplier = 2.04;
        this.takeProfit = 1003;
        this.stopLoss = -10000.00;
        
        // Digit tracking
        this.digitHistory = [];
        this.oddStreak = {
            count: 0,
            digits: [],
            traded: false,
            lost: false
        };
        this.evenStreak = {
            count: 0,
            digits: [],
            traded: false,
            lost: false
        };
        
        // Trade tracking
        this.tickCount = 0;
        this.activeTrade = null;
        this.consecutiveLosses = 0;
        
        // Results tracking
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalProfit = 0;
        
        // Logging
        this.logFile = 'odd_even_streak_trades.log';
        this.initLogFile();
        this.connect();
    }

    initLogFile() {
        const header = `Odd/Even Streak Trading Bot\n` +
                     `Symbol: ${this.symbol}\n` +
                     `Strategy: Trade EVEN after 3 ODD digits | Trade ODD after 3 EVEN digits\n` +
                     `Base Stake: $${this.baseStake.toFixed(2)}\n` +
                     `Martingale: ${this.martingaleMultiplier}x on loss\n` +
                     `Take Profit: $${this.takeProfit.toFixed(2)}\n` +
                     `Stop Loss: $${this.stopLoss.toFixed(2)}\n` +
                     `Started: ${new Date().toLocaleString()}\n\n`;
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
                const response = JSON.parse(data);
                
                if (response.msg_type === "authorize") {
                    if (!response.error) {
                        this.log('Authorization successful');
                        this.ws.send(JSON.stringify({ 
                            ticks: this.symbol, 
                            subscribe: 1 
                        }));
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

    getLastDigit(price) {
        const formattedPrice = parseFloat(price).toFixed(2);
        return parseInt(formattedPrice.slice(-1), 10);
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
        console.log(logMessage);
    }

    processTick(tick) {
        this.tickCount++;
        const digit = this.getLastDigit(tick.quote);
        const isOdd = this.isOdd(digit);
        const isEven = this.isEven(digit);
        const formattedPrice = parseFloat(tick.quote).toFixed(2);

        // Always track digits
        this.digitHistory.push(digit);
        if (this.digitHistory.length > 100) this.digitHistory.shift();

        // Check for active trade resolution
        if (this.activeTrade && !this.activeTrade.digitAfter) {
            this.activeTrade.digitAfter = digit;
            this.resolveTrade();
            return;
        }

        // Display tick
        const tickColor = this.activeTrade ? '\x1b[90m' : (isOdd ? '\x1b[33m' : '\x1b[36m');
        const statusPrefix = this.activeTrade ? '[TRADE PENDING] ' : '';
        this.log(`${tickColor}${statusPrefix}Tick ${this.tickCount} | Price: ${formattedPrice} | Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})\x1b[0m`);

        // Check take profit/stop loss conditions
        if (this.totalProfit >= this.takeProfit) {
            this.log(`\x1b[42mTAKE PROFIT REACHED: $${this.totalProfit.toFixed(2)}\x1b[0m`);
            this.shutdown();
            return;
        }
        if (this.totalProfit <= this.stopLoss) {
            this.log(`\x1b[41mSTOP LOSS TRIGGERED: $${this.totalProfit.toFixed(2)}\x1b[0m`);
            this.shutdown();
            return;
        }

        // Skip streak processing if waiting for trade resolution
        if (this.activeTrade) return;

        // Process ODD streak
        if (isOdd) {
            // Reset EVEN streak when ODD appears
            if (this.evenStreak.count > 0) {
                const streakDesc = this.evenStreak.lost ? 
                    `LOST EVEN streak of ${this.evenStreak.count} (${this.evenStreak.digits.join(',')})` :
                    `EVEN streak of ${this.evenStreak.count} (${this.evenStreak.digits.join(',')})`;
                this.log(`\x1b[35mEVEN STREAK BROKEN by ODD | Was ${streakDesc}\x1b[0m`);
                this.evenStreak = {
                    count: 0,
                    digits: [],
                    traded: false,
                    lost: false
                };
            }

            // Process ODD streak
            if (!this.oddStreak.lost) {
                this.oddStreak.count++;
                this.oddStreak.digits.push(digit);
                
                if (this.oddStreak.count === 3 && !this.oddStreak.traded) {
                    this.log(`\x1b[32m3 ODD DIGIT STREAK: ${this.oddStreak.digits.join(', ')}\x1b[0m`);
                    this.oddStreak.traded = true;
                    this.executeTrade('DIGITEVEN');
                }
            } else {
                this.oddStreak.digits.push(digit);
                this.log(`\x1b[33mODD Streak continues (${this.oddStreak.digits.join(',')}) - No trade until streak ends\x1b[0m`);
            }
        }
        // Process EVEN streak
        else if (isEven) {
            // Reset ODD streak when EVEN appears
            if (this.oddStreak.count > 0) {
                const streakDesc = this.oddStreak.lost ? 
                    `LOST ODD streak of ${this.oddStreak.count} (${this.oddStreak.digits.join(',')})` :
                    `ODD streak of ${this.oddStreak.count} (${this.oddStreak.digits.join(',')})`;
                this.log(`\x1b[35mODD STREAK BROKEN by EVEN | Was ${streakDesc}\x1b[0m`);
                this.oddStreak = {
                    count: 0,
                    digits: [],
                    traded: false,
                    lost: false
                };
            }

            // Process EVEN streak
            if (!this.evenStreak.lost) {
                this.evenStreak.count++;
                this.evenStreak.digits.push(digit);
                
                if (this.evenStreak.count === 3 && !this.evenStreak.traded) {
                    this.log(`\x1b[32m3 EVEN DIGIT STREAK: ${this.evenStreak.digits.join(', ')}\x1b[0m`);
                    this.evenStreak.traded = true;
                    this.executeTrade('DIGITODD');
                }
            } else {
                this.evenStreak.digits.push(digit);
                this.log(`\x1b[33mEVEN Streak continues (${this.evenStreak.digits.join(',')}) - No trade until streak ends\x1b[0m`);
            }
        }
    }

    executeTrade(contractType) {
        if (this.activeTrade) return;

        this.totalTrades++;
        this.activeTrade = {
            contractType: contractType,
            stake: this.currentStake,
            digitAfter: null,
            startTick: this.tickCount,
            streakType: contractType === 'DIGITEVEN' ? 'odd' : 'even'
        };

        this.log(`\x1b[32mPLACING TRADE: ${contractType} with $${this.currentStake.toFixed(2)} stake\x1b[0m`);
        
        const request = {
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
        };

        this.ws.send(JSON.stringify(request));
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

    resolveTrade() {
        if (!this.activeTrade) return;

        const trade = this.activeTrade;
        const isWin = (trade.contractType === 'DIGITEVEN' && this.isEven(trade.digitAfter)) || 
                     (trade.contractType === 'DIGITODD' && this.isOdd(trade.digitAfter));

        const payout = isWin ? trade.stake * 0.95 : -trade.stake;
        this.totalProfit += payout;

        if (isWin) {
            this.winningTrades++;
            this.consecutiveLosses = 0;
            this.currentStake = this.baseStake;
            
            // Reset the appropriate streak after win
            if (trade.streakType === 'odd') {
                this.oddStreak = {
                    count: 0,
                    digits: [],
                    traded: false,
                    lost: false
                };
            } else {
                this.evenStreak = {
                    count: 0,
                    digits: [],
                    traded: false,
                    lost: false
                };
            }
            
            this.log(`\x1b[42mWIN: +$${payout.toFixed(2)} | Next digit: ${trade.digitAfter} | Total: $${this.totalProfit.toFixed(2)}\x1b[0m`);
        } else {
            this.losingTrades++;
            this.consecutiveLosses++;
            this.currentStake = parseFloat((this.currentStake * this.martingaleMultiplier).toFixed(2));
            
            // Mark the appropriate streak as lost
            if (trade.streakType === 'odd') {
                this.oddStreak.lost = true;
                if (this.isOdd(trade.digitAfter)) {
                    this.oddStreak.digits.push(trade.digitAfter);
                }
            } else {
                this.evenStreak.lost = true;
                if (this.isEven(trade.digitAfter)) {
                    this.evenStreak.digits.push(trade.digitAfter);
                }
            }
            
            this.log(`\x1b[41mLOSS: $${Math.abs(payout).toFixed(2)} | Next digit: ${trade.digitAfter} | Next stake: $${this.currentStake.toFixed(2)}\x1b[0m`);
        }

        const winRate = (this.winningTrades / this.totalTrades * 100).toFixed(2);
        this.log(`STATS: Trades ${this.totalTrades} | Win ${winRate}% | Profit $${this.totalProfit.toFixed(2)}\n`);

        // Reset trade
        this.activeTrade = null;

        // Check profit targets
        if (this.totalProfit >= this.takeProfit) {
            this.log(`\x1b[42mTAKE PROFIT REACHED: $${this.totalProfit.toFixed(2)}\x1b[0m`);
            this.shutdown();
        } else if (this.totalProfit <= this.stopLoss) {
            this.log(`\x1b[41mSTOP LOSS TRIGGERED: $${this.totalProfit.toFixed(2)}\x1b[0m`);
            this.shutdown();
        }
    }

    shutdown() {
        this.log('\n=== FINAL TRADING SUMMARY ===');
        this.log(`Total ticks processed: ${this.tickCount}`);
        this.log(`Total trades executed: ${this.totalTrades}`);
        this.log(`Winning trades: ${this.winningTrades}`);
        this.log(`Losing trades: ${this.losingTrades}`);
        this.log(`Consecutive losses: ${this.consecutiveLosses}`);
        this.log(`Final profit: $${this.totalProfit.toFixed(2)}`);
        this.log(`Last 100 digits: ${this.digitHistory.join(', ')}`);
        
        if (this.ws) {
            this.ws.close();
        }
        process.exit(0);
    }
}

// Start the bot
const trader = new OddEvenStreakTrader();

process.on('SIGINT', () => {
    trader.shutdown();
});

process.on('exit', () => {
    trader.shutdown();
});