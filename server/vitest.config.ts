import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // 迁移/DB 测试会碰文件系统，串行更稳
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    server: {
      deps: {
        // vite 的内置模块 externals 列表里还没有 node:sqlite（Node 24 才正式），
        // 不显式排除会被当成 npm 包去解析，报 "Failed to load url sqlite"
        external: [/^node:/, 'sqlite'],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
