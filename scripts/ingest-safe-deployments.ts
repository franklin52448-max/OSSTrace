/**
 * Pulls Safe's (formerly Gnosis Safe) own official, published list of its deployed contract
 * addresses and labels every Ethereum mainnet one, writing data/labels/safe-deployments.json.
 * See data/labels/README.md for the sourcing rules this follows.
 *
 * Why this source clears ADR 0004/0005's bar: https://github.com/safe-global/safe-deployments is
 * maintained by Safe's own GitHub org (safe-global, the team that wrote and deployed these
 * contracts), MIT-licensed, and is the list Safe's own SDKs import to find their contracts. The
 * data originates with the protocol that deployed the contracts — not with any labeling platform,
 * Arkham or otherwise. This script also checks every address on-chain (eth_getCode) and refuses
 * to label one that has no contract code on mainnet, so a typo in the source can't become a label.
 *
 * Format confirmed by downloading the real files before writing this parser (not assumed from the
 * README): one JSON file per contract per version under src/assets/v<version>/<contract>.json,
 * each with "contractName", "version", "released", "deployments" (a map of deployment type —
 * "canonical", "eip155", "zksync" — to { address, codeHash }), and "networkAddresses" (a map of
 * EIP-155 chain id to a deployment type, or an array of them where a contract was deployed more
 * than one way on that chain — v1.3.0 has both "canonical" and "eip155" on mainnet).
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Label, Source, Tag } from "../packages/core/src/types.ts";

const REPO = "safe-global/safe-deployments";
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const ASSETS_PREFIX = "src/assets/";
const ETHEREUM_MAINNET_CHAIN_ID = "1";
const OUTPUT_PATH = fileURLToPath(new URL("../data/labels/safe-deployments.json", import.meta.url));

export interface SafeDeploymentFile {
  contractName: string;
  version: string;
  released: boolean;
  deployments?: Record<string, { address: string; codeHash?: string }>;
  networkAddresses: Record<string, string | string[]>;
}

export interface MainnetDeployment {
  address: string;
  contractName: string;
  version: string;
  deploymentType: string;
  path: string;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Pure: given one parsed deployment file, returns its Ethereum mainnet address(es). Unreleased
 * entries are skipped (Safe marks pre-release deployments `released: false`). A networkAddresses
 * value is normally a deployment-type key into `deployments`; older-format files can hold the
 * address directly, so a value that is itself an address is accepted as-is. Anything else
 * (an unknown key, a malformed address) is skipped, never guessed.
 */
export function extractMainnetDeployments(file: SafeDeploymentFile, path: string): MainnetDeployment[] {
  if (!file.released) return [];
  const raw = file.networkAddresses?.[ETHEREUM_MAINNET_CHAIN_ID];
  if (raw === undefined) return [];
  const results: MainnetDeployment[] = [];
  for (const ref of Array.isArray(raw) ? raw : [raw]) {
    const fromKey = file.deployments?.[ref]?.address;
    const address = fromKey ?? (EVM_ADDRESS_RE.test(ref) ? ref : undefined);
    if (!address || !EVM_ADDRESS_RE.test(address)) continue;
    results.push({ address: address.toLowerCase(), contractName: file.contractName, version: file.version, deploymentType: fromKey ? ref : "direct", path });
  }
  return results;
}

/** Pure: which paths in the repo tree are deployment files. */
export function deploymentFilePaths(treePaths: string[]): string[] {
  return treePaths.filter((p) => p.startsWith(ASSETS_PREFIX) && /\/v\d+\.\d+\.\d+\/[^/]+\.json$/.test(p)).sort();
}

/**
 * Pure: builds the Label/Tag output, one Label per address. `commitSha` pins each citation to the
 * exact revision of the file the label came from, so the cited URL keeps showing the same data
 * even after the repo changes.
 */
export function buildLabelSet(deployments: MainnetDeployment[], commitSha: string, addedAt: string): { labels: Label[]; tags: Tag[]; entities: [] } {
  const byAddress = new Map<string, MainnetDeployment[]>();
  for (const d of deployments) byAddress.set(d.address, [...(byAddress.get(d.address) ?? []), d]);

  const labels: Label[] = [];
  const tags: Tag[] = [];
  for (const [address, ds] of byAddress) {
    const first = ds[0];
    if (!first) continue;
    const names = [...new Set(ds.map((d) => `${d.contractName} v${d.version}${d.deploymentType === "canonical" || d.deploymentType === "direct" ? "" : ` (${d.deploymentType} deployment)`}`))];
    const source: Source = {
      description: `Safe's official published deployment list (safe-global/safe-deployments, ${ds.map((d) => d.path).join(", ")}) — Ethereum mainnet address of Safe's ${names.join(" / ")} contract, confirmed to have contract code on-chain`,
      url: `https://github.com/${REPO}/blob/${commitSha}/${first.path}`,
      addedAt,
    };
    const addr = { chain: "ethereum" as const, value: address };
    labels.push({ address: addr, name: `Safe: ${names.join(" / ")}`, confidence: "verified", source });
    tags.push({ address: addr, tag: "protocol-contract", source });
  }
  return { labels, tags, entities: [] };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Batched eth_getCode — returns the set of addresses that have NO contract code on mainnet. */
async function addressesWithoutCode(rpcUrl: string, addresses: string[]): Promise<Set<string>> {
  const body = addresses.map((a, id) => ({ jsonrpc: "2.0", id, method: "eth_getCode", params: [a, "latest"] }));
  const results = await fetchJson<Array<{ id: number; result?: string; error?: unknown }>>(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const missing = new Set<string>();
  for (const [id, address] of addresses.entries()) {
    const r = results.find((x) => x.id === id);
    if (!r || r.error !== undefined || typeof r.result !== "string") throw new Error(`eth_getCode failed for ${address}: ${JSON.stringify(r?.error ?? r)}`);
    if (r.result === "0x" || r.result === "0x0") missing.add(address);
  }
  return missing;
}

async function main(): Promise<void> {
  const headers = { accept: "application/vnd.github+json", "user-agent": "osstrace-label-ingest" };
  const commit = await fetchJson<{ sha: string }>(`${API}/commits/main`, { headers });
  console.log(`safe-global/safe-deployments main is at ${commit.sha}`);
  const tree = await fetchJson<{ tree: Array<{ path: string }>; truncated: boolean }>(`${API}/git/trees/${commit.sha}?recursive=1`, { headers });
  if (tree.truncated) throw new Error("GitHub returned a truncated tree — refusing to ingest a partial list");
  const paths = deploymentFilePaths(tree.tree.map((t) => t.path));
  console.log(`Found ${paths.length} deployment files.`);

  const deployments: MainnetDeployment[] = [];
  for (const path of paths) {
    const file = await fetchJson<SafeDeploymentFile>(`${RAW}/${commit.sha}/${path}`);
    deployments.push(...extractMainnetDeployments(file, path));
  }

  const rpcUrl = process.env["ETH_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
  const unique = [...new Set(deployments.map((d) => d.address))];
  const noCode = await addressesWithoutCode(rpcUrl, unique);
  if (noCode.size > 0) console.warn(`Skipping ${noCode.size} address(es) with no contract code on mainnet: ${[...noCode].join(", ")}`);
  const confirmed = deployments.filter((d) => !noCode.has(d.address));

  const output = buildLabelSet(confirmed, commit.sha, new Date().toISOString().slice(0, 10));
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${output.labels.length} labels (all with on-chain code confirmed) to ${OUTPUT_PATH}`);
}

// Only run when executed directly (`npm run ingest:safe`) — not when imported for its pure
// functions by scripts/tests/ingest-safe-deployments.test.ts, which must not hit the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
