import type { EngineInterface, Register } from 'claude-code'
import { platform, send } from './term.ts'
import { type WtMemory, wtFiles, wtMissing, wtSetup, wtStamp, wtUndo } from './wt.ts'

// /color <name> colors the session's terminal tab: background, text, cursor
// and palette over OSC, which follows the tab alone, so every tab keeps its
// own color (and in Windows Terminal the tab and title bar follow). /color
// dynamic makes the color follow Claude's state instead.
//
// Claude Code 2.1.x reads its own UI theme once, when the session starts, and
// gives plugins no way to change it live, so Color Code leaves that theme
// alone; the themes in themes/ can still be picked by hand with /theme.
//
// Everything that leans on Claude Code's internals (how /color reports, the
// transcript) fails soft: the terminal part goes on.

const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
const RESETS = ['default', 'reset', 'none', 'gray', 'grey']
const WORDS = ['dynamic', 'static', 'light', 'dark', 'auto']
const HINT = `[${[...COLORS, 'dynamic', 'static', 'light', 'dark', 'auto', 'default'].join('|')}]`
const DESCRIPTION = "Color this session: a color, dynamic (the color follows Claude's state), or light/dark/auto"
// A tab moved to another window, or a Windows Terminal settings reload, loses
// its colors; this is how soon they come back at the latest.
const HEAL_MS = 3000
// Windows Terminal drops every tab's OSC colors whenever its settings.json is
// written (by anyone): it is watched this often, so the repaint follows at once.
const WATCH_MS = 500

// /color dynamic: the color says what Claude is doing.
const STATES = { working: 'yellow', background: 'purple', needsYou: 'blue', done: 'green', failed: 'red' } as const
type State = keyof typeof STATES
// The legend /color dynamic prints: a line per color. A terminal draws it in
// the colors themselves (the CommandOutput hook below); LEGEND is the text the
// transcript keeps and any other surface shows, LEGEND_LINES the resume notice.
const LEGEND_ROWS: { state: State; means: string; when: string }[] = [
  { state: 'working', means: 'working', when: 'Claude is on your prompt' },
  { state: 'background', means: 'subagent', when: 'the turn is over but a subagent still runs: you can type' },
  { state: 'needsYou', means: 'needs you', when: 'a permission prompt or a question is waiting on you' },
  { state: 'done', means: 'done', when: 'the turn finished: your move' },
  { state: 'failed', means: 'failed', when: 'an error, or you interrupted it' },
]
const LEGEND_TITLE = "Color Code dynamic is on: the tab's color now says what Claude is doing."
const LEGEND_END = '/color <name> or /color static ends it.'
const LEGEND = [LEGEND_TITLE, '', ...LEGEND_ROWS.map(r => `- **${STATES[r.state]}**: ${r.means}, ${r.when}`), '', LEGEND_END].join('\n')
const LEGEND_LINES = [LEGEND_TITLE, ...LEGEND_ROWS.map(r => `  ${STATES[r.state].padEnd(7)} ${r.means.padEnd(10)} ${r.when}`), LEGEND_END].join('\n')

type Variant = 'dark' | 'light'
type Mode = Variant | 'auto'
type TerminalPalette = { background: string; foreground: string; cursor: string; tab?: string; ansi: string[] }
type Remembered = { dynamic?: boolean; at?: number }

// Module state; a reload starts it over and session.start finds it again.
let color: string | undefined // the session's own /color
let dynamic = false
let ended: State = 'done' // how the last turn ended
let mode: Mode = 'auto'
let ownTheme: string | undefined // the person's Claude theme
let showActivity = false
let turning = false
const waiting: string[] = [] // what is waiting on the person
let background = 0 // subagents still running
let lastBatch = ''
let lastSentAt = 0
let lastWidth = 0
// The tab holds this module's colors: only then does an exit reset it. A
// headless run (claude -p, an SDK session) never painted, and must not reset
// the tab of the session that started it.
let painted = false
let heal: { cancel: () => void } | undefined
let watch: { cancel: () => void } | undefined
let seenStamp: string | undefined
let transcriptPath: string | undefined
const palettes = new Map<string, TerminalPalette>()

const variant = (): Variant => (mode !== 'auto' ? mode : /light/i.test(ownTheme ?? '') ? 'light' : 'dark')
// A turn that ended on a question to you stays blue while subagents run.
const state = (): State =>
  waiting.length > 0 ? 'needsYou' : turning ? 'working' : background > 0 && ended !== 'needsYou' ? 'background' : ended
// The color on the tab now.
const shown = (): string | undefined => (dynamic ? STATES[state()] : color)
const themeFile = (name: string | undefined) => (name === undefined ? undefined : variant() === 'light' ? `${name}-light` : name)

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
  const file = themeFile(shown())
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
  // Off by default: Claude Code draws its own progress ring (OSC 9;4) and two
  // writers of one ring only flicker. 3: spinning; 4 at 100: a full yellow ring.
  if (p.progress && showActivity) {
    const s = state()
    bodies.push(s === 'working' ? '9;4;3' : s === 'needsYou' ? '9;4;4;100' : '9;4;0')
  }
  return bodies
}

// Sends the batch when it changed, or when healing (a moved tab or a settings
// reload drops OSC colors; the same colors again repaint nothing visible).
// Sends never overlap; requests made meanwhile fold into one more.
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
  // tab, and not twice within a second.
  if (key === lastBatch && !(opts.heal && shown() !== undefined && now - lastSentAt >= 1000)) return
  lastBatch = key
  lastSentAt = now
  painted = bodies.some(b => b.startsWith('11;'))
  await log($, `send ${bodies.length} (${bodies[0] ?? ''}) -> ${await send($, $.plugin.root, bodies)}`)
}

async function claudeHome($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))}/.claude`
}

function keepHealing($: EngineInterface) {
  if (shown() !== undefined && heal === undefined) {
    try {
      heal = $.clock.every(HEAL_MS, async () => {
        if (dynamic) await countAgents($)
        await paint($, { heal: true })
      })
    } catch {
      heal = undefined
    }
    void watchSettings($)
  } else if (shown() === undefined && heal !== undefined) {
    stopHealing()
  }
}

function stopHealing() {
  heal?.cancel()
  heal = undefined
  watch?.cancel()
  watch = undefined
}

// A write to Windows Terminal's settings.json reloads them and clears this
// tab: repaint right after the reload instead of up to HEAL_MS later.
async function watchSettings($: EngineInterface) {
  if (watch !== undefined || !(await $.env.get('WT_SESSION'))) return
  const files = await wtFiles($).catch(() => [])
  if (files.length === 0 || watch !== undefined) return
  seenStamp = await wtStamp($, files)
  if (shown() === undefined) return // stopped meanwhile
  try {
    watch = $.clock.every(WATCH_MS, async () => {
      const stamp = await wtStamp($, files)
      if (stamp === seenStamp) return
      seenStamp = stamp
      await log($, 'Windows Terminal settings changed: repainting')
      for (const ms of [250, 1000]) later($, () => paint($, { heal: true }), ms)
    })
  } catch {
    watch = undefined
  }
}

// Kept for this session: a module reload reads the env, a resume the store.
async function remember($: EngineInterface) {
  const id = await $.session.id()
  await $.env.set('COLOR_CODE_STATE', `${id} ${color ?? '-'} ${dynamic ? 'dynamic' : 'static'}`).catch(() => undefined)
  try {
    const all = ((await $.store.get('sessions')) ?? {}) as Record<string, Remembered>
    const now = await $.clock.now()
    if (dynamic) all[id] = { dynamic: true, at: now }
    else delete all[id]
    // Keep the newest 200.
    const kept = Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, 200)
    await $.store.set('sessions', Object.fromEntries(kept))
  } catch {
    // remembering is a nicety
  }
}

async function apply($: EngineInterface, name: string | undefined, why: string, opts: { dynamic?: boolean } = {}) {
  color = name !== undefined && COLORS.includes(name) ? name : undefined
  if (opts.dynamic !== undefined) dynamic = opts.dynamic
  await log($, `apply ${dynamic ? `dynamic (${state()})` : (color ?? 'reset')} (${variant()}) from ${why}`)
  await remember($)
  keepHealing($)
  await paint($, { reset: shown() === undefined })
}

// After a Windows Terminal settings reload clears every tab, paint this one.
function repaintSoon($: EngineInterface) {
  for (const ms of [1000, 3000]) later($, () => paint($, { heal: true }), ms)
}

// Claude's state moved: repaint when it shows (dynamic color or the ring).
function stateChanged($: EngineInterface) {
  if (dynamic || showActivity) later($, () => paint($))
}

// Subagents (not teammates) still running. An agent's status flips a moment
// after its last turn ends, so callers look again a little later too.
async function countAgents($: EngineInterface) {
  const agents = await $.agent.list().catch(() => [])
  const n = agents.filter(a => (a.status === 'running' || a.status === 'pending') && !a.teammateId).length
  if (n === background) return
  background = n
  await log($, `subagents running: ${n}`)
  stateChanged($)
}

function agentsSoon($: EngineInterface) {
  for (const ms of [1, 1500]) later($, () => countAgents($), ms)
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

// ---- the words /color and /color-code share ---------------------------------

async function setMode($: EngineInterface, word: Mode): Promise<string> {
  mode = word
  await $.store.set('mode', word).catch(() => undefined)
  await paint($)
  const warn =
    variant() === 'light' && !/light/i.test(ownTheme ?? '')
      ? ' Your Claude theme is dark, so its text will be light on a pale tab: pick a light theme with /theme to match.'
      : ''
  return `Color Code: ${word === 'auto' ? `following your Claude theme (${variant()} now)` : `${word} variants`}, here and in new sessions.${warn}`
}

async function setDynamic($: EngineInterface, on: boolean): Promise<string> {
  await apply($, color, on ? '/color dynamic' : '/color static', { dynamic: on })
  if (on) return LEGEND
  return color ? `Color Code: back to ${color}.` : 'Color Code: dynamic colors off.'
}

function usage(): string {
  return [
    `/color ${HINT}`,
    `  ${COLORS.join(', ')}: color this session's tab.`,
    "  dynamic: the color follows Claude's state (yellow working, purple a subagent still runs, blue needs you, green done, red failed); static ends it.",
    '  light, dark, auto: the pale or the dark variant of each color, or follow your Claude theme.',
    '  default: back to the terminal\'s own colors.',
  ].join('\n')
}

async function colorCode($: EngineInterface, args: string): Promise<string> {
  const [word = ''] = args.trim().toLowerCase().split(/\s+/)
  if (word === 'light' || word === 'dark' || word === 'auto') return setMode($, word)
  if (word === 'dynamic' || word === 'static') return setDynamic($, word === 'dynamic')
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
    tabs = files.length === 0 ? 'Windows Terminal: not found.' : missing.length ? 'Windows Terminal: tabs keep their own color (run /color-code setup).' : 'Windows Terminal: tabs and title bar follow the session color.'
  }
  const now = dynamic ? `dynamic, ${STATES[state()]} now (${state()})` : (color ?? 'no color')
  return [
    `Color Code: ${now}, ${variant()} variant (mode ${mode}), on ${where}.`,
    tabs,
    `Tab progress ring: ${showActivity ? (p.progress ? "Color Code's (option activity on)" : 'on, but this terminal has none') : "Claude Code's own (Color Code's is off)"}.`,
    "Claude Code's own UI theme: chosen with /theme (the Session themes are there); Claude Code reads it only at start.",
    usage(),
    '/color-code setup | undo-setup: Windows Terminal tab theme.',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---- hooks ------------------------------------------------------------------

export const register: Register = (on, options) => {
  showActivity = options.activity === true
  const autoColor = options.autoColor === true

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'color-code', description: 'Color Code: status, light/dark/auto, dynamic, Windows Terminal setup', argumentHint: '[light|dark|auto|dynamic|static|setup|undo-setup]' })
      .catch(() => undefined)
    const started = await next(e)
    try {
      await log($, `session.start interactive=${e.isInteractive}`)
      if (!e.isInteractive) return started
      const stored = await $.store.get('mode').catch(() => undefined)
      if (stored === 'light' || stored === 'dark' || stored === 'auto') mode = stored
      const theme = await $.settings.read({ key: 'theme' }).catch(() => undefined)
      if (typeof theme === 'string') ownTheme = theme
      const id = await $.session.id()
      // A reload of this module (same session), then the store and the
      // transcript (a resume), then auto.
      const [keptId, kept = '-', how = ''] = ((await $.env.get('COLOR_CODE_STATE')) ?? '').split(' ')
      const reloaded = keptId === id
      const sessions = ((await $.store.get('sessions').catch(() => undefined)) ?? {}) as Record<string, Remembered>
      // COLOR_CODE_START=dynamic: a launcher asks for a session that starts dynamic.
      const startDynamic = (await $.env.get('COLOR_CODE_START'))?.toLowerCase() === 'dynamic'
      const wasDynamic = reloaded ? how === 'dynamic' : startDynamic || sessions[id]?.dynamic === true
      const pick =
        (reloaded && COLORS.includes(kept) ? kept : undefined) ??
        (await savedColor($, e.cwd)) ??
        (autoColor && !wasDynamic ? projectColor(await $.session.root().catch(() => e.cwd)) : undefined)
      if (pick !== undefined || wasDynamic) await apply($, pick, 'session start', { dynamic: wasDynamic })
      if (wasDynamic && !reloaded) $.ui.log(LEGEND_LINES)
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

  // /color's typeahead line and hint list what Color Code adds.
  on('command.describe', { command: 'color' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: DESCRIPTION, argumentHint: HINT }
  }).catch(($, e, next) => next(e))

  // And the words themselves, once a letter is typed after /color.
  on('prompt.autocomplete', async ($, e, next) => {
    const offered = await next(e)
    if (!/^\/color\s+\S*$/i.test(e.text.slice(0, e.cursor)) || e.token.startsWith('/')) return offered
    const typed = e.token.toLowerCase()
    const words = [...COLORS, 'dynamic', 'static', 'light', 'dark', 'auto', 'default'].filter(w => w.startsWith(typed) && w !== typed)
    const about: Record<string, string> = {
      dynamic: "color follows Claude's state",
      static: 'end dynamic colors',
      light: 'pale variants',
      dark: 'dark variants',
      auto: 'follow your Claude theme',
      default: "the terminal's own colors",
    }
    return { suggestions: [...offered.suggestions, ...words.map(w => ({ text: w, description: about[w] ?? 'Color Code' }))] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'color' }, async ($, e, next) => {
    const arg = e.args.trim().toLowerCase()
    // Color Code's own words, and anything /color would refuse, are answered
    // here without the built-in, which knows none of them.
    if (arg === 'light' || arg === 'dark' || arg === 'auto') return { text: await setMode($, arg) }
    if (arg === 'dynamic' || arg === 'static') return { text: await setDynamic($, arg === 'dynamic') }
    if (arg !== '' && !COLORS.includes(arg) && !RESETS.includes(arg) && !WORDS.includes(arg)) {
      return { text: `Color Code doesn't know "${arg}".\n${usage()}` }
    }
    const ran = await next(e)
    try {
      const said = ran.text ?? ''
      await log($, `command.run color args=${JSON.stringify(e.args)} text=${JSON.stringify(said)}`)
      // The argument first; the printed line second (the picker form prints
      // nothing); a bare /color picks at random and only the transcript knows.
      // Any of these ends dynamic colors.
      const told = /color set to:?\s*(\w+)/i.exec(said)?.[1]?.toLowerCase()
      if (COLORS.includes(arg)) await apply($, arg, '/color', { dynamic: false })
      else if (RESETS.includes(arg) || /reset to default/i.test(said)) await apply($, undefined, '/color', { dynamic: false })
      else if (told !== undefined && COLORS.includes(told)) await apply($, told, '/color text', { dynamic: false })
      else {
        const saved = await savedColor($, await $.session.cwd())
        await log($, `/color ${arg}: transcript says ${saved}`)
        if (saved !== undefined) await apply($, saved, '/color transcript', { dynamic: false })
      }
    } catch (err) {
      await log($, `/color: ${String(err)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The legend in color: a swatch of each state's own tab color, a line each.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    // Core shows a plugin's answer under its name ("color-code: ..."), so match the end.
    if (typeof e.props.text !== 'string' || !e.props.text.endsWith(LEGEND)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = await Promise.all(
      LEGEND_ROWS.map(async r => ({ ...r, color: STATES[r.state], tab: (await palette($, STATES[r.state]))?.tab ?? STATES[r.state] })),
    )
    return (
      <Box flexDirection="column">
        <Text bold>{LEGEND_TITLE}</Text>
        <Box flexDirection="column" paddingY={1}>
          {rows.map(r => (
            <Box key={r.state} flexDirection="row">
              <Text color={r.tab}>{'  ██ '}</Text>
              <Text color={r.tab} bold>{r.color.padEnd(8)}</Text>
              <Text bold>{r.means.padEnd(11)}</Text>
              <Text dimColor>{r.when}</Text>
            </Box>
          ))}
        </Box>
        <Text dimColor>{LEGEND_END}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'color-code' }, async ($, e) => ({ text: await colorCode($, e.args) })).catch(
    ($, e) => ({ text: 'Color Code could not do that; set COLOR_CODE_DEBUG=1 for a log.' }),
  )

  // A theme picked in /config or /theme: the variant follows it in auto mode.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    if ('value' in set && typeof set.value === 'string') {
      const before = variant()
      ownTheme = set.value
      if (variant() !== before) later($, () => paint($))
    }
    return set
  }).catch(($, e, next) => next(e))

  // A tab dragged to another window usually changes its width: repaint at once.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const width = e.viewport?.columns ?? 0
    if (width !== lastWidth) {
      if (lastWidth !== 0) later($, () => paint($, { heal: true }))
      lastWidth = width
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- Claude's state: dynamic colors, the optional ring, healing ----

  on('prompt.submit', async ($, e, next) => {
    later($, () => paint($, { heal: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turning = true
      waiting.length = 0
      later($, () => paint($, { heal: true }))
    } else agentsSoon($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      turning = false
      waiting.length = 0
      // Ended on a question to you: that is waiting on you too.
      const asked = /\?\s*$/.test((done.text ?? '').replace(/[*_`)\]]+\s*$/, ''))
      ended = e.reason === 'answer' ? (asked ? 'needsYou' : 'done') : 'failed'
      later($, () => paint($, { heal: true }))
    }
    agentsSoon($)
    return done
  })

  // A permission prompt is up.
  on('classic.PermissionRequest', async ($, e, next) => {
    const decided = await next(e)
    if (!('decision' in decided) || decided.decision === undefined) {
      waiting.push(String(e.tool_name))
      stateChanged($)
    }
    return decided
  }).catch(($, e, next) => next(e))

  on('classic.Elicitation', async ($, e, next) => {
    waiting.push('elicitation')
    stateChanged($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.ElicitationResult', async ($, e, next) => {
    const at = waiting.indexOf('elicitation')
    if (at >= 0) waiting.splice(at, 1)
    stateChanged($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A question for you, and the end of any call that waited on you.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === 'AskUserQuestion') {
      waiting.push(tool)
      stateChanged($)
    }
    try {
      return await next(e)
    } finally {
      const at = waiting.indexOf(tool)
      if (at >= 0) {
        waiting.splice(at, 1)
        stateChanged($)
      }
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      turning = false
      waiting.length = 0
      background = 0
      // A /clear or a resume goes on in this tab: the color and its healing stay.
      if (e.reason !== 'clear' && e.reason !== 'resume') {
        stopHealing()
        color = undefined
        dynamic = false
        if (painted) await paint($, { reset: true })
      }
    } catch {
      // exit stays fast whatever happened
    }
    return next(e)
  })
}
