import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Source files use NodeNext-style ".js" specifiers that point at ".ts"
    // files. Vite needs the extension removed to resolve them during tests.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
});
