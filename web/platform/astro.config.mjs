import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  output: "static",
  site: "https://platform.knowable.ca",
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    react(),
  ],
});
