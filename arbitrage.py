import ccxt  # Crypto exchange library
import time
import pandas as pd
from datetime import datetime
import logging

# Set up logging
logging.basicConfig(
    filename='arbitrage_log.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

class ArbitrageBot:
    def __init__(self):
        # Initialize exchanges
        self.exchanges = {
            'binance': ccxt.binance(),
            'kraken': ccxt.kraken(),
            'coinbase': ccxt.coinbase(),
            'kucoin': ccxt.kucoin()
        }
        self.min_profit = 0.01  # Minimum profit percentage (1%)
        self.report_data = []

    def fetch_order_books(self, exchange, symbol, limit=10):
        """Fetch order book data for a given symbol from an exchange"""
        try:
            order_book = exchange.fetch_order_book(symbol, limit)
            return {
                'bids': order_book['bids'][0][0] if order_book['bids'] else 0,  # Highest bid
                'asks': order_book['asks'][0][0] if order_book['asks'] else 0   # Lowest ask
            }
        except Exception as e:
            logging.error(f"Error fetching order book from {exchange.name} for {symbol}: {str(e)}")
            return None

    def find_triangular_arbitrage(self, exchange):
        """Look for triangular arbitrage opportunities within a single exchange"""
        try:
            markets = exchange.load_markets()
            symbols = list(markets.keys())
            
            # Common trading pairs
            base_currencies = ['BTC', 'ETH', 'USDT']
            
            for base in base_currencies:
                pairs = [s for s in symbols if base in s]
                
                for i in range(len(pairs)):
                    for j in range(i + 1, len(pairs)):
                        for k in range(j + 1, len(pairs)):
                            pair1 = pairs[i]
                            pair2 = pairs[j]
                            pair3 = pairs[k]
                            
                            # Check if pairs form a triangle
                            book1 = self.fetch_order_books(exchange, pair1)
                            book2 = self.fetch_order_books(exchange, pair2)
                            book3 = self.fetch_order_books(exchange, pair3)
                            
                            if not all([book1, book2, book3]):
                                continue
                                
                            # Calculate potential profit (simplified)
                            profit = self.calculate_triangular_profit(book1, book2, book3, pair1, pair2, pair3)
                            
                            if profit > self.min_profit:
                                self.report_data.append({
                                    'type': 'triangular',
                                    'exchange': exchange.name,
                                    'pairs': [pair1, pair2, pair3],
                                    'profit_percent': profit,
                                    'timestamp': datetime.now().isoformat()
                                })
                                logging.info(f"Triangular arb found on {exchange.name}: {pair1}, {pair2}, {pair3} - Profit: {profit}%")
                                
        except Exception as e:
            logging.error(f"Error in triangular arbitrage on {exchange.name}: {str(e)}")

    def calculate_triangular_profit(self, book1, book2, book3, pair1, pair2, pair3):
        """Calculate potential profit from triangular arbitrage"""
        # This is a simplified calculation - real implementation would need to account for fees and order sizes
        try:
            # Example: BTC/USDT -> ETH/BTC -> ETH/USDT
            amount = 1000  # Starting amount in USDT
            amount_after_1 = amount / book1['asks']  # Buy BTC with USDT
            amount_after_2 = amount_after_1 * book2['bids']  # Sell BTC for ETH
            final_amount = amount_after_2 * book3['bids']  # Sell ETH for USDT
            
            profit_percent = ((final_amount - amount) / amount) * 100
            return profit_percent
        except:
            return 0

    def find_simple_arbitrage(self, symbol='BTC/USDT'):
        """Look for simple arbitrage opportunities between exchanges"""
        prices = {}
        
        for name, exchange in self.exchanges.items():
            try:
                book = self.fetch_order_books(exchange, symbol)
                if book:
                    prices[name] = {
                        'bid': book['bids'],
                        'ask': book['asks']
                    }
            except Exception as e:
                logging.error(f"Error fetching {symbol} from {name}: {str(e)}")
        
        # Compare prices across exchanges
        for ex1 in prices:
            for ex2 in prices:
                if ex1 == ex2:
                    continue
                    
                buy_price = prices[ex1]['ask']
                sell_price = prices[ex2]['bid']
                
                if buy_price and sell_price and buy_price < sell_price:
                    profit = ((sell_price - buy_price) / buy_price) * 100
                    
                    if profit > self.min_profit:
                        self.report_data.append({
                            'type': 'simple',
                            'buy_exchange': ex1,
                            'sell_exchange': ex2,
                            'symbol': symbol,
                            'profit_percent': profit,
                            'buy_price': buy_price,
                            'sell_price': sell_price,
                            'timestamp': datetime.now().isoformat()
                        })
                        logging.info(f"Simple arb found: Buy {symbol} on {ex1} at {buy_price}, Sell on {ex2} at {sell_price} - Profit: {profit}%")

    def generate_report(self):
        """Generate and save arbitrage report"""
        if not self.report_data:
            print("No arbitrage opportunities found")
            return
            
        df = pd.DataFrame(self.report_data)
        filename = f"arbitrage_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        
        df.to_csv(filename, index=False)
        print(f"Report generated: {filename}")
        logging.info(f"Report generated with {len(self.report_data)} opportunities")

    def run(self):
        """Main execution loop"""
        print("Starting arbitrage scanner...")
        while True:
            try:
                # Check simple arbitrage for major pairs
                for pair in ['BTC/USDT', 'ETH/USDT', 'XRP/USDT']:
                    self.find_simple_arbitrage(pair)
                
                # Check triangular arbitrage on each exchange
                for exchange in self.exchanges.values():
                    self.find_triangular_arbitrage(exchange)
                
                # Generate report every 5 minutes
                self.generate_report()
                self.report_data = []  # Reset report data
                
                time.sleep(300)  # Wait 5 minutes
            except Exception as e:
                logging.error(f"Error in main loop: {str(e)}")
                time.sleep(60)  # Wait before retrying

if __name__ == "__main__":
    bot = ArbitrageBot()
    bot.run()