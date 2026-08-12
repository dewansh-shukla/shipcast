import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

/**
 * Bundle the CLI into one file.
 *
 * Two reasons this is a bundle rather than a set of published packages. The CLI
 * depends on `@ao-wrapped/shared`, a workspace package that is not on npm, so a
 * consumer resolving dependencies normally would install `ao-wrapped` and then
 * fail to find half of it. And the source is TypeScript, which needs a flag on
 * Node below 23.6 — shipping plain JavaScript means `npx ao-wrapped` works on
 * whatever Node someone happens to have.
 *
 * No shebang banner here: `src/index.ts` already starts with one and esbuild
 * preserves it. Adding a second puts a `#!` on line 2, which is a syntax error
 * rather than a comment.
 */
const out = "dist/ao-wrapped.js";

// The directory previously held tsc output. Publishing whatever happens to be
// left behind is how stale files ship, so start from nothing every time.
await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  minify: false, // a CLI someone may read before running it
});

// npm preserves the mode recorded in the tarball; without this the bin is not
// executable for anyone who installs it.
await chmod(out, 0o755);

console.log(`built ${out}`);
