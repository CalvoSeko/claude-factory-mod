import { expect } from 'claude-code/testing'
import { test } from './kit'

import { isInside, skillDirs, type SkillFs } from '../hooks/skills'
import type { FsEntry, FsStat } from 'claude-code'

const HOME = '/home/me'
const SKILLS = `${HOME}/.claude/skills`

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const link = (name: string): FsEntry => ({ name, kind: 'other', size: 0, mtimeMs: 0, isLink: true })
const lands = (kind: FsStat['kind'], realPath?: string): FsStat => ({ kind, size: 0, mtimeMs: 0, isLink: true, realPath })

// A file system of folder listings, files that exist and what each path resolves to; anything else rejects.
function fakeFs(lists: Record<string, FsEntry[]>, files: string[], stats: Record<string, FsStat> = {}) {
  const statted: string[] = []
  const fs: SkillFs = {
    list: async path => lists[path] ?? Promise.reject(new Error(`ENOENT ${path}`)),
    exists: async path => files.includes(path),
    stat: async path => {
      statted.push(path)
      return stats[path] ?? Promise.reject(new Error(`ENOENT ${path}`))
    },
  }
  return { fs, statted }
}

test('a path is inside a root as the root itself or below it, slashes either way, a drive in any case', () => {
  for (const [root, path] of [
    ['C:/Users/me', 'C:\\Users\\me\\.agents\\skills\\x'],
    ['C:/Users/me', 'c:\\users\\me\\.agents\\skills\\x'],
    ['C:/Users/me/', 'C:/Users/me'],
    ['C:\\Users\\me', 'C:/Users/me/'],
    ['/home/me', '/home/me/.agents/skills/x'],
  ]) expect(isInside(root!, path!), `${path} in ${root}`).toBe(true)
  for (const [root, path] of [
    ['C:/Users/me', 'C:\\Users\\meow\\.agents\\skills\\x'],
    ['C:/Users/me', 'D:\\Users\\me\\x'],
    ['C:/Users/me', 'C:/Users'],
    ['/home/me', '/home/Me/x'],
    ['/home/me', '/home/meow/x'],
  ]) expect(isInside(root!, path!), `${path} in ${root}`).toBe(false)
})

test('real skill folders count with SKILL.md, in listing order; a project skill of the same name wins', async () => {
  const { fs, statted } = fakeFs({
    [SKILLS]: [dir('b-skill'), dir('no-skill-md'), dir('.trash'), file('README.md'), dir('a-skill')],
    '.claude/skills': [dir('c-skill'), dir('b-skill')],
  }, [`${SKILLS}/b-skill/SKILL.md`, `${SKILLS}/a-skill/SKILL.md`, '.claude/skills/c-skill/SKILL.md', '.claude/skills/b-skill/SKILL.md'])
  const found = await skillDirs(fs, HOME)
  expect(found).toEqual({ 'b-skill': '.claude/skills/b-skill', 'a-skill': `${SKILLS}/a-skill`, 'c-skill': '.claude/skills/c-skill' })
  expect(Object.keys(found)).toEqual(['b-skill', 'a-skill', 'c-skill'])
  expect(statted).toEqual([])
})

test('a linked skill counts only when its folder resolves inside home and has SKILL.md', async () => {
  const names = ['inside', 'outside', 'broken', 'to-file', 'no-md', 'withheld']
  const { fs, statted } = fakeFs({ [SKILLS]: names.map(link) }, [
    // The outside folder's SKILL.md links back inside home: the folder is what is checked, so it still does not count.
    ...['inside', 'outside', 'to-file', 'withheld'].map(n => `${SKILLS}/${n}/SKILL.md`),
  ], {
    [HOME]: lands('dir', HOME),
    [`${SKILLS}/inside`]: lands('dir', `${HOME}/.agents/skills/inside`),
    [`${SKILLS}/outside`]: lands('dir', '/opt/skills/outside'),
    [`${SKILLS}/to-file`]: lands('file', `${HOME}/.agents/skills/to-file`),
    [`${SKILLS}/no-md`]: lands('dir', `${HOME}/.agents/skills/no-md`),
    [`${SKILLS}/withheld`]: lands('dir'),
  })
  expect(await skillDirs(fs, HOME)).toEqual({ inside: `${SKILLS}/inside` })
  expect(statted.filter(p => p === HOME)).toEqual([HOME])
})

test('links compare against the real path of home: a linked home, a home that cannot be resolved, a drive in any case', async () => {
  const linkedHome = fakeFs({ [SKILLS]: [link('x'), link('y')] }, [`${SKILLS}/x/SKILL.md`, `${SKILLS}/y/SKILL.md`], {
    [HOME]: lands('dir', '/data/me'),
    [`${SKILLS}/x`]: lands('dir', '/data/me/.agents/skills/x'),
    [`${SKILLS}/y`]: lands('dir', '/data/meow/skills/y'),
  })
  expect(await skillDirs(linkedHome.fs, HOME)).toEqual({ x: `${SKILLS}/x` })

  const unresolved = fakeFs({ [SKILLS]: [link('x')] }, [`${SKILLS}/x/SKILL.md`], { [`${SKILLS}/x`]: lands('dir', `${HOME}/.agents/skills/x`) })
  expect(await skillDirs(unresolved.fs, HOME)).toEqual({ x: `${SKILLS}/x` })

  const win = 'C:/Users/me'
  const winSkills = `${win}/.claude/skills`
  const drive = fakeFs({ [winSkills]: [link('x'), link('lower'), link('meow')] }, ['x', 'lower', 'meow'].map(n => `${winSkills}/${n}/SKILL.md`), {
    [win]: lands('dir', 'C:\\Users\\me'),
    [`${winSkills}/x`]: lands('dir', 'C:\\Users\\me\\.agents\\skills\\x'),
    [`${winSkills}/lower`]: lands('dir', 'c:\\users\\me\\.agents\\skills\\lower'),
    [`${winSkills}/meow`]: lands('dir', 'C:\\Users\\meow\\.agents\\skills\\meow'),
  })
  expect(await skillDirs(drive.fs, win)).toEqual({ x: `${winSkills}/x`, lower: `${winSkills}/lower` })
})

test('a skills folder that cannot be listed adds nothing', async () => {
  const { fs } = fakeFs({ '.claude/skills': [dir('c-skill')] }, ['.claude/skills/c-skill/SKILL.md'])
  expect(await skillDirs(fs, HOME)).toEqual({ 'c-skill': '.claude/skills/c-skill' })
  expect(await skillDirs(fakeFs({}, []).fs, HOME)).toEqual({})
})
