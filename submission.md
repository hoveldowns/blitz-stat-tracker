# Blitz Player Stat Tracker

## Repo

https://github.com/hoveldowns/blitz-stat-tracker

## Usage

```bash
git clone https://github.com/hoveldowns/blitz-stat-tracker
cd blitz-stat-tracker
bun install
bun run index.ts <player_name_or_address>
```

## Examples

```bash
bun run index.ts tsuaurym
bun run index.ts lgccharrmander
bun run index.ts 0x062ba685f1d600ac7bda27e556b787548da32c7c0aa3ff5f58dddc07b9116f33
```

Sample output:
```
========================================
  tsuaurym
  0x062ba685f1d600ac7bda27e556b787548da32c7c0aa3ff5f58dddc07b9116f33
========================================

  S0 Record
  Games played:   5
  Wins (1st):     0
  Top 3 finishes: 4
  Top 5 finishes: 5
  Prizes earned:  5/5
  Avg rank:       2.8 of 18 players
  Avg percentile: 88th
  MMR (game 9):  1030

  Game History
  Game   Rank   Field   Paid
  ──────────────────────────
  G5     #3     27      ✓
  G6     #2     13      ✓
  G7     #2     17      ✓
  G8     #5     14      ✓
  G9     #2     17      ✓
```

## What it returns

- Games played in S0
- Wins, top 3, top 5 finish counts
- Prize earned rate
- Average rank and percentile across all games
- MMR from latest game
- Full game-by-game rank history

## How it works

Queries all S0 Torii SQL endpoints (`s0-game-1` through `s0-game-12`) for the player's `PlayerRank` records. Resolves player names from hex-encoded felt252 values in `AddressName`. No API key required — all data is public on-chain via Cartridge Torii.

## Stack

TypeScript, Bun, zero external dependencies beyond Bun runtime.
