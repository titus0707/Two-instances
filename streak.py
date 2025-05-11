# Generate a new result pattern with 20 consecutive Odd losses somewhere in the middle
# First 15 normal pattern, then 20 losses (L), then 15 normal pattern again
normal_pattern = ['W' if i % 3 == 0 else 'L' for i in range(15)]
loss_streak = ['L'] * 20
remaining_pattern = ['W' if i % 3 == 0 else 'L' for i in range(15)]
streak_results = normal_pattern + loss_streak + remaining_pattern

# Reset variables for simulation
odd_bet = initial_bet
bankroll = 0
records_streak = []

for i, result in enumerate(streak_results):
    even_win = (result == 'L')
    odd_win = (result == 'W')

    even_payout = even_bet * odds if even_win else 0
    odd_payout = odd_bet * odds if odd_win else 0

    round_profit = even_payout + odd_payout - (even_bet + odd_bet)
    bankroll += round_profit

    records_streak.append({
        "Trade": i+1,
        "Even Bet": round(even_bet, 2),
        "Odd Bet": round(odd_bet, 2),
        "Result": result,
        "Round Profit": round(round_profit, 2),
        "Bankroll": round(bankroll, 2)
    })

    # Martingale only on Odd
    if not odd_win:
        odd_bet *= martingale_factor
    else:
        odd_bet = initial_bet

# Create DataFrame
df_streak = pd.DataFrame(records_streak)

# Add summary row
summary_row_streak = {
    "Trade": "Total",
    "Even Bet": df_streak["Even Bet"].sum(),
    "Odd Bet": df_streak["Odd Bet"].sum(),
    "Result": "",
    "Round Profit": df_streak["Round Profit"].sum(),
    "Bankroll": df_streak["Bankroll"].iloc[-1]
}
df_streak = pd.concat([df_streak, pd.DataFrame([summary_row_streak])], ignore_index=True)

# Plotting bankroll progression
plt.figure(figsize=(12, 6))
plt.plot(df_streak["Trade"][:-1], df_streak["Bankroll"][:-1], marker='o', color='red')
plt.title("Bankroll with 20 Consecutive Odd Losses (1.3x Martingale)")
plt.xlabel("Trade Number")
plt.ylabel("Bankroll ($)")
plt.grid(True)
plt.tight_layout()

plt.show(), df_streak.tail(11)
