import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// `process` is typed via the SvelteKit/Vite ambient env.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // Tauri dev settings (distinct ports from the desktop app's 1420/1421).
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1431,
      }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
