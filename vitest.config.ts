import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Dynamic route imports and native image modules can exceed Vitest's 5s
    // default on the first test when the full suite runs concurrently.
    testTimeout: 15_000,
    // Unit tests target pure logic — exclude anything needing a DB/Redis/network.
    globals: false,
  },
  resolve: {
    // Mirror the tsconfig "paths" aliases so imports resolve in tests.
    // Longest prefix first: Vite matches these in order.
    alias: [
      { find: /^@\/shared\//, replacement: `${r("src/shared")}/` },
      { find: /^@\/ui\//, replacement: `${r("src/ui")}/` },
      { find: /^@shell\//, replacement: `${r("src/shell")}/` },
      { find: /^@brain\//, replacement: `${r("src/features/brain")}/` },
      { find: /^@auth\//, replacement: `${r("src/features/auth")}/` },
      { find: /^@files\//, replacement: `${r("src/features/files")}/` },
      { find: /^@admin\//, replacement: `${r("src/features/admin")}/` },
      { find: /^@shares\//, replacement: `${r("src/features/shares")}/` },
      { find: /^@backup\//, replacement: `${r("src/features/backup")}/` },
      { find: /^@\//, replacement: `${r(".")}/` },
    ],
  },
});
