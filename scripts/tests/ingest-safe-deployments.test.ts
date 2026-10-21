import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLabelSet, deploymentFilePaths, extractMainnetDeployments, type SafeDeploymentFile } from "../ingest-safe-deployments.ts";

const CANONICAL = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const EIP155 = "0x69f4D1788e39c87893C980c06EdF4b7f686e2938";

test("extractMainnetDeployments resolves a deployment-type key to its address (v1.4.1+ shape)", () => {
  const file: SafeDeploymentFile = {
    contractName: "Safe",
    version: "1.4.1",
    released: true,
    deployments: { canonical: { address: CANONICAL } },
    networkAddresses: { "1": "canonical", "137": "canonical" },
  };
  assert.deepEqual(extractMainnetDeployments(file, "src/assets/v1.4.1/safe.json"), [
    { address: CANONICAL.toLowerCase(), contractName: "Safe", version: "1.4.1", deploymentType: "canonical", path: "src/assets/v1.4.1/safe.json" },
  ]);
});

test("extractMainnetDeployments returns every address when mainnet lists several deployment types (v1.3.0 shape)", () => {
  const file: SafeDeploymentFile = {
    contractName: "GnosisSafe",
    version: "1.3.0",
    released: true,
    deployments: { canonical: { address: CANONICAL }, eip155: { address: EIP155 }, zksync: { address: "0x1727c2c531cf966f902E5927b98490fDFb3b2b70" } },
    networkAddresses: { "1": ["canonical", "eip155"], "324": "zksync" },
  };
  const found = extractMainnetDeployments(file, "p");
  assert.deepEqual(found.map((d) => [d.address, d.deploymentType]), [
    [CANONICAL.toLowerCase(), "canonical"],
    [EIP155.toLowerCase(), "eip155"],
  ]);
});

test("extractMainnetDeployments accepts an address written directly instead of a key", () => {
  const file: SafeDeploymentFile = { contractName: "X", version: "1.0.0", released: true, networkAddresses: { "1": CANONICAL } };
  assert.equal(extractMainnetDeployments(file, "p")[0]?.deploymentType, "direct");
});

test("extractMainnetDeployments skips unreleased files, missing mainnet entries, and unknown keys", () => {
  const base = { contractName: "X", version: "1.0.0", deployments: { canonical: { address: CANONICAL } } };
  assert.deepEqual(extractMainnetDeployments({ ...base, released: false, networkAddresses: { "1": "canonical" } }, "p"), []);
  assert.deepEqual(extractMainnetDeployments({ ...base, released: true, networkAddresses: { "137": "canonical" } }, "p"), []);
  assert.deepEqual(extractMainnetDeployments({ ...base, released: true, networkAddresses: { "1": "nonexistent" } }, "p"), []);
});

test("deploymentFilePaths keeps only versioned asset JSON files", () => {
  assert.deepEqual(
    deploymentFilePaths(["README.md", "src/assets/v1.3.0/gnosis_safe.json", "src/index.ts", "src/assets/v1.0.0/proxy_factory.json", "src/assets/notes.json"]),
    ["src/assets/v1.0.0/proxy_factory.json", "src/assets/v1.3.0/gnosis_safe.json"],
  );
});

test("buildLabelSet cites the exact file at a pinned commit, one label + protocol-contract tag per address", () => {
  const out = buildLabelSet(
    [
      { address: "0xaa", contractName: "GnosisSafe", version: "1.3.0", deploymentType: "canonical", path: "src/assets/v1.3.0/gnosis_safe.json" },
      { address: "0xbb", contractName: "GnosisSafe", version: "1.3.0", deploymentType: "eip155", path: "src/assets/v1.3.0/gnosis_safe.json" },
    ],
    "abc123",
    "2026-10-21",
  );
  assert.equal(out.labels.length, 2);
  assert.equal(out.labels[0]?.name, "Safe: GnosisSafe v1.3.0");
  assert.equal(out.labels[1]?.name, "Safe: GnosisSafe v1.3.0 (eip155 deployment)");
  assert.equal(out.labels[0]?.source.url, "https://github.com/safe-global/safe-deployments/blob/abc123/src/assets/v1.3.0/gnosis_safe.json");
  assert.equal(out.labels[0]?.confidence, "verified");
  assert.deepEqual(out.tags.map((t) => t.tag), ["protocol-contract", "protocol-contract"]);
});

test("buildLabelSet merges an address that appears in more than one file into a single label", () => {
  const out = buildLabelSet(
    [
      { address: "0xaa", contractName: "A", version: "1.0.0", deploymentType: "canonical", path: "a.json" },
      { address: "0xaa", contractName: "B", version: "1.1.1", deploymentType: "canonical", path: "b.json" },
    ],
    "sha",
    "2026-10-21",
  );
  assert.equal(out.labels.length, 1);
  assert.equal(out.labels[0]?.name, "Safe: A v1.0.0 / B v1.1.1");
});
