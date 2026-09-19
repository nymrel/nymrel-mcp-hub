/** RFC 6962 domain-separated Merkle tree with an explicit v1 legacy profile. */

import { createHash } from 'node:crypto';

export interface MerkleProofStep {
  position: 'left' | 'right';
  hash: string;
}

export type MerkleProfile = 'rfc6962' | 'legacy-duplicated';

export interface MerkleTreeOptions {
  isPreHashed?: boolean;
  profile?: MerkleProfile;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function requireHash(value: string, label: string): void {
  if (!HEX_64.test(value)) {
    throw new TypeError(`${label} must be a 64-character hexadecimal SHA-256 digest`);
  }
}

export function hashLeaf(data: string | Uint8Array, isHex = false): string {
  let buffer: Buffer;
  if (isHex) {
    if (typeof data !== 'string' || !HEX_64.test(data)) {
      throw new TypeError('Pre-hashed leaf must be a 64-character hexadecimal SHA-256 digest');
    }
    buffer = Buffer.from(data, 'hex');
  } else {
    buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  }
  return createHash('sha256').update(LEAF_PREFIX).update(buffer).digest('hex');
}

export function hashNodes(leftHex: string, rightHex: string): string {
  requireHash(leftHex, 'Left child hash');
  requireHash(rightHex, 'Right child hash');
  return createHash('sha256')
    .update(NODE_PREFIX)
    .update(Buffer.from(leftHex, 'hex'))
    .update(Buffer.from(rightHex, 'hex'))
    .digest('hex');
}

export class MerkleTree {
  private readonly leaves: string[];
  private readonly layers: string[][];
  private readonly profile: MerkleProfile;

  public constructor(items: (string | Uint8Array)[] = [], options: MerkleTreeOptions = {}) {
    this.profile = options.profile ?? 'rfc6962';
    this.leaves = items.map((item) => hashLeaf(item, options.isPreHashed ?? false));
    if (this.leaves.length === 0) {
      const emptyInput = this.profile === 'legacy-duplicated' ? LEAF_PREFIX : Buffer.alloc(0);
      this.layers = [[createHash('sha256').update(emptyInput).digest('hex')]];
    } else {
      this.layers = this.buildLayers(this.leaves);
    }
  }

  private buildLayers(leaves: string[]): string[][] {
    const layers = [[...leaves]];
    let current = [...leaves];
    while (current.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < current.length; index += 2) {
        const left = current[index];
        const right = current[index + 1];
        if (right !== undefined) {
          next.push(hashNodes(left, right));
        } else if (this.profile === 'legacy-duplicated') {
          next.push(hashNodes(left, left));
        } else {
          next.push(left);
        }
      }
      layers.push(next);
      current = next;
    }
    return layers;
  }

  public getRoot(): string {
    return this.layers[this.layers.length - 1][0];
  }

  public getLeaves(): string[] {
    return [...this.leaves];
  }

  public getLayers(): string[][] {
    return this.layers.map((layer) => [...layer]);
  }

  public getProof(index: number): MerkleProofStep[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new RangeError(`Leaf index ${index} out of bounds (0..${this.leaves.length - 1})`);
    }
    const proof: MerkleProofStep[] = [];
    let currentIndex = index;
    for (let layerIndex = 0; layerIndex < this.layers.length - 1; layerIndex++) {
      const layer = this.layers[layerIndex];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      if (siblingIndex < layer.length) {
        proof.push({ position: isRight ? 'left' : 'right', hash: layer[siblingIndex] });
      } else if (this.profile === 'legacy-duplicated') {
        proof.push({ position: 'right', hash: layer[currentIndex] });
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  }

  public static verifyProof(
    leafHash: string,
    proof: MerkleProofStep[],
    expectedRoot: string
  ): boolean {
    try {
      requireHash(leafHash, 'Leaf hash');
      requireHash(expectedRoot, 'Expected root');
      let current = leafHash.toLowerCase();
      for (const step of proof) {
        if (step.position !== 'left' && step.position !== 'right') return false;
        requireHash(step.hash, 'Proof step hash');
        current = step.position === 'left'
          ? hashNodes(step.hash, current)
          : hashNodes(current, step.hash);
      }
      return current === expectedRoot.toLowerCase();
    } catch {
      return false;
    }
  }

  public verifyProof(leafHash: string, proof: MerkleProofStep[]): boolean {
    return MerkleTree.verifyProof(leafHash, proof, this.getRoot());
  }

  public toJSON(): { root: string; leafCount: number; leaves: string[]; depth: number; profile: MerkleProfile } {
    return {
      root: this.getRoot(),
      leafCount: this.leaves.length,
      leaves: this.getLeaves(),
      depth: this.layers.length,
      profile: this.profile,
    };
  }
}
