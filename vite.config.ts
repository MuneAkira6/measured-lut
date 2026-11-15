import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the site under /measured-lut/.
export default defineConfig({
  base: "/measured-lut/",
  plugins: [react()],
  test: { include: ["tests/**/*.test.ts"] },
});
