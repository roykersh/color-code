# Color Code

Make `/color` in Claude Code theme the **whole session**, not just the prompt bar.

Run `/color yellow` and the session turns yellow: a yellow-tinted background, a
matching Claude Code theme, a re-lit terminal palette, and (in Windows Terminal)
the tab and the title bar. Every tab keeps its own color, so with several
Claude sessions open as tabs you can tell them apart at a glance, and a ring
in each tab says which one is working and which one is waiting on you.

## Install

At the prompt of a terminal session:

```
/plugin install color-code --marketplace roykersh/color-code
```

Answer `y` to add the marketplace and pick the user scope. In Windows
Terminal, answer the one question Color Code asks to color your tabs too.
That's all: there is nothing to configure and nothing else to install.

From a shell instead: `claude plugin install color-code --marketplace roykersh/color-code`.
Sessions already open pick it up after a restart (`/exit`, then `claude -c`).

## What you get

- **8 colors**, one per `/color` choice: red, orange, yellow, green, cyan, blue,
  purple, pink. `/color default` puts everything back.
- **Dark and light.** Each color has a dark theme (tinted background, light
  text) and a light one (pale tint, near-black text). Color Code follows your
  own Claude Code theme: pick a light theme in `/config` and you get the light
  variants. `/color-code light`, `/color-code dark` or `/color-code auto`
  overrides that, for the session and as your default.
- **Readable on purpose.** Every theme is generated with contrast checks: text,
  the model name, plan / auto-accept modes, tokens, warnings, errors and diffs
  all stay at least 4.5:1 against their own background. A color that shares
  the theme's hue (warning yellow on the yellow theme) is pushed further so it
  never melts into the background or the prompt bar.
- **Matching subagent colors.** The eight colors Claude Code gives subagents
  and teammates are re-tuned per theme: each keeps its name's hue, reads at
  4.5:1 or better on that background, stays clearly apart from the other
  seven, and the one that shares the session's color is the session's accent.
- **A tab activity ring** (Windows Terminal, ConEmu, Ghostty): spinning while
  Claude works, a full yellow ring while it waits on a permission prompt or a
  question, gone when idle. Turn it off with the `activity` option in `/config`.
- **Auto color per project** (off by default): turn on `autoColor` in `/config`
  and a session nobody colored gets a stable color picked from its project
  folder, so the same repo always opens in the same color.
- **Per tab.** The Claude Code theme changes for that session only, and the
  terminal colors go to that tab only. Exit Claude and the tab resets.
- **Resume keeps it.** `claude --resume` / `claude -c` brings the session's
  color back.
- **Self-healing.** Drag a tab to another window or let Windows Terminal reload
  its settings and the tab's colors come back within seconds.

## Commands

| Command | What it does |
| --- | --- |
| `/color <name>` | Claude Code's own command: Color Code themes the session to match. |
| `/color-code` | Status: the color, the variant, the terminal, the tab setup. |
| `/color-code light` / `dark` / `auto` | Choose the light or dark variants, or follow your Claude theme. |
| `/color-code setup` | Make Windows Terminal tabs follow the session color (the same thing the first-run question does). |
| `/color-code undo-setup` | Put Windows Terminal's previous theme back. |

## Platforms

- **Windows Terminal**: everything, including the tab and title bar. The colors
  are sent by `bin/osc.exe`, a 6 KB helper built from `tools/osc.cs`, since a
  plugin's child process can't write to Claude Code's console directly.
- **macOS and Linux**: the colors go straight to the session's terminal
  (`/dev/tty`, or the tty of Claude Code itself) with no helper at all. Any
  terminal that takes OSC 10/11/12/4 works: iTerm2, Ghostty, kitty, WezTerm,
  Alacritty, GNOME Terminal and the other VTE terminals. **iTerm2** also gets
  a real colored tab. (Not verified on every one of these yet: reports welcome.)
- **tmux**: sequences are wrapped for passthrough and Color Code switches on
  `allow-passthrough` for its own pane (tmux 3.3+); the color then applies to
  the outer terminal window.

## Limits

- Claude Code's plugin API is early access: it can change between releases.
  Color Code leans on as little as it can, and every part fails soft: if a
  Claude Code update changes how `/color` reports or how themes are named, the
  terminal coloring keeps working.
- Windows Terminal clears a tab's colors when the tab moves to another window
  or the settings reload; Color Code repaints it within about 15 seconds (at
  once on your next prompt).
- Windows Terminal can't take a tab color from inside the tab, so the tab and
  title bar follow the tab's background through a theme in its settings; the
  setup question adds it (with a backup next to `settings.json`).

## Customizing

Themes are generated by `tools/gen_themes.py`: edit the hues or contrast
targets there and run `python tools/gen_themes.py`; it prints the lowest
contrast in each theme and refuses to write one under 4.5:1. Rebuild the
helper with `csc /target:exe /out:bin\osc.exe tools\osc.cs` (the C# compiler
that ships with Windows under `C:\Windows\Microsoft.NET\Framework64\v4.0.30319`).

Set `COLOR_CODE_DEBUG=1` to have the plugin log each step to `debug.log`.

## Roadmap

Ideas, roughly in order:

- Name on the tab: show the session's `/rename` name as the terminal tab title.
- Color by state: tint the tab red when a turn ends in an error, green when a
  long task finishes while you were away.
- Per-project color file: a `.claude/color` a team commits so a repo opens in
  its color for everyone.
- More palettes: high-contrast and colorblind-safe sets, and custom hues.
- Subagent rows tinted in their agent's color in the transcript.
- VS Code and JetBrains terminals (they ignore most OSC color sequences today).

## License

MIT
