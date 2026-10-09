import { lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Buffer } from 'node:buffer';
import { requireValue } from '../../../packages/resource-pack-contract/index.mjs';
export async function boundedRead(path, limit) {
  const stat = await lstat(path);
  requireValue(stat.isFile() && stat.size > 0 && stat.size <= limit, '输入文件类型或大小无效');
  const chunks = [];
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.length;
    requireValue(total <= limit, '读取输入大小超限');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, total);
  requireValue(bytes.length > 0 && bytes.length <= limit, '读取后输入大小无效');
  return bytes;
}
