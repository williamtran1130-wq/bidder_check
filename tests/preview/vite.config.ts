import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: here("./"),
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify("https://upload.example.test"),
    "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("fixture-key"),
    "process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY": JSON.stringify("AQID"),
  },
  server: { host: "127.0.0.1", port: 3001, fs: { allow: [here("../../")] } },
  resolve: {
    alias: [
      { find: "@/lib/read-client", replacement: here("./read-client.ts") },
      { find: "@/lib/client", replacement: here("./client.ts") },
      { find: "@/app/(workspace)/notification-actions", replacement: here("./notification-actions.ts") },
      { find: "@/app/(workspace)/upload-context-actions", replacement: here("./upload-context-actions.ts") },
      { find: "@/app/(workspace)/actions", replacement: here("./actions.ts") },
      { find: "@/app/auth/actions", replacement: here("./actions.ts") },
      { find: "next/navigation", replacement: here("./navigation.ts") },
      { find: "next/link", replacement: here("./link.tsx") },
      { find: "@", replacement: here("../../src") },
    ],
  },
});
