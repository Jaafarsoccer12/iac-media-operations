import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const config = defineCloudflareConfig();

// Use the supported Webpack builder for Cloudflare builds on Windows.
config.buildCommand = "npm run build -- --webpack";

export default config;
