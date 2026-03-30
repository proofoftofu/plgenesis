import { keccak256 } from "./keccak.js";

const WORD_BYTES = 32;

export function selector(signature) {
  return keccak256(Buffer.from(signature, "utf8")).subarray(0, 4);
}

export function encodeRegisterAgent({ agentId, metadataCid }) {
  return encodeCall("registerAgent(bytes32,string)", [
    { type: "bytes32", value: agentId },
    { type: "string", value: metadataCid }
  ]);
}

export function encodeConfigureVoterWeight({ agentId, voter, weight }) {
  return encodeCall("configureVoterWeight(bytes32,address,uint256)", [
    { type: "bytes32", value: agentId },
    { type: "address", value: voter },
    { type: "uint256", value: weight }
  ]);
}

export function encodeProposeDirection({
  agentId,
  stage,
  parentDirectionId,
  proposalCid,
  proposalDigest
}) {
  return encodeCall("proposeDirection(bytes32,uint8,uint256,string,bytes32)", [
    { type: "bytes32", value: agentId },
    { type: "uint8", value: stage },
    { type: "uint256", value: parentDirectionId },
    { type: "string", value: proposalCid },
    { type: "bytes32", value: proposalDigest }
  ]);
}

export function encodeVoteOnDirection({ agentId, proposalId }) {
  return encodeCall("voteOnDirection(bytes32,uint256)", [
    { type: "bytes32", value: agentId },
    { type: "uint256", value: proposalId }
  ]);
}

export function encodeFinalizeDirection({
  agentId,
  proposalId,
  directionCid,
  directionDigest
}) {
  return encodeCall("finalizeDirection(bytes32,uint256,string,bytes32)", [
    { type: "bytes32", value: agentId },
    { type: "uint256", value: proposalId },
    { type: "string", value: directionCid },
    { type: "bytes32", value: directionDigest }
  ]);
}

export function encodeSubmitResearchRun({
  agentId,
  directionId,
  stateCid,
  stateDigest
}) {
  return encodeCall("submitResearchRun(bytes32,uint256,string,bytes32)", [
    { type: "bytes32", value: agentId },
    { type: "uint256", value: directionId },
    { type: "string", value: stateCid },
    { type: "bytes32", value: stateDigest }
  ]);
}

export function encodeSubmitResearchProgress({
  agentId,
  directionId,
  step,
  progressCid,
  progressDigest
}) {
  return encodeCall("submitResearchProgress(bytes32,uint256,uint256,string,bytes32)", [
    { type: "bytes32", value: agentId },
    { type: "uint256", value: directionId },
    { type: "uint256", value: step },
    { type: "string", value: progressCid },
    { type: "bytes32", value: progressDigest }
  ]);
}

function encodeCall(signature, params) {
  const head = [];
  const tail = [];
  const headSize = WORD_BYTES * params.length;

  for (const param of params) {
    if (isDynamic(param.type)) {
      const offset = headSize + tailSize(tail);
      head.push(encodeUint(offset));
      tail.push(encodeDynamic(param));
      continue;
    }

    head.push(encodeStatic(param));
  }

  return `0x${Buffer.concat([
    selector(signature),
    ...head,
    ...tail
  ]).toString("hex")}`;
}

function isDynamic(type) {
  return type === "string";
}

function encodeStatic(param) {
  switch (param.type) {
    case "bytes32":
      return encodeBytes32(param.value);
    case "address":
      return encodeAddress(param.value);
    case "uint8":
    case "uint256":
      return encodeUint(param.value);
    default:
      throw new Error(`Unsupported static ABI type: ${param.type}`);
  }
}

function encodeDynamic(param) {
  switch (param.type) {
    case "string":
      return encodeString(param.value);
    default:
      throw new Error(`Unsupported dynamic ABI type: ${param.type}`);
  }
}

function tailSize(buffers) {
  return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
}

function encodeUint(value) {
  const hex = BigInt(value).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function encodeBytes32(hexValue) {
  const normalized = normalizeHex(hexValue);
  if (normalized.length !== 64) {
    throw new Error("Expected 32-byte hex value");
  }

  return Buffer.from(normalized, "hex");
}

function encodeAddress(hexValue) {
  const normalized = normalizeHex(hexValue);
  if (normalized.length !== 40) {
    throw new Error("Expected 20-byte address");
  }

  return Buffer.from(normalized.padStart(64, "0"), "hex");
}

function encodeString(value) {
  const data = Buffer.from(value, "utf8");
  const paddedLength = Math.ceil(data.length / WORD_BYTES) * WORD_BYTES;
  const padded = Buffer.concat([data, Buffer.alloc(paddedLength - data.length)]);
  return Buffer.concat([encodeUint(data.length), padded]);
}

function normalizeHex(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}
