// Token Radar — value model, farm plans and snapshot parsing.
// Written from scratch for the token-radar-01 entry (model "radar-2").
//
// The model prices a protocol that records no token yet from the snapshot's
// own figures, never from a hardcoded list of names:
//   implied = TVL x peer ratio x growth multiplier x maturity multiplier
// Peer ratio = the median market-cap / TVL of the live-token protocols in the
// same category, shrunk toward the market-wide median (weight 4) and capped
// at 3x TVL. The shrinkage and the cap exist because a category's median can
// rest on a single thin peer: one live prediction market trades at 400x its
// TVL, and without the cap it would price the whole category at $150B.
// Growth is the protocol's seven-day TVL change, clamped so one spike cannot
// dominate. Maturity is how long the protocol has run, from listed_at to the
// snapshot date, so a protocol that has survived a long time without a token
// scores higher than a week-old one of the same size.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  mcap_usd: number | null;
  symbol: string | null;
  total_volume_24h: number | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: Protocol[];
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  peer_ratio: number;
  peer_category: string;
  growth_mult: number;
  maturity_mult: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    version: string;
    base: string;
    growth: { clamp: [number, number]; weight: number };
    maturity: { floor: number; range: number; days: number; unknown_age: number };
    peer_fallback: number;
    peer_shrinkage: number;
    peer_cap: number;
  };
  watchlist_size: number;
  board_size: number;
  live_size: number;
  token_no_mcap: number;
  peers: { [category: string]: number };
  rows: BoardRow[];
  live: LiveRow[];
}

export const MAX_IMPLIED = 100000000000000;
export const PEER_SHRINKAGE = 4;
export const PEER_CAP = 3.0;

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: Protocol): boolean {
  return isPreToken(p) && p.category !== "CEX" && !VERSIONED.test(p.name);
}

export function ageDays(p: Protocol, asOf: Date): number | null {
  if (!p.listed_at) return null;
  const d = new Date(p.listed_at + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((asOf.getTime() - d.getTime()) / 86400000));
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

export function peerRatios(protocols: Protocol[]): { [c: string]: number } {
  const byCat: { [c: string]: number[] } = {};
  const all: number[] = [];
  for (const p of protocols) {
    if (!isPreToken(p) && p.mcap_usd && p.tvl_usd && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const r = p.mcap_usd / p.tvl_usd;
      (byCat[p.category] = byCat[p.category] || []).push(r);
      all.push(r);
    }
  }
  const global = median(all);
  const out: { [c: string]: number } = {};
  for (const c of Object.keys(byCat)) {
    const n = byCat[c].length;
    const blended = (n * median(byCat[c]) + PEER_SHRINKAGE * global) / (n + PEER_SHRINKAGE);
    out[c] = Math.min(PEER_CAP, blended);
  }
  out["__global__"] = global;
  return out;
}

export function growthMult(change7d: number | null): number {
  const pct = clamp(change7d ?? 0, -50, 150);
  return 1 + (pct / 100) * 0.6;
}

export function maturityMult(age: number | null): number {
  const days = age ?? 365;
  return 0.7 + (Math.min(days, 1460) / 1460) * 0.5;
}

export function impliedValue(p: Protocol, ratio: number, asOf: Date): {
  implied: number;
  growth: number;
  maturity: number;
} {
  const growth = growthMult(p.change_7d);
  const maturity = maturityMult(ageDays(p, asOf));
  const raw = p.tvl_usd * ratio * growth * maturity;
  const implied = Math.max(1, Math.min(MAX_IMPLIED, Math.round(raw)));
  return { implied, growth, maturity };
}

function capitalTier(tvl: number): number {
  if (tvl >= 5000000000) return 250;
  if (tvl >= 1000000000) return 150;
  if (tvl >= 100000000) return 100;
  return 50;
}

function mainAction(p: Protocol, capital: number): string {
  const chain = p.chains[0] ?? "its home chain";
  const c = p.category.toLowerCase();
  if (c.includes("lend") || c.includes("cdp") || c.includes("collateral"))
    return `Supply $${capital} of USDC to ${p.name} on ${chain} and keep the position open through the whole farming period.`;
  if (c.includes("dex") || c.includes("liquidity manager"))
    return `Provide $${capital} of liquidity to ${p.name}'s main pool on ${chain} and keep the position open through the whole farming period.`;
  if (c.includes("yield") || c.includes("farm") || c.includes("leveraged"))
    return `Deposit $${capital} into ${p.name}'s main vault on ${chain} and keep the shares through the whole farming period.`;
  if (c.includes("bridge"))
    return `Bridge $${capital} of USDC to ${chain} through ${p.name} and use the bridged funds in one app on ${chain} instead of bridging back right away.`;
  if (c.includes("staking") || c.includes("restak") || c.includes("btc"))
    return `Stake $${capital} of the chain's staking asset through ${p.name} and keep the receipt token through the whole farming period.`;
  if (c.includes("derivative") || c.includes("basis") || c.includes("perpetual"))
    return `Deposit $${capital} of USDC as margin on ${p.name} and open one small position with low leverage, then keep the account funded.`;
  if (c.includes("prediction"))
    return `Fund $${capital} on ${p.name} and place one market position, then leave the balance on the platform through the whole farming period.`;
  if (c.includes("curator") || c.includes("allocator"))
    return `Deposit $${capital} into a ${p.name} vault on ${chain} and keep the shares through the whole farming period.`;
  if (c.includes("stable"))
    return `Mint or deposit $${capital} of the stable asset through ${p.name} on ${chain} and hold it through the whole farming period.`;
  if (c.includes("rwa"))
    return `Mint $${capital} of ${p.name}'s yield asset on ${chain} and hold it through the whole farming period.`;
  if (c.includes("insurance"))
    return `Buy $${capital} of cover from ${p.name} on ${chain} and keep the policy active through the whole farming period.`;
  if (c.includes("chain"))
    return `Bridge $${capital} of USDC to ${chain} and use ${p.name}'s native apps for one transaction a week.`;
  return `Deposit $${capital} into ${p.name} on ${chain} and keep the position open through the whole farming period.`;
}

function secondAction(p: Protocol): string {
  const c = p.category.toLowerCase();
  if (c.includes("lend") || c.includes("cdp") || c.includes("collateral"))
    return `Borrow a small amount against the deposit once, then repay it the same week, so the account shows both sides of the protocol.`;
  if (c.includes("dex") || c.includes("liquidity manager"))
    return `Swap $10 through the pool once a week so the position stays active and the wallet keeps a steady transaction rhythm.`;
  if (c.includes("yield") || c.includes("farm") || c.includes("leveraged"))
    return `Claim or restake the vault's rewards once a week so the position compounds instead of sitting untouched.`;
  if (c.includes("bridge"))
    return `Use the bridged funds in a second app on the destination chain so the activity is not a single hop in and out.`;
  if (c.includes("staking") || c.includes("restak") || c.includes("btc"))
    return `Check the staking receipt each week and restake any rewards instead of letting them sit unclaimed.`;
  if (c.includes("derivative") || c.includes("basis") || c.includes("perpetual"))
    return `Close and reopen the position once so the account shows two fills instead of a single untouched deposit.`;
  if (c.includes("prediction"))
    return `Settle the first market, then place a second small position so the account shows repeat activity.`;
  if (c.includes("curator") || c.includes("allocator"))
    return `Vote on one vault proposal or follow a curator rebalance when the team posts an update.`;
  if (c.includes("stable"))
    return `Hold the minted asset for the full period and use it for one payment so the wallet shows real usage.`;
  if (c.includes("rwa"))
    return `Hold the yield asset and check its accrual each week so the position is not a one-day mint.`;
  if (c.includes("insurance"))
    return `Keep the policy active and check the cover terms each month so the position stays valid.`;
  if (c.includes("chain"))
    return `Make one transaction in a native app on the chain each week so the wallet builds a usage history.`;
  return `Make one qualifying action each week, such as a deposit, a swap or a vote, so the wallet shows steady use.`;
}

export function farmSteps(p: Protocol, asOf: Date): string[] {
  const capital = capitalTier(p.tvl_usd);
  const age = ageDays(p, asOf);
  const hold = age === null ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
  const steps: string[] = [];
  steps.push(
    `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`
  );
  steps.push(
    `${mainAction(p, capital)} Cost: $${capital} of capital and about $3 of gas. Time: 15 minutes to set up.`
  );
  steps.push(
    `${secondAction(p)} Cost: about $2 of gas a week. Time: 10 minutes a week.`
  );
  steps.push(
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot instead of a single day. Cost: the $${capital} stays in the position. Time: ${hold} days.`
  );
  steps.push(
    `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`
  );
  steps.push(
    `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it later. Cost: nothing but the log. Time: 5 minutes.`
  );
  return steps;
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("snapshot is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("snapshot must be an object");
  const s = raw as { as_of?: unknown; floor_usd?: unknown; watchlist?: unknown; protocols?: unknown };
  if (typeof s.as_of !== "string") throw new Error("snapshot.as_of must be a string");
  if (typeof s.floor_usd !== "number") throw new Error("snapshot.floor_usd must be a number");
  if (!Array.isArray(s.watchlist)) throw new Error("snapshot.watchlist must be an array");
  if (!Array.isArray(s.protocols)) throw new Error("snapshot.protocols must be an array");
  const protocols: Protocol[] = s.protocols.map((p, i) => {
    const q = p as Record<string, unknown>;
    const str = (k: string): string => (typeof q[k] === "string" ? (q[k] as string) : "");
    const num = (k: string): number | null =>
      typeof q[k] === "number" && Number.isFinite(q[k] as number) ? (q[k] as number) : null;
    if (!str("slug")) throw new Error(`protocol ${i} has no slug`);
    if (!str("name")) throw new Error(`protocol ${i} has no name`);
    if (!str("category")) throw new Error(`protocol ${i} has no category`);
    return {
      slug: str("slug"),
      name: str("name"),
      category: str("category"),
      chains: Array.isArray(q.chains) ? (q.chains as unknown[]).filter((x) => typeof x === "string") as string[] : [],
      tvl_usd: num("tvl_usd") ?? 0,
      change_7d: num("change_7d"),
      listed_at: typeof q.listed_at === "string" ? (q.listed_at as string) : null,
      gecko_id: typeof q.gecko_id === "string" ? (q.gecko_id as string) : null,
      mcap_usd: num("mcap_usd"),
      symbol: typeof q.symbol === "string" ? (q.symbol as string) : null,
      total_volume_24h: num("total_volume_24h"),
    };
  });
  return {
    as_of: s.as_of,
    floor_usd: s.floor_usd,
    watchlist: s.watchlist.filter((x) => typeof x === "string") as string[],
    protocols,
  };
}

export function buildRadar(snapshot: Snapshot): Radar {
  const asOf = new Date(snapshot.as_of + "T00:00:00Z");
  if (Number.isNaN(asOf.getTime())) throw new Error("snapshot.as_of is not a date");
  const peers = peerRatios(snapshot.protocols);
  const fallback = peers["__global__"];
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const ratio = peers[p.category] ?? fallback;
    const { implied, growth, maturity } = impliedValue(p, ratio, asOf);
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p, asOf),
      watchlist: watch.has(p.slug),
      rank: 0,
      implied_value_usd: implied,
      peer_ratio: Math.round(ratio * 10000) / 10000,
      peer_category: peers[p.category] !== undefined ? p.category : "__global__",
      growth_mult: Math.round(growth * 10000) / 10000,
      maturity_mult: Math.round(maturity * 10000) / 10000,
      farm_steps: farmSteps(p, asOf),
    });
  }
  rows.sort((a, b) => (b.implied_value_usd - a.implied_value_usd) || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => (r.rank = i + 1));
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd && p.mcap_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
  const peerTable: { [c: string]: number } = {};
  for (const c of Object.keys(peers)) if (c !== "__global__") peerTable[c] = Math.round(peers[c] * 10000) / 10000;
  return {
    as_of: snapshot.as_of,
    source: "DefiLlama snapshot",
    floor_usd: snapshot.floor_usd,
    model: {
      version: "radar-2",
      base: "TVL x peer ratio (median mcap/TVL of live-token protocols in the category, shrunk toward the market median and capped at 3x) x growth x maturity",
      growth: { clamp: [-50, 150], weight: 0.6 },
      maturity: { floor: 0.7, range: 0.5, days: 1460, unknown_age: 365 },
      peer_fallback: Math.round(fallback * 10000) / 10000,
      peer_shrinkage: PEER_SHRINKAGE,
      peer_cap: PEER_CAP,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    live_size: live.length,
    token_no_mcap: snapshot.protocols.filter(
      (p) => !isPreToken(p) && !(p.mcap_usd && p.mcap_usd > 0)
    ).length,
    peers: peerTable,
    rows,
    live,
  };
}

export function boardIssues(radar: Radar, snapshot: Snapshot): string[] {
  const issues: string[] = [];
  const rows = radar.rows;
  if (rows.length < 100 || rows.length > 4000) issues.push(`rows ${rows.length} outside 100-4000`);
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (r.rank !== i + 1) issues.push(`${r.slug} rank ${r.rank} != ${i + 1}`);
    if (seen.has(r.slug)) issues.push(`duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (!snapshot.protocols.some((p) => p.slug === r.slug)) issues.push(`${r.slug} not in snapshot`);
    if (!r.name.trim()) issues.push(`${r.slug} empty name`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MAX_IMPLIED)
      issues.push(`${r.slug} implied ${r.implied_value_usd} out of range`);
    if (i > 0 && rows[i - 1].implied_value_usd < r.implied_value_usd)
      issues.push(`${r.slug} implied rises after ${rows[i - 1].slug}`);
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12)
      issues.push(`${r.slug} farm_steps count ${r.farm_steps.length}`);
    else
      r.farm_steps.forEach((s, j) => {
        const t = s.trim();
        if (t.length < 20 || t.length > 600) issues.push(`${r.slug} step ${j + 1} length ${t.length}`);
      });
  });
  if (rows.length > 0 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd))
    issues.push("all implied values equal");
  for (const w of snapshot.watchlist) if (!seen.has(w)) issues.push(`watchlist ${w} missing from board`);
  return issues;
}

export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
