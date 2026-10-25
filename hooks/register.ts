import type { EngineInterface, Register } from 'claude-code'
import { platform, send } from './term.ts'
import { type WtMemory, wtFiles, wtMissing, wtSetup, wtUndo } from './wt.ts'

// /color <name> themes the whole session: Claude Code switches to the matching
// theme in themes/ (this process only, through the settings it reads), and the
// terminal tab gets that theme's background, text, cursor and palette over
// OSC, which follows the tab alone, so every tab keeps its own color. The tab
// also shows whether Claude is working, waiting on you, or idle.
//
// Everything that leans on Claude Code's internals (how /color reports, the
// transcript, the theme reference) fails soft: the terminal part goes on.

const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
const RESETS = ['default', 'reset', 'none', 'gray', 'grey']
const HEAL_MS = 15_000

type Variant = 'dark' | 'light'
type Mode = Variant | 'auto'
type Activity = 'idle' | 'busy' | 'attention'
type TerminalPalette = { background: string; foreground: string; cursor: string; tab?: string; ansi: string[] }

// Module state; a reload starts it over and session.start finds it again.
let color: string | undefined
let mode: Mode = 'auto'
let ownTheme: string | undefined // the person's theme setting, before ours
let showActivity = true
let turning = false
const waiting: string[] = [] // tools whose prompt is up
let lastBatch = ''
let lastSentAt = 0
let heal: { cancel: () => void } | undefined
let transcriptPath: string | undefined
const palettes = new Map<string, TerminalPalette>()

const variant = (): Variant => (mode !== 'auto' ? mode : /light/i.test(ownTheme ?? '') ? 'light' : 'dark')
const themeFile = (name: string | undefined) => (name === undefined ? undefined : variant() === 'light' ? `${name}-light` : name)
const themeRef = (file: string) => `custom:color-code:${file}`
const activity = (): Activity => (waiting.length > 0 ? 'attention' : turning ? 'busy' : 'idle')

let logged = ''

// Set COLOR_CODE_DEBUG=1 to write what each step did to debug.log.
async function log($: EngineInterface, line: string) {
  try {
    if (!(await $.env.get('COLOR_CODE_DEBUG'))) return
    logged += `${new Date().toISOString()} ${line}\n`
    await $.fs.write(`${$.plugin.root}/debug.log`, logged)
  } catch {
    // logging never breaks anything
  }
}

// Runs fn outside the hook that asked, so a turn or prompt never waits on it.
function later($: EngineInterface, fn: () => Promise<unknown>, ms = 1) {
  try {
    $.clock.after(ms, () => void fn().catch(err => log($, `later: ${String(err)}`)))
  } catch {
    void fn().catch(() => undefined)
  }
}

async function palette($: EngineInterface, file: string): Promise<TerminalPalette | undefined> {
  const cached = palettes.get(file)
  if (cached) return cached
  try {
    const t: TerminalPalette = JSON.parse(await $.fs.read(`${$.plugin.root}/themes/${file}.json`)).terminal
    if (!t?.background || !Array.isArray(t.ansi)) return undefined
    palettes.set(file, t)
    return t
  } catch {
    return undefined
  }
}

function hexBytes(hex: string): number[] {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Everything the tab should hold now, as OSC bodies: one batch, one process.
async function batch($: EngineInterface, reset: boolean): Promise<string[]> {
  const p = await platform($)
  const bodies: string[] = []
  const file = themeFile(color)
  const t = file ? await palette($, file) : undefined
  if (t) {
    bodies.push(`11;${t.background}`, `10;${t.foreground}`, `12;${t.cursor}`, ...t.ansi.map((c, i) => `4;${i};${c}`))
    if (p.iterm) {
      const [r, g, b] = hexBytes(t.tab ?? t.cursor)
      bodies.push(`6;1;bg;red;brightness;${r}`, `6;1;bg;green;brightness;${g}`, `6;1;bg;blue;brightness;${b}`)
    }
  } else if (reset) {
    bodies.push('104', '110', '111', '112')
    if (p.iterm) bodies.push('6;1;bg;*;default')
  }
  if (p.progress && (showActivity || reset)) {
    const state = showActivity ? activity() : 'idle'
    // 3: the spinning ring; 4 at 100: a full yellow ring, waiting on you.
    bodies.push(state === 'busy' ? '9;4;3' : state === 'attention' ? '9;4;4;100' : '9;4;0')
  }
  return bodies
}

// Sends the batch when it changed, or when healing (a tab moved to another
// window, or a Windows Terminal settings reload, drops OSC colors; the same
// colors again repaint nothing visible). Sends never overlap.
let inflight: Promise<void> | undefined
let again: { heal: boolean; reset: boolean } | undefined

function paint($: EngineInterface, opts: { heal?: boolean; reset?: boolean } = {}): Promise<void> {
  if (inflight) {
    again = { heal: Boolean(again?.heal || opts.heal), reset: Boolean(again?.reset || opts.reset) }
    return inflight
  }
  inflight = (async () => {
    let next: { heal?: boolean; reset?: boolean } | undefined = opts
    while (next) {
      again = undefined
      try {
        await paintOnce($, next)
      } catch (err) {
        await log($, `paint: ${String(err)}`)
      }
      next = again
    }
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

async function paintOnce($: EngineInterface, opts: { heal?: boolean; reset?: boolean }) {
  const bodies = await batch($, Boolean(opts.reset))
  const key = bodies.join('|')
  const now = await $.clock.now()
  // A change always goes out; a heal re-sends the same only for a colored
  // tab, and twice in two seconds is once.
  if (key === lastBatch && !(opts.heal && color !== undefined && now - lastSentAt >= 2000)) return
  lastBatch = key
  lastSentAt = now
  await log($, `send ${bodies.length} (${bodies[0] ?? ''}) -> ${await send($, $.plugin.root, bodies)}`)
}

async function claudeHome($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))}/.claude`
}

// The engine merges settings again when a settings file changes; rewriting the
// user file as it stands makes it ask the settings.read hook below again.
async function refreshSettings($: EngineInterface) {
  try {
    const path = `${await claudeHome($)}/settings.json`
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) await $.fs.write(path, text)
    await log($, `refreshed ${path}: ${text !== undefined}`)
  } catch (err) {
    await log($, `refresh failed: ${String(err)}`)
  }
}

function keepHealing($: EngineInterface) {
  if (color !== undefined && heal === undefined) {
    try {
      heal = $.clock.every(HEAL_MS, () => void paint($, { heal: true }))
    } catch {
      heal = undefined
    }
  } else if (color === undefined && heal !== undefined) {
    heal.cancel()
    heal = undefined
  }
}

async function apply($: EngineInterface, name: string | undefined, why: string) {
  const before = themeFile(color)
  color = name !== undefined && COLORS.includes(name) ? name : undefined
  await log($, `apply ${color ?? 'reset'} (${variant()}) from ${why}`)
  // Survives a reload of this module, for this session only.
  await $.env.set('COLOR_CODE_STATE', color ? `${await $.session.id()} ${color}` : undefined).catch(() => undefined)
  keepHealing($)
  await paint($, { reset: color === undefined })
  if (themeFile(color) !== before) await refreshSettings($)
}

// After a Windows Terminal settings reload clears every tab, paint this one.
function repaintSoon($: EngineInterface) {
  for (const ms of [1500, 4000]) later($, () => paint($, { heal: true }), ms)
}

function setActivity($: EngineInterface) {
  if (showActivity) later($, () => paint($))
}

// ---- where the color comes from -------------------------------------------

async function transcriptFile($: EngineInterface, cwd: string): Promise<string | undefined> {
  if (transcriptPath && (await $.fs.exists(transcriptPath).catch(() => false))) return transcriptPath
  const home = await claudeHome($)
  const id = await $.session.id()
  const guess = `${home}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess).catch(() => false)) return guess
  // Long paths are shortened differently: look in every project folder.
  for (const dir of await $.fs.list(`${home}/projects`).catch(() => [])) {
    const path = `${home}/projects/${dir.name}/${id}.jsonl`
    if (dir.kind === 'dir' && (await $.fs.exists(path).catch(() => false))) return path
  }
  return undefined
}

// The color the transcript last recorded for this session (resume, a bare
// /color). Missing or changed format: undefined, never a throw.
async function savedColor($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const file = await transcriptFile($, cwd)
    if (!file) return undefined
    const p = await platform($)
    const found = await $.process
      .run(p.windows ? ['findstr', '/R', '/B', '/C:{.type.:.agent-color.', file] : ['grep', '^{"type":"agent-color"', file])
      .catch(() => undefined)
    let lines = found?.stdout
    if (lines === undefined || found?.exitCode === 2) lines = await $.fs.read(file).catch(() => '')
    const last = lines.split(/\r?\n/).filter(l => l.includes('"agent-color"')).at(-1)
    if (!last) return undefined
    const named = /"agentColor"\s*:\s*"(\w+)"/.exec(last)?.[1]
    return named && COLORS.includes(named) ? named : undefined
  } catch {
    return undefined
  }
}

// A stable color per project, for sessions nobody colored.
export function projectColor(root: string): string {
  let h = 0x811c9dc5
  for (const ch of root.toLowerCase().replace(/[\\/]+$/, '')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return COLORS[h % COLORS.length] ?? 'blue'
}

// ---- Windows Terminal: offer the tab-follows-background theme once --------

const YES = 'Yes, color my tabs'
const NO = 'No thanks'

async function offerTabs($: EngineInterface) {
  const p = await platform($)
  if (!p.windows || !(await $.env.get('WT_SESSION'))) return
  const files = await wtFiles($)
  if (files.length === 0 || (await wtMissing($, files)).length === 0) return
  const memory = ((await $.store.get('wt')) ?? {}) as WtMemory
  // Asked again only when they said yes and Windows Terminal lost it since.
  if (memory.answer === 'no') return
  const now = await $.clock.now()
  if (memory.askedAt !== undefined && now - memory.askedAt < 10 * 60_000) return // another tab is asking
  await $.store.set('wt', { ...memory, askedAt: now })
  let answer: string
  try {
    answer = await $.ui.ask(
      memory.answer === 'yes'
        ? 'Windows Terminal lost the Color Code tab theme (an update or a reset). Put it back so tabs and the title bar follow each session color?'
        : 'Color Code can make Windows Terminal tabs and the title bar follow each session color. Update its settings (a backup is kept)?',
      { options: [YES, NO], header: 'Color Code' },
    )
  } catch {
    return // dismissed: ask another time
  }
  if (answer === YES) {
    const done = await wtSetup($, memory)
    await $.store.set('wt', { ...done.memory, answer: 'yes', askedAt: now })
    $.ui.toast(done.changed ? 'Tabs now follow the session color. Undo any time: /color-code undo-setup' : done.text)
    if (done.changed) repaintSoon($)
  } else if (answer === NO) {
    await $.store.set('wt', { ...memory, answer: 'no', askedAt: now })
    $.ui.toast('Left Windows Terminal alone. /color-code setup does it any time.')
  }
}

// ---- /color-code ------------------------------------------------------------

async function colorCode($: EngineInterface, args: string): Promise<string> {
  const [word = ''] = args.trim().toLowerCase().split(/\s+/)
  if (word === 'light' || word === 'dark' || word === 'auto') {
    mode = word
    await $.store.set('mode', word)
    if (color !== undefined) {
      await paint($)
      await refreshSettings($)
    }
    return `Color Code: ${word === 'auto' ? `following your Claude theme (${variant()} now)` : `${word} variants`}, here and in new sessions.`
  }
  if (word === 'setup' || word === 'undo-setup') {
    const p = await platform($)
    if (!p.windows) return 'Nothing to set up here: macOS and Linux terminals take the colors as they are.'
    const memory = ((await $.store.get('wt')) ?? {}) as WtMemory
    if (word === 'setup') {
      const done = await wtSetup($, memory)
      await $.store.set('wt', { ...done.memory, answer: 'yes' })
      if (done.changed) repaintSoon($)
      return done.text
    }
    const undone = await wtUndo($, memory)
    await $.store.set('wt', { ...memory, answer: 'no', previous: {} })
    if (undone.changed) repaintSoon($)
    return undone.text
  }
  const p = await platform($)
  const where = p.windows ? 'Windows (osc.exe)' : `${p.tmux ? 'tmux on ' : ''}${p.iterm ? 'iTerm2' : 'a Unix terminal'}`
  let tabs = ''
  if (p.windows) {
    const files = await wtFiles($)
    const missing = files.length ? await wtMissing($, files) : []
    tabs = files.length === 0 ? 'Windows Terminal: not found.' : missing.length ? 'Windows Terminal: tabs keep their own color (run /color-code setup).' : 'Windows Terminal: tabs follow the session color.'
  }
  return [
    `Color Code: ${color ? `${color} (${variant()})` : 'no color'} on ${where}; mode ${mode}.`,
    `Tab activity ring: ${showActivity ? (p.progress ? 'on' : 'on, but this terminal has no ring') : 'off'}.`,
    tabs,
    'Usage: /color <name> colors the session; /color-code light|dark|auto picks the variant; /color-code setup|undo-setup changes Windows Terminal.',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---- hooks ------------------------------------------------------------------

export const register: Register = (on, options) => {
  showActivity = options.activity !== false
  const autoColor = options.autoColor === true

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'color-code', description: 'Color Code status, light/dark/auto, Windows Terminal setup', argumentHint: '[light|dark|auto|setup|undo-setup]' })
      .catch(() => undefined)
    const started = await next(e)
    try {
      await log($, `session.start interactive=${e.isInteractive}`)
      if (!e.isInteractive) return started
      const stored = await $.store.get('mode').catch(() => undefined)
      if (stored === 'light' || stored === 'dark' || stored === 'auto') mode = stored
      ownTheme ??= String((await $.settings.read({ key: 'theme' }).catch(() => undefined)) ?? '')
      // A reload of this module (same session), then the transcript, then auto.
      const [id, kept = ''] = ((await $.env.get('COLOR_CODE_STATE')) ?? '').split(' ')
      const pick =
        (id === (await $.session.id()) && COLORS.includes(kept) ? kept : undefined) ??
        (await savedColor($, e.cwd)) ??
        (autoColor ? projectColor(await $.session.root().catch(() => e.cwd)) : undefined)
      if (pick !== undefined) await apply($, pick, 'session start')
      later($, () => offerTabs($), 2500)
    } catch (err) {
      await log($, `session.start: ${String(err)}`)
    }
    return started
  })

  // The transcript's own path, from the classic event that carries it.
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.transcript_path === 'string') transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'color' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const said = ran.text ?? ''
      await log($, `command.run color args=${JSON.stringify(e.args)} text=${JSON.stringify(said)}`)
      // The argument first; the printed line second (the picker form prints
      // nothing); a bare /color picks at random and only the transcript knows.
      const arg = e.args.trim().toLowerCase()
      const told = /color set to:?\s*(\w+)/i.exec(said)?.[1]?.toLowerCase()
      if (COLORS.includes(arg)) await apply($, arg, '/color')
      else if (RESETS.includes(arg) || /reset to default/i.test(said)) await apply($, undefined, '/color')
      else if (told !== undefined && COLORS.includes(told)) await apply($, told, '/color text')
      else {
        const saved = await savedColor($, await $.session.cwd())
        await log($, `/color ${arg}: transcript says ${saved}`)
        if (saved !== undefined && saved !== color) await apply($, saved, '/color transcript')
      }
    } catch (err) {
      await log($, `/color: ${String(err)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'color-code' }, async ($, e) => ({ text: await colorCode($, e.args) })).catch(
    ($, e) => ({ text: 'Color Code could not do that; set COLOR_CODE_DEBUG=1 for a log.' }),
  )

  // Our theme for this process only; the person's own is noted for auto.
  on('settings.read', async ($, e, next) => {
    const read = await next(e)
    if (e.source !== undefined || !('value' in read)) return read
    const own = (read.value as { theme?: unknown }).theme
    if (typeof own === 'string' && !own.startsWith('custom:color-code:')) ownTheme = own
    const file = themeFile(color)
    if (file === undefined) return read
    return { value: { ...read.value, theme: themeRef(file) } }
  }).catch(($, e, next) => next(e))

  // A theme picked in /config while colored: follow it in auto mode.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    if (typeof e.value === 'string' && !e.value.startsWith('custom:color-code:')) {
      const before = variant()
      ownTheme = e.value
      if (color !== undefined && variant() !== before) later($, async () => (await paint($), await refreshSettings($)))
    }
    return set
  }).catch(($, e, next) => next(e))

  // ---- the tab's activity ring, and healing on every turn ----

  on('prompt.submit', async ($, e, next) => {
    later($, () => paint($, { heal: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turning = true
      waiting.length = 0
      later($, () => paint($, { heal: true }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turning = false
      waiting.length = 0
      later($, () => paint($, { heal: true }))
    }
    return next(e)
  })

  // A permission prompt is up: the ring turns to "waiting on you".
  on('classic.PermissionRequest', async ($, e, next) => {
    const decided = await next(e)
    if (!('decision' in decided) || decided.decision === undefined) {
      waiting.push(String(e.tool_name))
      setActivity($)
    }
    return decided
  }).catch(($, e, next) => next(e))

  on('classic.Elicitation', async ($, e, next) => {
    waiting.push('elicitation')
    setActivity($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.ElicitationResult', async ($, e, next) => {
    const at = waiting.indexOf('elicitation')
    if (at >= 0) waiting.splice(at, 1)
    setActivity($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A question for you, and the end of any call that waited on you.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === 'AskUserQuestion') {
      waiting.push(tool)
      setActivity($)
    }
    try {
      return await next(e)
    } finally {
      const at = waiting.indexOf(tool)
      if (at >= 0) {
        waiting.splice(at, 1)
        setActivity($)
      }
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      heal?.cancel()
      heal = undefined
      turning = false
      waiting.length = 0
      if (e.reason !== 'clear' && e.reason !== 'resume') {
        color = undefined
        await paint($, { reset: true })
      }
    } catch {
      // exit stays fast whatever happened
    }
    return next(e)
  })
}
