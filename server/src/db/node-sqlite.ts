/**
 * `node:sqlite` → Kysely SqliteDialect 的适配层。
 *
 * 为什么不用 better-sqlite3：
 *  - 它是原生模块，需要 node-gyp 编译（Windows 要 VS Build Tools，Alpine 要 python3+make+g++）
 *  - Node 24 已内置 `node:sqlite`，零依赖、零编译、镜像体积小一半
 *
 * Kysely 的 SqliteDriver 只依赖 DB 的 6 个能力（见 kysely/dist/esm/dialect/sqlite/sqlite-driver.js）：
 *   db.prepare(sql) / stmt.reader / stmt.all(params) / stmt.run(params) / stmt.iterate(params) / db.close()
 *
 * 差异只有两点，都在这里抹平：
 *  1. 参数传递：better-sqlite3 传数组 `stmt.all([a,b])`，node:sqlite 要展开 `stmt.all(a,b)`
 *  2. `stmt.reader`：better-sqlite3 有该属性，node:sqlite 用 `columns().length > 0` 判断
 */
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * 用 createRequire 而不是静态 `import ... from 'node:sqlite'`：
 * vite 5 / vitest 2 的内置模块 externals 列表里还没有 `node:sqlite`（Node 24 才正式），
 * 静态 import 会被当成 npm 包去解析并报 "Failed to load url sqlite"。
 * 用 require 走 Node 原生解析，vite 不参与，问题消失。
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export interface CompatStatement {
  /** 该语句是否返回行（Kysely 用它决定走 all() 还是 run()） */
  readonly reader: boolean;
  all(params?: readonly unknown[]): unknown[];
  get(params?: readonly unknown[]): unknown;
  run(params?: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  iterate(params?: readonly unknown[]): IterableIterator<unknown>;
}

/** 把 Kysely 传来的参数数组展开成 node:sqlite 的可变参数 */
function spread(params?: readonly unknown[]): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...params] : [params];
}

class CompatStatementImpl implements CompatStatement {
  readonly #stmt: StatementSync;
  readonly reader: boolean;

  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
    // columns() 返回该语句的结果列；空数组 = 不返回行（INSERT/UPDATE/CREATE…）
    let cols: unknown[] = [];
    try {
      cols = this.#stmt.columns() as unknown[];
    } catch {
      cols = [];
    }
    this.reader = cols.length > 0;
  }

  all(params?: readonly unknown[]): unknown[] {
    return this.#stmt.all(...(spread(params) as never[])) as unknown[];
  }

  get(params?: readonly unknown[]): unknown {
    return this.#stmt.get(...(spread(params) as never[]));
  }

  run(params?: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.#stmt.run(...(spread(params) as never[]));
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: (r.lastInsertRowid ?? 0) as number | bigint,
    };
  }

  iterate(params?: readonly unknown[]): IterableIterator<unknown> {
    return this.#stmt.iterate(...(spread(params) as never[])) as IterableIterator<unknown>;
  }
}

/**
 * 与 better-sqlite3 的 `Database` 接口兼容的薄包装，直接喂给 Kysely 的 SqliteDialect。
 */
export class NodeSqliteDatabase {
  readonly #db: DatabaseSync;

  constructor(filePath: string, opts: { readonly?: boolean } = {}) {
    this.#db = new DatabaseSyncCtor(filePath, {
      readOnly: opts.readonly ?? false,
      // 与 Python 版一致：默认不强制外键（见 cloud/db.py）
      enableForeignKeyConstraints: false,
    });
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatementImpl(this.#db.prepare(sql));
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  /** better-sqlite3 风格的 pragma：`db.pragma('journal_mode = WAL')` */
  pragma(stmt: string): unknown {
    return this.#db.prepare(`PRAGMA ${stmt}`).all();
  }

  close(): void {
    this.#db.close();
  }

  /** 暴露原生句柄（迁移器需要 exec 多语句） */
  get raw(): DatabaseSync {
    return this.#db;
  }
}
