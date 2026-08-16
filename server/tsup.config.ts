import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  external: ['better-sqlite3', 'sharp', 'ffmpeg-static', 'adm-zip', 'openai', 'hono', '@hono/node-server', 'zod'],
});
