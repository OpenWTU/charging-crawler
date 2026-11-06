/**
 * 测试环境准备：在 config.ts 被 import 之前设置 TOKEN_KEY_FILE，
 * 指向一个临时 32 字节 hex key，供 encryptToken/decryptToken 使用。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'charge-key-'));
const keyFile = path.join(dir, 'token_key');
writeFileSync(keyFile, '00'.repeat(32), 'ascii');
process.env.TOKEN_KEY_FILE = keyFile;
