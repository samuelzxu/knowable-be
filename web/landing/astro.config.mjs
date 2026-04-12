import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
// TODO: re-enable @astrojs/sitemap once the integration is compatible with this Astro version
// import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  output: "static",
  site: "https://knowable.ca",
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    // sitemap(),
  ],
});
