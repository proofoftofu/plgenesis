import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildUploadTargets,
  classifyFailure,
  normalizePrivateKey,
  parseRootCid,
  parseWalletAddress
} from "../src/lib/filecoin-upload.js";

test("normalizePrivateKey adds 0x prefix when missing", () => {
  assert.equal(
    normalizePrivateKey("abc123"),
    "0xabc123"
  );
  assert.equal(
    normalizePrivateKey("0xabc123"),
    "0xabc123"
  );
});

test("buildUploadTargets returns expected artifact upload order", () => {
  const outputDir = "/tmp/plgenesis-output";
  const targets = buildUploadTargets(outputDir);

  assert.deepEqual(
    targets.map((target) => target.file),
    [
      "metadata.json",
      "proposals.json",
      "governance-tally.json",
      "active-direction.json",
      "state.json"
    ]
  );
  assert.equal(targets[0].path, path.join(outputDir, "metadata.json"));
});

test("parsers extract wallet address and root cid from CLI output", () => {
  assert.equal(
    parseWalletAddress("Address: 0x0Bc298a4a0a205875F5Ae3B19506669c55B38d01"),
    "0x0Bc298a4a0a205875F5Ae3B19506669c55B38d01"
  );
  assert.equal(
    parseRootCid("✓ File packed with root CID: bafybeigduzxdrovpkky2smtkldkz3r7y47n5zxyw3iesod4qyfyuwyjrta"),
    "bafybeigduzxdrovpkky2smtkldkz3r7y47n5zxyw3iesod4qyfyuwyjrta"
  );
});

test("classifyFailure marks missing FIL as a funding blocker", () => {
  assert.equal(
    classifyFailure({
      message: "filecoin-pin exited with code 1",
      stdout: "Insufficient FIL for gas fees",
      stderr: ""
    }),
    "blocked_no_fil"
  );
});
