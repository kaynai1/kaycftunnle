// SPDX-License-Identifier: MIT
// 内存版 Cloudflare KV，供 Worker 测试复用
export class MemoryKV {
  constructor() {
    this.map = new Map();
    this.puts = 0;
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key).value : null;
  }
  async put(key, value, options = {}) {
    this.puts += 1;
    this.map.set(key, { value: String(value), metadata: options.metadata || null });
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const names = [...this.map.keys()].filter((name) => name.startsWith(prefix)).sort();
    const start = cursor ? parseInt(cursor, 10) : 0;
    const slice = names.slice(start, start + limit);
    const next = start + slice.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: next >= names.length,
      cursor: String(next),
    };
  }
}
