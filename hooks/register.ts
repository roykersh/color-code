import type { EngineInterface, Register } from 'claude-code'

// /color <name> themes the whole session: Claude Code switches to the matching
// theme in themes/ (this process only, through the settings it reads), and the
// Windows Terminal tab gets that theme's background, text, cursor and palette
// over OSC, which follows the tab alone, so every tab keeps its own color.

const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']

type TerminalPalette = { background: string; foreground: string; cursor: string; ansi: string[] }

let color: string | undefined

const themeRef = (name: string) => `custom:color-code:${name}`

let logged = ''

// Set COLOR_CODE_DEBUG=1 to write what each step did to debug.log.
async function log($: EngineInterface, line: string) {
  if (!(await $.env.get('COLOR_CODE_DEBUG'))) return
  logged += `${new Date().toISOString()} ${line}\n`
  await $.fs.write(`${$.plugin.root}/debug.log`, logged).catch(() => undefined)
}

async function sendOsc($: EngineInterface, bodies: string[]) {
  const ran = await $.process
    .run([`${$.plugin.root}/bin/osc.exe`, ...bodies])
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  await log($, `osc ${bodies[0]} -> ${ran.exitCode} ${ran.stdout.trim()} ${ran.stderr.trim()}`)
}

async function paintTerminal($: EngineInterface, name: string | undefined) {
  if (name === undefined) return sendOsc($, ['104', '110', '111', '112'])
  const theme = JSON.parse(await $.fs.read(`${$.plugin.root}/themes/${name}.json`))
  const t: TerminalPalette = theme.terminal
  await sendOsc($, [
    `11;${t.background}`,
    `10;${t.foreground}`,
    `12;${t.cursor}`,
    ...t.ansi.map((c, i) => `4;${i};${c}`),
  ])
}

async function claudeHome($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))}/.claude`
}

// The engine merges settings again when a settings file changes; rewriting the
// user file as it stands makes it ask the settings.read hook below again.
async function refreshSettings($: EngineInterface) {
  const home = await claudeHome($)
  const path = `${home}/settings.json`
  const text = await $.fs.read(path).catch(() => undefined)
  if (text !== undefined) await $.fs.write(path, text)
  await log($, `refreshed ${path}: ${text !== undefined}`)
}

async function apply($: EngineInterface, name: string | undefined) {
  color = name !== undefined && COLORS.includes(name) ? name : undefined
  await paintTerminal($, color)
  await refreshSettings($)
}

// The color the transcript last recorded for this session (resume, reload).
async function savedColor($: EngineInterface, cwd: string): Promise<string | undefined> {
  const home = await claudeHome($)
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const transcript = `${home}/projects/${project}/${await $.session.id()}.jsonl`
  if (!(await $.fs.exists(transcript))) {
    await log($, `no transcript at ${transcript}`)
    return undefined
  }
  const found = await $.process
    .run(['findstr', '/R', '/B', '/C:{.type.:.agent-color.', transcript])
    .catch(() => undefined)
  const last = found?.stdout.trim().split(/\r?\n/).at(-1)
  if (!last) return undefined
  try {
    return JSON.parse(last).agentColor
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await log($, `session.start interactive=${e.isInteractive}`)
    if (e.isInteractive) {
      const saved = await savedColor($, e.cwd)
      if (saved !== undefined && COLORS.includes(saved)) await apply($, saved)
    }
    return started
  })

  on('command.run', { command: 'color' }, async ($, e, next) => {
    const ran = await next(e)
    const said = ran.text ?? ''
    await log($, `command.run color args=${JSON.stringify(e.args)} text=${JSON.stringify(said)}`)
    // The picker form prints nothing back, so the argument decides; a bare
    // /color picks at random and only the transcript knows which.
    const arg = e.args.trim().toLowerCase()
    const set = /Session color set to: (\w+)/.exec(said)?.[1] ?? (COLORS.includes(arg) ? arg : undefined)
    if (set !== undefined) await apply($, set)
    else if (/reset to default/.test(said) || ['default', 'reset', 'none', 'gray', 'grey'].includes(arg)) await apply($, undefined)
    else if (arg === '') {
      const saved = await savedColor($, await $.session.cwd())
      await log($, `bare /color, transcript says ${saved}`)
      if (saved !== undefined) await apply($, saved)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('settings.read', async ($, e, next) => {
    const read = await next(e)
    if (color === undefined || e.source !== undefined || !('value' in read)) return read
    return { value: { ...read.value, theme: themeRef(color) } }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') await paintTerminal($, undefined)
    return next(e)
  })
}
