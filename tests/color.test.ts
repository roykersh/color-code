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
  expect(osc).toContain('9;4;0')
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
