#!/usr/bin/env node
// Copies the canonical Claude skill from `<repo-root>/.claude/skills/calendar-station/`
// into the *current* package's `.claude/skills/calendar-station/` so it ships in the
// npm tarball.
//
// Each publishable package's `prepack` script runs this file from the package dir
// (npm/pnpm cd into the package before running scripts). The script walks up to
// find the workspace root by looking for `pnpm-workspace.yaml`.

import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

/** Walk up from `start` until we find a directory containing `marker`. */
const findUp = async (start, marker) => {
  let dir = start
  while (true) {
    try {
      await fs.access(path.join(dir, marker))
      return dir
    } catch { /* not here */ }
    const next = path.dirname(dir)
    if (next === dir) throw new Error(`could not find ${marker} above ${start}`)
    dir = next
  }
}

const copyDir = async (src, dst) => {
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else await fs.copyFile(s, d)
  }
}

const rmDir = async (p) => {
  await fs.rm(p, { recursive: true, force: true })
}

const main = async () => {
  // The script lives at `<root>/scripts/sync-skill.mjs`; the canonical skill is
  // a sibling of `scripts/` under `.claude/skills/`.
  const repoRoot = await findUp(here, "pnpm-workspace.yaml")
  const src = path.join(repoRoot, ".claude", "skills", "calendar-station")
  const pkgDir = process.cwd()

  // Sanity: the cwd must be inside the workspace (catches accidental npm-link calls).
  if (!pkgDir.startsWith(repoRoot)) {
    console.error(`[sync-skill] cwd ${pkgDir} is not inside ${repoRoot}; skipping`)
    process.exit(0)
  }
  if (pkgDir === repoRoot) {
    console.error(`[sync-skill] running from repo root; nothing to copy into`)
    process.exit(0)
  }

  const dst = path.join(pkgDir, ".claude", "skills", "calendar-station")
  await rmDir(path.join(pkgDir, ".claude"))
  await copyDir(src, dst)
  console.log(`[sync-skill] synced ${src} → ${dst}`)
}

main().catch((e) => {
  console.error("[sync-skill] failed:", e)
  process.exit(1)
})
