import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{shared,server,client}/src/**/*.test.ts"],
  },
});
