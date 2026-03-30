const MASK_64 = 0xffffffffffffffffn;
const RATE_BYTES = 136;

const ROTATION_OFFSETS = [
  0, 36, 3, 41, 18,
  1, 44, 10, 45, 2,
  62, 6, 43, 15, 61,
  28, 55, 25, 21, 56,
  27, 20, 39, 8, 14
];

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

export function keccak256(input) {
  const state = new Array(25).fill(0n);
  const bytes = Buffer.from(input);

  let offset = 0;
  while (offset + RATE_BYTES <= bytes.length) {
    absorbBlock(state, bytes.subarray(offset, offset + RATE_BYTES));
    keccakF1600(state);
    offset += RATE_BYTES;
  }

  const finalBlock = Buffer.alloc(RATE_BYTES);
  bytes.subarray(offset).copy(finalBlock);
  finalBlock[bytes.length - offset] = 0x01;
  finalBlock[RATE_BYTES - 1] |= 0x80;
  absorbBlock(state, finalBlock);
  keccakF1600(state);

  const output = Buffer.alloc(32);
  let outOffset = 0;
  for (let lane = 0; lane < 25 && outOffset < output.length; lane += 1) {
    for (let byte = 0; byte < 8 && outOffset < output.length; byte += 1) {
      output[outOffset] = Number((state[lane] >> BigInt(8 * byte)) & 0xffn);
      outOffset += 1;
    }
  }

  return output;
}

function absorbBlock(state, block) {
  for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
    let value = 0n;
    for (let byte = 0; byte < 8; byte += 1) {
      value |= BigInt(block[lane * 8 + byte]) << BigInt(8 * byte);
    }
    state[lane] ^= value;
  }
}

function keccakF1600(state) {
  for (const roundConstant of ROUND_CONSTANTS) {
    const c = new Array(5).fill(0n);
    const d = new Array(5).fill(0n);
    const b = new Array(25).fill(0n);

    for (let x = 0; x < 5; x += 1) {
      c[x] =
        state[x] ^
        state[x + 5] ^
        state[x + 10] ^
        state[x + 15] ^
        state[x + 20];
    }

    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotateLeft(c[(x + 1) % 5], 1);
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] ^= d[x];
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        const newX = y;
        const newY = (2 * x + 3 * y) % 5;
        b[newX + 5 * newY] = rotateLeft(state[index], ROTATION_OFFSETS[index]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] =
          b[x + 5 * y] ^
          ((~b[((x + 1) % 5) + 5 * y] & MASK_64) & b[((x + 2) % 5) + 5 * y]);
      }
    }

    state[0] ^= roundConstant;
  }
}

function rotateLeft(value, shift) {
  const amount = BigInt(shift % 64);
  if (amount === 0n) {
    return value & MASK_64;
  }

  return ((value << amount) | (value >> (64n - amount))) & MASK_64;
}
