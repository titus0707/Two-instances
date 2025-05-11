const WebSocket = require('ws');
const fs = require('fs');

class OddStreakTracker {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.symbol = "1HZ10V";
        this.streakData = [];
        this.currentStreak = {
            count: 0,
            digits: [],
            betweenStreakDigits: [],
            startTick: null,
            breakTick: null
        };
        this.tickCount = 0;
        this.logFile = 'odd_streaks.log';
        
        // Initialize log file
        const header = `Odd Digit Streak Tracker (2 Decimal Places)\n` +
                      `Symbol: ${this.symbol}\n` +
                      `Started: ${new Date().toLocaleString()}\n` +
                      `Tracking streaks of 3+ odd digits\n` +
                      `----------------------------------\n\n`;
        fs.writeFileSync(this.logFile, header, 'utf8');
        
        this.connect();
    }

    connect() {
        this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${this.app_id}`);

        this.ws.on('open', () => {
            console.log('Connected to Deriv WS API');
            this.ws.send(JSON.stringify({ authorize: "sEcAT5qfmp52HYX" }));
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (response.msg_type === "authorize") {
                    if (!response.error) {
                        console.log('Authorization successful');
                        this.ws.send(JSON.stringify({ 
                            ticks: this.symbol, 
                            subscribe: 1 
                        }));
                    } else {
                        console.error('Authorization failed:', response.error.message);
                    }
                }
                
                if (response.msg_type === "tick" && response.tick) {
                    this.processTick(response.tick);
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });

        this.ws.on('close', () => {
            console.log('Connection closed - reconnecting in 5 seconds...');
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('WebSocket error:', err.message);
        });
    }

    getLastDigit(price) {
        // Format to exactly 2 decimal places
        const formattedPrice = parseFloat(price).toFixed(2);
        // Extract the last digit after decimal
        return parseInt(formattedPrice.slice(-1), 10);
    }

    isOdd(digit) {
        return digit % 2 !== 0;
    }

    processTick(tick) {
        this.tickCount++;
        const digit = this.getLastDigit(tick.quote);
        const isOdd = this.isOdd(digit);
        const timestamp = new Date().toISOString();
        const formattedPrice = parseFloat(tick.quote).toFixed(2);

        // Display tick with color coding
        const tickColor = isOdd ? '\x1b[33m' : '\x1b[36m';
        console.log(`${tickColor}${timestamp} | Tick ${this.tickCount.toString().padStart(6)} | ` +
                   `Price: ${formattedPrice.padEnd(8)} | ` +
                   `Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})\x1b[0m`);

        // Log to file
        const tickLog = `${timestamp} | Tick ${this.tickCount.toString().padStart(6)} | ` +
                       `Price: ${formattedPrice.padEnd(8)} | ` +
                       `Digit: ${digit} (${isOdd ? 'ODD' : 'EVEN'})\n`;
        fs.appendFileSync(this.logFile, tickLog, 'utf8');

        // Streak tracking logic
        if (isOdd) {
            if (this.currentStreak.count === 0) {
                this.currentStreak.startTick = this.tickCount;
                
                // Show between-streak digits if any
                if (this.currentStreak.betweenStreakDigits.length > 0) {
                    const betweenStr = this.currentStreak.betweenStreakDigits.join(', ');
                    console.log('\x1b[35mBetween-streak digits:', betweenStr, '\x1b[0m');
                    fs.appendFileSync(this.logFile, `Between-streak digits: ${betweenStr}\n`, 'utf8');
                }
            }
            
            this.currentStreak.count++;
            this.currentStreak.digits.push(digit);
            this.currentStreak.betweenStreakDigits = [];
        } else {
            if (this.currentStreak.count >= 3) {
                this.currentStreak.breakTick = this.tickCount;
                const streakDuration = this.currentStreak.breakTick - this.currentStreak.startTick;
                
                console.log('\x1b[32m=== ODD STREAK ENDED ===');
                console.log(`Streak length: ${this.currentStreak.count} odd digits`);
                console.log(`Digits: ${this.currentStreak.digits.join(', ')}`);
                console.log(`Duration: ${streakDuration} ticks\x1b[0m\n`);
                
                fs.appendFileSync(this.logFile, 
                    `\n=== ODD STREAK ENDED ===\n` +
                    `Streak length: ${this.currentStreak.count} odd digits\n` +
                    `Digits: ${this.currentStreak.digits.join(', ')}\n` +
                    `Duration: ${streakDuration} ticks\n\n`, 
                    'utf8');
                
                this.streakData.push({...this.currentStreak});
            }
            
            if (this.currentStreak.count > 0 || this.streakData.length > 0) {
                this.currentStreak.betweenStreakDigits.push(digit);
            }
            
            // Reset streak
            this.currentStreak.count = 0;
            this.currentStreak.digits = [];
        }
    }

    shutdown() {
        console.log('\n\x1b[35m=== FINAL REPORT ===\x1b[0m');
        console.log('Total ticks processed:', this.tickCount);
        console.log('Total odd streaks (3+):', this.streakData.length);
        
        const summary = `\n=== TRACKING SUMMARY ===\n` +
                       `Total ticks processed: ${this.tickCount}\n` +
                       `Total odd streaks (3+): ${this.streakData.length}\n` +
                       `Tracking ended: ${new Date().toLocaleString()}\n`;
        
        fs.appendFileSync(this.logFile, summary, 'utf8');
        
        if (this.ws) {
            this.ws.close();
        }
        process.exit(0);
    }
}

// Start the tracker
const tracker = new OddStreakTracker();

process.on('SIGINT', () => {
    tracker.shutdown();
});

process.on('exit', () => {
    tracker.shutdown();
});