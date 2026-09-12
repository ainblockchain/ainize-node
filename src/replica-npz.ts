import { readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { inspectNpz, parseNpyHeader, type NpzInfo } from '@ainize/core';

export function inspectReplicaNpz(path: string, maxBytes: number, maxExpandedBytes: number): NpzInfo {
  const requireValid = (condition: boolean, message: string) => { if (!condition) throw new Error(`replica_npz: ${message}`); };
  requireValid(statSync(path).size <= maxBytes, 'archive exceeds the limit');
  const bytes = readFileSync(path);
  requireValid(bytes.length >= 22 && bytes.length <= maxBytes, 'invalid archive size');
  const range = (offset: number, length: number, ceiling = bytes.length) => {
    requireValid(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= ceiling, 'archive range exceeds its bounds');
  };
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  requireValid(end >= 0, 'missing central directory');
  requireValid(end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, 'invalid archive ending');
  const count = bytes.readUInt16LE(end + 10);
  requireValid(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count, 'split archives are not supported');
  requireValid(count > 0 && count <= 64, 'archive must contain 1–64 arrays');
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  range(directoryStart, directorySize, end);
  requireValid(directoryStart + directorySize === end, 'ZIP64 directories or trailing directory records are not supported');
  const names = new Set<string>();
  const occupied: { start: number; end: number }[] = [];
  let cursor = directoryStart;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    range(cursor, 46, end);
    requireValid(bytes.readUInt32LE(cursor) === 0x02014b50, 'invalid directory entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    range(cursor + 46, nameLength + extraLength + commentLength, end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    requireValid(/^[A-Za-z0-9_.-]+\.npy$/.test(name) && !names.has(name), 'invalid or duplicate array name');
    names.add(name);
    requireValid((flags & ~0x0808) === 0 && (method === 0 || method === 8), 'unsupported encryption or compression');
    requireValid(bytes.readUInt16LE(cursor + 34) === 0, 'array is on another disk');
    expanded += uncompressedSize;
    requireValid(uncompressedSize >= 10 && expanded <= maxExpandedBytes, 'expanded arrays exceed the limit');
    range(local, 30, directoryStart);
    requireValid(bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, 'local header disagrees with directory');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    range(local + 30, localNameLength + localExtraLength, directoryStart);
    requireValid(bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes), 'local array name disagrees with directory');
    const start = local + 30 + localNameLength + localExtraLength;
    range(start, compressedSize, directoryStart);
    requireValid(!occupied.some(other => local < other.end && start + compressedSize > other.start), 'overlapping arrays');
    occupied.push({ start: local, end: start + compressedSize });
    const compressed = bytes.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    requireValid(data.length === uncompressedSize, 'expanded size disagrees with directory');
    requireValid(data.subarray(0, 6).toString('latin1') === '\x93NUMPY' && [1, 2, 3].includes(data[6]), 'invalid array header');
    const headerOffset = data[6] === 1 ? 10 : 12;
    range(0, headerOffset, data.length);
    const headerSize = data[6] === 1 ? data.readUInt16LE(8) : data.readUInt32LE(8);
    requireValid(headerOffset + headerSize <= Math.min(4096, data.length), 'array header exceeds inspection bounds');
    if (['addrs.npy', 'before.npy', 'after.npy'].includes(name)) {
      const header = parseNpyHeader(data);
      const width = name === 'addrs.npy' ? 8 : 4;
      requireValid(!header.fortranOrder && header.shape.every(dimension => Number.isSafeInteger(dimension) && dimension > 0), 'invalid knowledge layout');
      requireValid(header.shape.reduce((total, dimension) => total * dimension, width) === data.length - header.dataOffset, 'array payload size disagrees with its shape');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  requireValid(cursor === end && ['addrs.npy', 'before.npy', 'after.npy'].every(name => names.has(name)), 'missing knowledge arrays or incomplete directory');
  const info = inspectNpz(path);
  const addrs = info.members.find(member => member.name === 'addrs')!;
  const before = info.members.find(member => member.name === 'before')!;
  const after = info.members.find(member => member.name === 'after')!;
  requireValid(addrs.descr === '<i8' && addrs.shape.length === 1 && Number.isSafeInteger(info.rows) && info.rows > 0, 'invalid address array');
  requireValid(Number.isSafeInteger(info.rowDim) && info.rowDim > 0 && [before, after].every(member => member.descr === '<f4' && member.shape.length === 2 && member.shape[0] === info.rows && member.shape[1] === info.rowDim), 'invalid knowledge shape');
  return info;
}
