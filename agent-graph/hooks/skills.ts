import type { FsEntry, FsStat } from 'claude-code'

// The file calls skillDirs makes, so tests can answer them without a Host.
export type SkillFs = {
  list(path: string): Promise<readonly FsEntry[]>
  exists(path: string): Promise<boolean>
  stat(path: string, options: { resolve: true }): Promise<FsStat>
}

// `\` read as `/`, no trailing `/`; a drive path (Windows) compares in lower case.
const plain = (path: string): string => {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(p) ? p.toLowerCase() : p
}

// Whether `path` is `root` or below it.
export function isInside(root: string, path: string): boolean {
  const r = plain(root)
  const p = plain(path)
  return p === r || p.startsWith(`${r}/`)
}

// Each skill folder by name, `${home}/.claude/skills` then `.claude/skills` (a project skill of the same name wins).
// A folder counts when it has SKILL.md; a link only when the folder it leads to lands inside home's real path (what
// Cloud uploads stays under home; the upload walk skips nested links). Every check runs at once; the result keeps
// the listing order.
export async function skillDirs(fs: SkillFs, home: string): Promise<Record<string, string>> {
  let realHome: Promise<string> | undefined
  const homeRoot = () => (realHome ??= fs.stat(home, { resolve: true }).then(s => s.realPath ?? home, () => home))
  const isSkill = async (path: string, entry: FsEntry): Promise<boolean> => {
    if (entry.isLink) {
      const [to, root] = await Promise.all([fs.stat(path, { resolve: true }), homeRoot()])
      if (to.kind !== 'dir' || to.realPath === undefined || !isInside(root, to.realPath)) return false
    } else if (entry.kind !== 'dir') return false
    return fs.exists(`${path}/SKILL.md`)
  }
  const checked = await Promise.all([`${home}/.claude/skills`, '.claude/skills'].map(async root => {
    const entries = await fs.list(root).catch(() => [])
    return Promise.all(entries.map(async e => ({ name: e.name, path: `${root}/${e.name}`, ok: await isSkill(`${root}/${e.name}`, e).catch(() => false) })))
  }))
  const found: Record<string, string> = {}
  for (const { name, path, ok } of checked.flat()) if (ok) found[name] = path
  return found
}
