const WebSocket = require('ws');
const fs = require('fs');

class ConsecutiveTickPatternTracker {
    constructor() {
        this.ws = null;
        this.app_id = "1089";
        this.symbol = "1HZ10V";
        this.previousDigit = null;
        this.patternsToTrack = ['14', '49', '91'];
        this.patternOccurrences = {
            '14': { count: 0, nextDigits: [] },
            '49': { count: 0, nextDigits: [] },
            '91': { count: 0, nextDigits: [] }
        };
        this.tickCount = 0;
        this.logFile = 'consecutive_tick_patterns.log';
        
        // Initialize log file
        const header = `Consecutive Tick Pattern Tracker\n` +
                      `Symbol: ${this.symbol}\n` +
                      `Tracking patterns between consecutive ticks: ${this.patternsToTrack.join(', ')}\n` +
                      `Started: ${new Date().toLocaleString()}\n` +
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
        // Extract the last digit
        return formattedPrice.slice(-1);
    }

    processTick(tick) {
        this.tickCount++;
        const currentDigit = this.getLastDigit(tick.quote);
        const timestamp = new Date().toISOString();
        const formattedPrice = parseFloat(tick.quote).toFixed(2);

        // Display tick
        console.log(`${timestamp} | Tick ${this.tickCount.toString().padStart(6)} | ` +
                   `Price: ${formattedPrice.padEnd(8)} | ` +
                   `Digit: ${currentDigit}`);

        // Log to file
        const tickLog = `${timestamp} | Tick ${this.tickCount.toString().padStart(6)} | ` +
                       `Price: ${formattedPrice.padEnd(8)} | ` +
                       `Digit: ${currentDigit}\n`;
        fs.appendFileSync(this.logFile, tickLog, 'utf8');

        // Check for patterns between consecutive ticks
        if (this.previousDigit !== null) {
            const twoDigitPattern = this.previousDigit + currentDigit;
            
            if (this.patternsToTrack.includes(twoDigitPattern)) {
                // Store this occurrence (we'll get the next digit in the following tick)
                this.currentPattern = {
                    pattern: twoDigitPattern,
                    tickCount: this.tickCount,
                    price: formattedPrice
                };
                
                const logMessage = `\n=== POTENTIAL PATTERN START ===\n` +
                                 `Pattern: ${twoDigitPattern}\n` +
                                 `Tick: ${this.tickCount}\n` +
                                 `Price: ${formattedPrice}\n\n`;
                
                console.log('\x1b[33m' + logMessage + '\x1b[0m');
                fs.appendFileSync(this.logFile, logMessage, 'utf8');
            }
            
            // Check if we're waiting to see what comes after a pattern
            if (this.currentPattern && this.currentPattern.tickCount === this.tickCount - 1) {
                this.patternOccurrences[this.currentPattern.pattern].count++;
                this.patternOccurrences[this.currentPattern.pattern].nextDigits.push(currentDigit);
                
                const logMessage = `\n=== PATTERN COMPLETED ===\n` +
                                 `Pattern: ${this.currentPattern.pattern}\n` +
                                 `Next digit: ${currentDigit}\n` +
                                 `Pattern tick: ${this.currentPattern.tickCount}\n` +
                                 `Pattern price: ${this.currentPattern.price}\n` +
                                 `Current tick: ${this.tickCount}\n` +
                                 `Current price: ${formattedPrice}\n` +
                                 `Total occurrences: ${this.patternOccurrences[this.currentPattern.pattern].count}\n\n`;
                
                console.log('\x1b[32m' + logMessage + '\x1b[0m');
                fs.appendFileSync(this.logFile, logMessage, 'utf8');
                
                // Generate statistics for this pattern
                this.generatePatternStats(this.currentPattern.pattern);
                
                // Clear the current pattern
                this.currentPattern = null;
            }
        }

        // Store current digit for next tick comparison
        this.previousDigit = currentDigit;
    }

    generatePatternStats(pattern) {
        const occurrences = this.patternOccurrences[pattern];
        if (occurrences.count === 0) return;
        
        const digitCounts = {};
        occurrences.nextDigits.forEach(digit => {
            digitCounts[digit] = (digitCounts[digit] || 0) + 1;
        });
        
        const stats = Object.entries(digitCounts)
            .map(([digit, count]) => ({
                digit,
                count,
                percentage: (count / occurrences.count * 100).toFixed(2) + '%'
            }))
            .sort((a, b) => b.count - a.count);
        
        console.log('\x1b[36m=== STATISTICS FOR PATTERN:', pattern, '===');
        console.log('Total occurrences:', occurrences.count);
        console.log('Next digit distribution:');
        stats.forEach(stat => {
            console.log(`Digit ${stat.digit}: ${stat.count} (${stat.percentage})`);
        });
        console.log('\x1b[0m');
        
        const statsLog = `\n=== STATISTICS FOR PATTERN: ${pattern} ===\n` +
                        `Total occurrences: ${occurrences.count}\n` +
                        `Next digit distribution:\n` +
                        stats.map(stat => `Digit ${stat.digit}: ${stat.count} (${stat.percentage})`).join('\n') +
                        '\n\n';
        
        fs.appendFileSync(this.logFile, statsLog, 'utf8');
    }

    shutdown() {
        console.log('\n\x1b[35m=== FINAL REPORT ===\x1b[0m');
        console.log('Total ticks processed:', this.tickCount);
        
        for (const pattern of this.patternsToTrack) {
            console.log(`\nPattern "${pattern}" occurrences:`, this.patternOccurrences[pattern].count);
            this.generatePatternStats(pattern);
        }
        
        const summary = `\n=== TRACKING SUMMARY ===\n` +
                       `Total ticks processed: ${this.tickCount}\n` +
                       `Tracking ended: ${new Date().toLocaleString()}\n\n`;
        
        fs.appendFileSync(this.logFile, summary, 'utf8');
        
        if (this.ws) {
            this.ws.close();
        }
        process.exit(0);
    }
}

// Start the tracker
const tracker = new ConsecutiveTickPatternTracker();

process.on('SIGINT', () => {
    tracker.shutdown();
});

process.on('exit', () => {
    tracker.shutdown();
});