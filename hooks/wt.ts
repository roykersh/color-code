import type { EngineInterface } from 'claude-code'

// Windows Terminal can't take a tab color from inside the tab, but a theme
// can make tabs and the title bar follow each tab's own background, which
// OSC 11 sets. This adds that theme to Windows Terminal's settings.json and
// makes it active, keeping everything else; undo puts the old theme back.

export const THEME = 'Color Code'

type WtJson = { theme?: unknown; themes?: unknown; [key: string]: unknown }
type WtTheme = { name?: unknown; window?: { applicationTheme?: unknown }; tab?: { background?: unknown } }

// What setup remembers in $.store: the theme each file had before.
export type WtMemory = { answer?: 'yes' | 'no'; askedAt?: number; previous?: Record<string, string | null> }

// Stable, Preview, Canary and the unpackaged (zip/scoop) install.
export async function wtFiles($: EngineInterface): Promise<string[]> {
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return []
  const found: string[] = []
  for (const path of [
    `${local}/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`,
    `${local}/Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json`,
    `${local}/Packages/Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe/LocalState/settings.json`,
    `${local}/Microsoft/Windows Terminal/settings.json`,
  ]) {
    if (await $.fs.exists(path).catch(() => false)) found.push(path)
  }
  return found
}

// settings.json is JSON with comments; comments don't survive a rewrite (the
// backup keeps them).
export function parseJsonc(text: string): WtJson {
  text = text.replace(/^﻿/, '')
  try {
    return JSON.parse(text)
  } catch {
    // fall through to the comment-stripping read
  }
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function themes(json: WtJson): WtTheme[] {
  return Array.isArray(json.themes) ? (json.themes as WtTheme[]) : []
}

// The active theme name(s): a string, or {dark, light} on newer builds.
function activeNames(json: WtJson): string[] {
  if (typeof json.theme === 'string') return [json.theme]
  if (json.theme && typeof json.theme === 'object') return Object.values(json.theme).filter((v): v is string => typeof v === 'string')
  return []
}

// True when the active theme already lets tabs follow the background.
export function follows(json: WtJson): boolean {
  const names = activeNames(json)
  return names.length > 0 && names.every(n => themes(json).some(t => t?.name === n && t.tab?.background === 'terminalBackground'))
}

function appTheme(json: WtJson): string {
  const name = activeNames(json)[0]
  if (name === 'light' || name === 'legacyLight') return 'light'
  if (name === 'system' || name === 'legacySystem') return 'system'
  const own = themes(json).find(t => t?.name === name)?.window?.applicationTheme
  return typeof own === 'string' ? own : 'dark'
}

// Pure: the settings with our theme added and active.
export function withTheme(json: WtJson): WtJson {
  const ours = {
    name: THEME,
    window: { applicationTheme: appTheme(json), useMica: false },
    tabRow: { background: 'terminalBackground', unfocusedBackground: 'terminalBackground' },
    tab: { background: 'terminalBackground', unfocusedBackground: 'terminalBackground', showCloseButton: 'hover' },
  }
  return { ...json, themes: [...themes(json).filter(t => t?.name !== THEME), ours], theme: THEME }
}

// Pure: the settings with our theme gone and `previous` active again.
export function withoutTheme(json: WtJson, previous: string | null | undefined): WtJson {
  const out: WtJson = { ...json, themes: themes(json).filter(t => t?.name !== THEME) }
  if (activeNames(json).includes(THEME)) {
    if (previous) out.theme = previous
    else delete out.theme
  }
  return out
}

const stringify = (json: WtJson) => `${JSON.stringify(json, null, 4)}\n`

// Files whose active theme does not follow the tab background.
export async function wtMissing($: EngineInterface, files: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const file of files) {
    try {
      if (!follows(parseJsonc(await $.fs.read(file)))) missing.push(file)
    } catch {
      // unreadable: leave it to the person
    }
  }
  return missing
}

// Backs each file up (once: the backup is the state before Color Code), then
// adds and activates the theme. Resolves to what changed, for the person.
export async function wtSetup($: EngineInterface, memory: WtMemory): Promise<{ text: string; changed: boolean; memory: WtMemory }> {
  const files = await wtFiles($)
  if (files.length === 0) return { text: 'Windows Terminal settings not found.', changed: false, memory }
  const lines: string[] = []
  const previous = { ...memory.previous }
  let changed = false
  for (const file of files) {
    try {
      const text = await $.fs.read(file)
      const json = parseJsonc(text)
      if (follows(json)) {
        lines.push(`${file}: tabs already follow the background.`)
        continue
      }
      const backup = `${file}.color-code.bak`
      if (!(await $.fs.exists(backup))) await $.fs.write(backup, text)
      previous[file] = activeNames(json)[0] ?? null
      await $.fs.write(file, stringify(withTheme(json)))
      changed = true
      lines.push(`${file}: added the "${THEME}" theme and made it active (backup: ${backup}).`)
    } catch (err) {
      lines.push(`${file}: left as it was (${String(err)}).`)
    }
  }
  return { text: lines.join('\n'), changed, memory: { ...memory, previous } }
}

export async function wtUndo($: EngineInterface, memory: WtMemory): Promise<{ text: string; changed: boolean }> {
  const lines: string[] = []
  let changed = false
  for (const file of await wtFiles($)) {
    try {
      const json = parseJsonc(await $.fs.read(file))
      if (!themes(json).some(t => t?.name === THEME)) {
        lines.push(`${file}: no Color Code theme in it.`)
        continue
      }
      const prev = memory.previous?.[file]
      await $.fs.write(file, stringify(withoutTheme(json, prev)))
      changed = true
      lines.push(`${file}: removed the "${THEME}" theme${prev ? `, "${prev}" is active again` : ''}. The original is kept at ${file}.color-code.bak.`)
    } catch (err) {
      lines.push(`${file}: left as it was (${String(err)}).`)
    }
  }
  return { text: lines.join('\n') || 'Windows Terminal settings not found.', changed }
}
