// Token Radar — entrypoint for make.fun token-radar-01.
// Reads the sealed DefiLlama snapshot, builds the ranked board and the
// static dashboard, then writes the dossier through the kit vendor library.
// Node 22, standard library only, no network, deterministic output.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnapshot, buildRadar, boardIssues, dataScript } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const OUT_CAPS = {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
};

function fail(message: string): never {
  console.error(`token-radar: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = "/input/snapshot.json";
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) input = argv[++i];
    else if (a === "--output" && argv[i + 1]) output = argv[++i];
    else if (a.startsWith("--input=")) input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
  }
  return { input, output };
}

function isPlainName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.startsWith(".") && !name.startsWith("-");
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!isPlainName(entry.name)) fail(`dashboard directory name not allowed: ${entry.name}`);
      copyTree(from, to);
    } else if (entry.isFile()) {
      if (!isPlainName(entry.name)) fail(`dashboard file name not allowed: ${entry.name}`);
      copyFileSync(from, to);
    }
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const snapshotPath = resolve(input);
  if (!existsSync(snapshotPath)) fail(`snapshot not found: ${snapshotPath}`);
  const snapshot = parseSnapshot(readFileSync(snapshotPath, "utf8"));
  const radar = buildRadar(snapshot);
  const issues = boardIssues(radar, snapshot);
  if (issues.length > 0) fail(`board validation failed:\n- ${issues.slice(0, 20).join("\n- ")}`);

  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, "dashboard"), { recursive: true });
  mkdirSync(join(output, "screenshots"), { recursive: true });

  writeFileSync(join(output, "board.json"), JSON.stringify({ rows: radar.rows }, null, 2) + "\n");
  writeFileSync(join(output, "data.js"), dataScript(radar));

  const dashboardSrc = join(here, "dashboard");
  if (!existsSync(dashboardSrc)) fail(`dashboard source missing: ${dashboardSrc}`);
  copyTree(dashboardSrc, join(output, "dashboard"));

  const shotsSrc = join(here, "screenshots");
  if (!existsSync(shotsSrc)) fail(`screenshots source missing: ${shotsSrc}`);
  const shots = readdirSync(shotsSrc).filter((n) => !n.startsWith("."));
  if (shots.length < 3) fail(`need at least 3 screenshots, found ${shots.length}`);
  for (const name of shots) {
    const src = join(shotsSrc, name);
    if (!statSync(src).isFile()) fail(`screenshot is not a file: ${name}`);
    copyFileSync(src, join(output, "screenshots", name));
  }

  // buildDossier returns the canonical dossier bytes (Uint8Array): write them
  // directly. JSON.stringify on a Uint8Array would serialise it as an object
  // of numeric keys and blow the file up past the 1.5 MiB gate.
  const dossier = buildDossier(output, OUT_CAPS);
  writeFileSync(join(output, "dossier.json"), dossier);

  const dashBytes = walkFiles(join(output, "dashboard")).reduce(
    (sum, f) => sum + statSync(f).size,
    0
  );
  const dossierBytes = statSync(join(output, "dossier.json")).size;
  console.log(`token-radar: ${radar.rows.length} ranked rows, ${radar.watchlist_size} watchlist covered`);
  console.log(`token-radar: ${radar.live_size} live-token protocols listed separately`);
  console.log(`token-radar: dashboard ${dashBytes} bytes, dossier ${dossierBytes} bytes`);
  if (dossierBytes > 1572864) fail("dossier.json exceeds 1.5 MiB");
  console.log("token-radar: done");
}

main();
