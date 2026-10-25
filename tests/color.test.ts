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
  expect(dyn.text).toContain('yellow = working')
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
