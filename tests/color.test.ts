import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { follows, parseJsonc, withoutTheme, withTheme } from '../hooks/wt.ts'

const THEME = {
  terminal: { background: '#340c0c', foreground: '#f8f7f1', cursor: '#e55f5f', tab: '#e55f5f', ansi: ['#000000', '#ff0000'] },
}

// /color as the person types it.
const color = (args: string) => ({
  command: 'color',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

// Stands in for the engine beneath the plugin: files, processes, the command.
function engine(on: On, runs: string[][]) {
  mock.clock(on)
  mock.store(on)
  on('fs.read', () => ({ value: JSON.stringify(THEME) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))
}

test('/color red paints the tab through osc.exe on Windows', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  mock.env(on, { OS: 'Windows_NT', WT_SESSION: 'x', USERPROFILE: 'C:/Users/me' })
  await $.command.run(color('red'))
  const osc = runs.find(argv => argv[0]?.endsWith('/bin/osc.exe'))
  expect(osc).toBeDefined()
  expect(osc).toContain('11;#340c0c')
  expect(osc).toContain('4;1;#ff0000')
  // Claude Code's own progress ring is left alone by default.
  expect(osc?.some(b => b.startsWith('9;4'))).toBe(false)
})

test('the ring is drawn only when the activity option is on', { options: { activity: true } }, async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  mock.env(on, { OS: 'Windows_NT', WT_SESSION: 'x', USERPROFILE: 'C:/Users/me' })
  await $.command.run(color('red'))
  expect(runs.at(-1)).toContain('9;4;0')
})

test('/color dynamic, light and unknown words are answered without the built-in', async ($, on) => {
  const runs: string[][] = []
  const builtin: string[] = []
  mock.clock(on)
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me' })
  on('fs.read', () => ({ value: JSON.stringify(THEME) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', ($, e) => {
    builtin.push(e.args)
    return { text: '' }
  })
  const dyn = await $.command.run(color('dynamic'))
  expect(dyn.text).toContain('- **yellow**: working')
  expect(runs.at(-1)?.[0]).toContain('osc.exe')
  const light = await $.command.run(color('light'))
  expect(light.text).toContain('light')
  const odd = await $.command.run(color('mauve'))
  expect(odd.text).toContain('dynamic')
  expect(builtin).toEqual([])
})

test("/color's hint lists Color Code's words", async ($, on) => {
  on('command.describe', ($, e) => ({ description: e.description, argumentHint: e.argumentHint, isHidden: false }))
  const described = await $.command.describe({
    command: 'color',
    description: 'Set the prompt bar color',
    argumentHint: '[name]',
    isHidden: false,
    immediate: false,
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(described.argumentHint).toContain('dynamic')
  expect(described.argumentHint).toContain('purple')
})

test('on iTerm2 the batch goes to the tty, with the tab color', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  mock.env(on, { TERM_PROGRAM: 'iTerm.app', HOME: '/Users/me' })
  await $.command.run(color('red'))
  const sh = runs.find(argv => argv[0] === '/bin/sh')
  expect(sh).toBeDefined()
  const text = sh?.at(-1) ?? ''
  expect(text).toContain('\x1b]11;#340c0c\x07')
  expect(text).toContain('\x1b]6;1;bg;red;brightness;229\x07')
  expect(text).not.toContain('9;4')
})

test('/color default resets the tab', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me' })
  await $.command.run(color('red'))
  await $.command.run(color('default'))
  expect(runs.at(-1)).toContain('104')
})

test('Windows Terminal setup adds the theme, keeps the rest, and undoes', () => {
  const before = parseJsonc('{\n // mine\n "theme": "dark", "profiles": {"list": [1,]},\n "themes": []\n}')
  expect(follows(before)).toBe(false)
  const after = withTheme(before)
  expect(follows(after)).toBe(true)
  expect(after.profiles).toEqual({ list: [1] })
  const undone = withoutTheme(after, 'dark')
  expect(undone.theme).toBe('dark')
  expect(follows(undone)).toBe(false)
})

test('the active tab stands out: the tab row is a neutral, not the pane color', () => {
  const dark = withTheme(parseJsonc('{"theme": "dark"}')) as { themes: { name: string; tabRow: { background: string } }[] }
  const light = withTheme(parseJsonc('{"theme": "light"}')) as typeof dark
  expect(dark.themes.find(t => t.name === 'Color Code')?.tabRow.background).toBe('#0a0a0a')
  expect(light.themes.find(t => t.name === 'Color Code')?.tabRow.background).toBe('#e6e6e6')
})

const ended = (reason: 'clear' | 'prompt_input_exit' | 'other') => ({ reason, sessionId: 's1', resume: { id: 's1' } })

test('an exit resets only a tab this session painted', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me' })
  // A headless run (claude -p, an SDK session) never painted: its end sends nothing.
  await $.session.end(ended('other'))
  expect(runs.some(argv => argv[0]?.endsWith('/bin/osc.exe'))).toBe(false)
  await $.command.run(color('red'))
  // A /clear goes on in the same tab: the color stays.
  await $.session.end(ended('clear'))
  expect(runs.at(-1)).toContain('11;#340c0c')
  await $.session.end(ended('prompt_input_exit'))
  expect(runs.at(-1)).toContain('111')
})

test('/color dynamic turns purple while a subagent outlives the turn, green once it ends', async ($, on) => {
  const runs: string[][] = []
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me' })
  // Each theme's background names it, so the batch shows which color went out.
  on('fs.read', ($, e) => ({ value: JSON.stringify({ terminal: { ...THEME.terminal, background: /themes.(\w+)\.json/.exec(e.path)?.[1] } }) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  let status: 'running' | 'completed' = 'running'
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'research', type: 'general-purpose', status }] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'Started a subagent.' }))
  await $.command.run(color('dynamic'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'Started a subagent.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(runs.at(-1)).toContain('11;purple')
  status = 'completed'
  await clock.advance(3000)
  expect(runs.at(-1)).toContain('11;green')
})

test('COLOR_CODE_START=dynamic starts a new session in /color dynamic', async ($, on) => {
  const runs: string[][] = []
  const logged: string[] = []
  engine(on, runs)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', COLOR_CODE_START: 'dynamic' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/proj' }))
  on('settings.read', () => ({ value: {} }))
  on('ui.log', ($, e) => {
    logged.push(String(e.text ?? e))
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: true })
  expect(runs.some(argv => argv[0]?.endsWith('/bin/osc.exe'))).toBe(true)
  // $.ui.log draws one line: the legend goes in one, every state named.
  expect(logged).toHaveLength(1)
  expect(logged[0]).not.toContain('\n')
  expect(logged[0]).toContain('purple background')
})

// Each theme's background names it, so the batch shows which color went out.
function named(on: On, runs: string[][], env: Record<string, string>) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', ...env })
  on('fs.read', ($, e) => ({ value: JSON.stringify({ terminal: { ...THEME.terminal, background: /themes.(\w+)\.json/.exec(e.path)?.[1] } }) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'Started it.' }))
  on('classic.Stop', () => ({}))
  on('command.run', () => ({ text: '' }))
  return clock
}

const shell = { id: 'b1', type: 'shell', status: 'running', description: 'Run the routine', command: 'python daily_lectures.py' }

test('/color dynamic turns purple while a background shell outlives the turn, green once its notification turn ends', async ($, on) => {
  const runs: string[][] = []
  const clock = named(on, runs, {})
  await $.command.run(color('dynamic'))
  await $.turn.start({ text: 'run the routine', turnId: 't1' })
  // No agent: only the Stop at the turn's end knows the shell still runs.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.turn.complete({ answer: 'Started it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3000)
  expect(runs.at(-1)).toContain('11;purple')
  // The shell ends: its notification is a turn of its own. A finished subagent stays
  // listed (it can be resumed) under Claude Code's own type name; neither counts.
  await $.turn.start({ text: '', turnId: 't2' })
  const doneAgent = { id: 'a1', type: 'local_agent', status: 'completed', description: 'Fix the colors' }
  const remote = { id: 'r1', type: 'remote_control', status: 'running', description: 'Remote Control' }
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ ...shell, status: 'completed' }, doneAgent, remote] })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)
  expect(runs.at(-1)).toContain('11;green')
})

test("a background session (/bg) paints nothing: the attached tab is its client's to color", async ($, on) => {
  const runs: string[][] = []
  const clock = named(on, runs, { CLAUDE_CODE_SESSION_KIND: 'bg' })
  await $.command.run(color('dynamic'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10)
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10_000)
  await $.command.run(color('red'))
  expect(runs.some(argv => argv[0]?.endsWith('/bin/osc.exe'))).toBe(false)
})

test('an artifact comment watch or an MCP monitor (Stop calls both "monitor") never keeps the tab purple', async ($, on) => {
  const runs: string[][] = []
  const clock = named(on, runs, {})
  await $.command.run(color('dynamic'))
  await $.turn.start({ text: 'watch the artifact', turnId: 't1' })
  const watch = { id: 'w1', type: 'monitor', status: 'running', description: 'Comments on Claude Bar Redesign' }
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [watch] })
  await $.turn.complete({ answer: 'Watching it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3000)
  expect(runs.at(-1)).toContain('11;green')
})

// ---- the tab's title, when Claude Code leaves it to Color Code ----

const MARK = '\u2733'
const titles = (runs: string[][]) => runs.filter(argv => argv[0]?.endsWith('/bin/osc.exe') && argv[1]?.startsWith('0;')).map(argv => argv[1])

function titleEngine(on: On, runs: string[][], env: Record<string, string>, rows: { value: string }, answer: { text: string }) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', WT_SESSION: 'x', ...env })
  on('fs.read', () => ({ value: JSON.stringify(THEME) }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/proj' }))
  on('settings.read', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: answer.text }))
  on('classic.Stop', () => ({}))
  on('command.run', () => ({ text: '' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'findstr' ? rows.value : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

test('with Claude Code\'s title off, the tab reads "✳ name" once a turn is done and the bare name while it works or waits on you', async ($, on) => {
  const runs: string[][] = []
  const rows = { value: '{"type":"ai-title","aiTitle":"Fix the bar","sessionId":"s1"}' }
  const answer = { text: 'Done.' }
  const clock = titleEngine(on, runs, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, rows, answer)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: true })
  expect(titles(runs).at(-1)).toBe(`0;${MARK} Fix the bar`)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10)
  expect(titles(runs).at(-1)).toBe('0;Fix the bar')
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(titles(runs).at(-1)).toBe(`0;${MARK} Fix the bar`)
  // A turn that ends on a question waits on you: no mark.
  answer.text = 'Should I push it?'
  await $.turn.start({ text: 'and now', turnId: 't2' })
  await $.turn.complete({ answer: answer.text, durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)
  expect(titles(runs).at(-1)).toBe('0;Fix the bar')
  // An interrupted turn is over too.
  await $.turn.start({ text: 'go on', turnId: 't3' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't3', reason: 'aborted' })
  await clock.advance(10)
  expect(titles(runs).at(-1)).toBe(`0;${MARK} Fix the bar`)
  // A /rename shows within the name check, and wins over Claude Code's own title.
  rows.value += '\n{"type":"custom-title","customTitle":"color code","sessionId":"s1"}'
  await clock.advance(10_000)
  expect(titles(runs).at(-1)).toBe(`0;${MARK} color code`)
  // The same title is never sent twice in a row.
  const sent = titles(runs).length
  await clock.advance(10_000)
  expect(titles(runs)).toHaveLength(sent)
})

test("without CLAUDE_CODE_DISABLE_TERMINAL_TITLE the title stays Claude Code's", async ($, on) => {
  const runs: string[][] = []
  const clock = titleEngine(on, runs, {}, { value: '{"type":"ai-title","aiTitle":"Fix the bar"}' }, { text: 'Done.' })
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10_000)
  expect(titles(runs)).toHaveLength(0)
})

test('a background session (/bg) never writes the title', async ($, on) => {
  const runs: string[][] = []
  const clock = titleEngine(on, runs, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_CODE_SESSION_KIND: 'bg' }, { value: '{"type":"ai-title","aiTitle":"Fix the bar"}' }, { text: 'Done.' })
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10_000)
  expect(titles(runs)).toHaveLength(0)
})
