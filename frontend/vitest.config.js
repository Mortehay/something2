import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
  // The AUTOMATIC JSX runtime, matching how the app itself is built.
  //
  // vite.config.js applies @vitejs/plugin-react, which defaults to the
  // automatic runtime, so no component in src/ imports React -- and none needs
  // to. This config does not load that plugin, so esbuild fell back to the
  // CLASSIC runtime and compiled JSX to React.createElement against a `React`
  // that is nowhere in scope. Every existing test only checks that a component
  // is exported, never renders one, so the mismatch stayed invisible until the
  // first test called renderToStaticMarkup and got "React is not defined".
  esbuild: { jsx: "automatic" },
});
