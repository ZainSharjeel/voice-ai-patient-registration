import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, loadEnv } from "vite";
import { buildInputsStampPlugin } from "./scripts/build-inputs.ts";
import {
  builtAccessModePlugin,
  describeOverrides,
  descriptorBuildEnv,
  readDescriptorAuth,
} from "./scripts/space-access-mode.ts";

export default defineConfig(({ mode }) => {
  const root = import.meta.dirname;
  const env = loadEnv(mode, root, "VITE_");
  const overrides = descriptorBuildEnv(readDescriptorAuth(root), env);
  const note = describeOverrides(overrides, env);
  if (note) console.log(note);
  // Vite gives variables already in process.env priority over .env files.
  Object.assign(process.env, overrides);

  return {
    plugins: [
      react(),
      tailwindcss(),
      buildInputsStampPlugin(root),
      builtAccessModePlugin(root),
    ],
    resolve: {
      alias: {
        "@": path.resolve(root, "src"),
      },
    },
  };
});
