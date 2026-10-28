import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'client/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
