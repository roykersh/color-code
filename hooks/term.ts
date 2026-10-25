import type { EngineInterface } from 'claude-code'

// Where the sequences go. Windows: bin/osc.exe, which climbs to Claude Code's
// own console (its output is piped, so a child can't just print). macOS and
// Linux: the session's tty, wrapped for tmux, with no extra binary at all.

export type Platform = {
  windows: boolean
  // tmux passes a sequence on to the outer terminal only when wrapped.
  tmux: boolean
  // iTerm2 also takes a real tab color (OSC 6).
  iterm: boolean
  // OSC 9;4 is a tab progress ring here; elsewhere OSC 9 is a notification.
  progress: boolean
}

let found: Platform | undefined

// Read off the environment, not Node: the module has none.
export async function platform($: EngineInterface): Promise<Platform> {
  if (found) return found
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const tmux = !windows && Boolean(await $.env.get('TMUX'))
  const wt = Boolean(await $.env.get('WT_SESSION'))
  const conemu = Boolean(await $.env.get('ConEmuPID'))
  const ghostty = program === 'ghostty' || Boolean(await $.env.get('GHOSTTY_RESOURCES_DIR'))
  found = {
    windows,
    tmux,
    iterm: !windows && (program === 'iTerm.app' || Boolean(await $.env.get('ITERM_SESSION_ID'))),
    progress: wt || conemu || ghostty,
  }
  // Lets this pane's wrapped sequences through (tmux 3.3+); a pane option, so
  // nothing in the person's tmux.conf changes.
  if (tmux) await $.process.run(['tmux', 'set', '-p', 'allow-passthrough', 'on'], { timeoutMs: 3000 }).catch(() => undefined)
  return found
}

// /dev/tty when the child still has the session's terminal, else the tty of
// the nearest ancestor that has one (a child started in a new session).
const TTY = `exec 2>/dev/null
printf '%s' "$1" >/dev/tty && exit 0
p=$PPID; n=0
while [ "$n" -lt 8 ] && [ -n "$p" ] && [ "$p" -gt 1 ]; do
  t=$(ps -o tty= -p "$p" | tr -d ' ')
  case "$t" in ''|'?'|'??') ;; *)
    case "$t" in /*) d=$t ;; *) d=/dev/$t ;; esac
    [ -w "$d" ] && printf '%s' "$1" >"$d" && exit 0 ;;
  esac
  p=$(ps -o ppid= -p "$p" | tr -d ' '); n=$((n+1))
done
exit 1`

// One process for the whole batch. Resolves to a line for the debug log.
export async function send($: EngineInterface, root: string, bodies: readonly string[]): Promise<string> {
  if (bodies.length === 0) return 'nothing to send'
  const p = await platform($)
  if (p.windows) {
    const ran = await $.process.run([`${root}/bin/osc.exe`, ...bodies], { timeoutMs: 5000 })
    return `osc.exe ${ran.exitCode} ${ran.stdout.trim()} ${ran.stderr.trim()}`
  }
  let text = bodies.map(b => `\x1b]${b}\x07`).join('')
  if (p.tmux) text = `\x1bPtmux;${text.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`
  const ran = await $.process.run(['/bin/sh', '-c', TTY, 'color-code', text], { timeoutMs: 5000 })
  return `tty ${ran.exitCode}`
}
