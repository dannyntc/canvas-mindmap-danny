import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  target: ["es2020"],
  format: "cjs",
  external: ["obsidian"],
  outfile: "main.js",
  sourcemap: false,
  minify: production,
  legalComments: "eof",
  banner: {
    js: "/*! Canvas-Mindmap-Danny 1.1.16 — Copyright (c) Danny; original work by Boninall — MIT License */",
  },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Canvas Mindmap development build watching src/");
} else {
  await esbuild.build(options);
}
