// Blitz Player Stat Tracker
// Queries S0 game slots + active Blitz slots for a player's history

const TORII_BASE = "https://api.cartridge.gg/x";

const S0_SLOTS = Array.from({ length: 12 }, (_, i) => ({ slot: `s0-game-${i + 1}`, label: `G${i + 1}` }));
const ACTIVE_SLOTS = [
  { slot: "slot-blitz-4", label: "sg-5" },
];
const ALL_SLOTS = [...S0_SLOTS, ...ACTIVE_SLOTS];

async function sql(slot: string, query: string) {
  const url = `${TORII_BASE}/${slot}/torii/sql?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json() as Promise<any[]>;
  } catch {
    return null;
  }
}

function decodeHexName(hex: string): string {
  try {
    const h = hex.replace("0x", "").replace(/^0+/, "");
    const padded = h.length % 2 ? "0" + h : h;
    return Buffer.from(padded, "hex").toString("utf8").replace(/\x00/g, "").trim();
  } catch {
    return hex;
  }
}

function encodeNameToHex(name: string): string {
  const hex = Buffer.from(name, "utf8").toString("hex");
  return "0x" + hex.padStart(64, "0");
}

async function resolveAddress(input: string): Promise<string | null> {
  if (input.startsWith("0x") && input.length > 20) return input.toLowerCase();
  const hexName = encodeNameToHex(input);
  for (const { slot } of ALL_SLOTS) {
    const rows = await sql(slot, `SELECT address FROM "s1_eternum-AddressName" WHERE name = '${hexName}' LIMIT 1`);
    if (rows && rows.length > 0) return rows[0].address;
  }
  return null;
}

async function getStats(playerInput: string) {
  console.log(`\nQuerying: ${playerInput}...`);

  const address = await resolveAddress(playerInput);
  if (!address) {
    console.error(`Player not found: ${playerInput}`);
    process.exit(1);
  }

  let resolvedName = playerInput;
  const results: { label: string; slot: string; rank: number; totalPlayers: number; paid: boolean }[] = [];

  for (const { slot, label } of ALL_SLOTS) {
    const rankRows = await sql(slot, `SELECT rank, paid FROM "s1_eternum-PlayerRank" WHERE player = '${address}' LIMIT 1`);
    if (!rankRows || rankRows.length === 0) continue;

    const countRows = await sql(slot, `SELECT COUNT(*) as cnt FROM "s1_eternum-PlayerRank"`);
    const totalPlayers = Number(countRows?.[0]?.cnt ?? 0);
    const { rank, paid } = rankRows[0];
    results.push({ label, slot, rank, totalPlayers, paid: paid === 1 });

    if (resolvedName === playerInput) {
      const nameRows = await sql(slot, `SELECT name FROM "s1_eternum-AddressName" WHERE address = '${address}' LIMIT 1`);
      if (nameRows?.[0]) resolvedName = decodeHexName(nameRows[0].name);
    }
  }

  if (results.length === 0) {
    console.log(`No games found for: ${playerInput}`);
    return;
  }

  const totalGames = results.length;
  const wins = results.filter(r => r.rank === 1).length;
  const top3 = results.filter(r => r.rank <= 3).length;
  const top5 = results.filter(r => r.rank <= 5).length;
  const paidCount = results.filter(r => r.paid).length;
  const avgRank = results.reduce((s, r) => s + r.rank, 0) / totalGames;
  const avgField = results.reduce((s, r) => s + r.totalPlayers, 0) / totalGames;
  const avgPctile = results.reduce((s, r) => s + (1 - (r.rank - 1) / Math.max(r.totalPlayers - 1, 1)), 0) / totalGames;

  const latestResult = results[results.length - 1];
  let latestMMR: number | null = null;
  const mmrRows = await sql(latestResult.slot, `SELECT game_median FROM "s1_eternum-MMRGameMeta" LIMIT 1`);
  if (mmrRows?.[0]) latestMMR = parseInt(mmrRows[0].game_median, 16);

  console.log(`\n========================================`);
  console.log(`  ${resolvedName}`);
  console.log(`  ${address}`);
  console.log(`========================================`);
  console.log(`\n  Record`);
  console.log(`  Games played:   ${totalGames}`);
  console.log(`  Wins (1st):     ${wins}`);
  console.log(`  Top 3 finishes: ${top3}`);
  console.log(`  Top 5 finishes: ${top5}`);
  console.log(`  Prizes earned:  ${paidCount}/${totalGames}`);
  console.log(`  Avg rank:       ${avgRank.toFixed(1)} of ${avgField.toFixed(0)} players`);
  console.log(`  Avg percentile: ${(avgPctile * 100).toFixed(0)}th`);
  if (latestMMR) console.log(`  MMR (${latestResult.label}):    ${latestMMR}`);

  console.log(`\n  Game History`);
  console.log(`  ${"Game".padEnd(7)} ${"Rank".padEnd(6)} ${"Field".padEnd(7)} Paid`);
  console.log(`  ${"─".repeat(27)}`);
  for (const r of results) {
    console.log(`  ${r.label.padEnd(7)} #${String(r.rank).padEnd(5)} ${String(r.totalPlayers).padEnd(7)} ${r.paid ? "✓" : "—"}`);
  }
  console.log();
}

const input = process.argv[2];
if (!input) {
  console.log("Usage: bun run index.ts <player_name_or_address>");
  console.log("Examples:");
  console.log("  bun run index.ts tsuaurym");
  console.log("  bun run index.ts lgccharrmander");
  console.log("  bun run index.ts 0x062ba685f1d600ac7bda27e556b787548da32c7c0aa3ff5f58dddc07b9116f33");
  process.exit(0);
}

getStats(input);
