"""Generates themes/<color>.json and themes/<color>-light.json for color-code.

Each file is a Claude Code custom theme ("base" + "overrides") plus a
"terminal" block the mod sends to the terminal tab as OSC 10/11/12/4 (and
"tab", the vivid accent, for iTerm2's tab color). Every color is checked for
contrast against its own tinted background, so the model name, modes, tokens,
diffs, dim text and the eight subagent colors stay readable on every theme:
lifted (lighter) on the dark tints, darkened on the pale light tints.

Run: python gen_themes.py   (writes ../themes/*.json)
"""
import colorsys
import json
import os

# hue (deg), background saturation, accent saturation, accent lightness
COLORS = {
    "red":    (0,   0.62, 0.78, 0.60),
    "orange": (20,  0.62, 0.85, 0.60),
    "yellow": (46,  0.62, 0.90, 0.55),
    "green":  (140, 0.55, 0.62, 0.52),
    "cyan":   (188, 0.62, 0.80, 0.50),
    "blue":   (215, 0.62, 0.75, 0.62),
    "purple": (262, 0.50, 0.65, 0.70),
    "pink":   (330, 0.55, 0.70, 0.66),
}

# Claude Code's dark theme, the base every theme here starts from.
DARK = {
    "autoAccept": (175, 135, 255), "autoAcceptShimmer": (208, 180, 255),
    "skill": (175, 135, 255), "bashBorder": (253, 93, 177),
    "claude": (215, 119, 87), "claudeShimmer": (235, 159, 127),
    "claudeBlue_FOR_SYSTEM_SPINNER": (147, 165, 255),
    "claudeBlueShimmer_FOR_SYSTEM_SPINNER": (177, 195, 255),
    "permission": (177, 185, 249), "permissionShimmer": (207, 215, 255),
    "planMode": (72, 150, 140), "ide": (71, 130, 200),
    "suggestion": (177, 185, 249), "remember": (177, 185, 249),
    "success": (78, 186, 101), "error": (255, 107, 128),
    "warning": (255, 193, 7), "warningShimmer": (255, 223, 57),
    "merged": (175, 135, 255),
    "red_FOR_SUBAGENTS_ONLY": (220, 38, 38), "blue_FOR_SUBAGENTS_ONLY": (106, 155, 204),
    "green_FOR_SUBAGENTS_ONLY": (22, 163, 74), "yellow_FOR_SUBAGENTS_ONLY": (202, 138, 4),
    "purple_FOR_SUBAGENTS_ONLY": (130, 125, 189), "orange_FOR_SUBAGENTS_ONLY": (217, 119, 87),
    "pink_FOR_SUBAGENTS_ONLY": (196, 102, 134), "cyan_FOR_SUBAGENTS_ONLY": (8, 145, 178),
    "professionalBlue": (106, 155, 204), "chromeYellow": (251, 188, 4),
    "clawd_body": (215, 119, 87),
    "rate_limit_fill": (177, 185, 249),
    "fastMode": (255, 120, 20), "fastModeShimmer": (255, 165, 70),
    "effortUltra": (175, 135, 255),
    "briefLabelYou": (122, 180, 232), "briefLabelClaude": (215, 119, 87),
    "rainbow_red": (235, 95, 87), "rainbow_orange": (245, 139, 87),
    "rainbow_yellow": (250, 195, 95), "rainbow_green": (145, 200, 130),
    "rainbow_blue": (130, 170, 220), "rainbow_indigo": (155, 130, 200),
    "rainbow_violet": (200, 130, 180),
    "rainbow_red_shimmer": (250, 155, 147), "rainbow_orange_shimmer": (255, 185, 137),
    "rainbow_yellow_shimmer": (255, 225, 155), "rainbow_green_shimmer": (185, 230, 180),
    "rainbow_blue_shimmer": (180, 205, 240), "rainbow_indigo_shimmer": (195, 180, 230),
    "rainbow_violet_shimmer": (230, 180, 210),
}
DIFF_BG = {
    "diffAdded": (34, 92, 43), "diffRemoved": (122, 41, 54),
    "diffAddedDimmed": (71, 88, 74), "diffRemovedDimmed": (105, 72, 77),
}
DIFF_WORD = {"diffAddedWord": (56, 166, 96), "diffRemovedWord": (179, 89, 107)}

# Windows Terminal "Campbell" ANSI hues, re-lit per theme.
ANSI_BASE = [
    (12, 12, 12), (197, 15, 31), (19, 161, 14), (193, 156, 0),
    (0, 55, 218), (136, 23, 152), (58, 150, 221), (204, 204, 204),
    (118, 118, 118), (231, 72, 86), (22, 198, 12), (249, 241, 165),
    (59, 120, 255), (180, 0, 158), (97, 214, 214), (242, 242, 242),
]

# Claude Code's light theme, the base of every -light theme.
LIGHT = {
    "autoAccept": (135, 0, 255), "autoAcceptShimmer": (160, 60, 255),
    "skill": (135, 0, 255), "bashBorder": (255, 0, 135),
    "claude": (215, 119, 87), "claudeShimmer": (245, 149, 117),
    "claudeBlue_FOR_SYSTEM_SPINNER": (87, 105, 247),
    "claudeBlueShimmer_FOR_SYSTEM_SPINNER": (117, 135, 255),
    "permission": (87, 105, 247), "permissionShimmer": (137, 155, 255),
    "planMode": (0, 102, 102), "ide": (71, 130, 200),
    "suggestion": (87, 105, 247), "remember": (0, 0, 255),
    "success": (44, 122, 57), "error": (171, 43, 63),
    "warning": (150, 108, 30), "warningShimmer": (200, 158, 80),
    "merged": (135, 0, 255),
    "professionalBlue": (106, 155, 204), "chromeYellow": (251, 188, 4),
    "clawd_body": (215, 119, 87),
    "rate_limit_fill": (87, 105, 247),
    "fastMode": (255, 106, 0), "fastModeShimmer": (255, 150, 50),
    "effortUltra": (135, 0, 255),
    "briefLabelYou": (37, 99, 235), "briefLabelClaude": (215, 119, 87),
    "rainbow_red": (235, 95, 87), "rainbow_orange": (245, 139, 87),
    "rainbow_yellow": (250, 195, 95), "rainbow_green": (145, 200, 130),
    "rainbow_blue": (130, 170, 220), "rainbow_indigo": (155, 130, 200),
    "rainbow_violet": (200, 130, 180),
    "rainbow_red_shimmer": (250, 155, 147), "rainbow_orange_shimmer": (255, 185, 137),
    "rainbow_yellow_shimmer": (255, 225, 155), "rainbow_green_shimmer": (185, 230, 180),
    "rainbow_blue_shimmer": (180, 205, 240), "rainbow_indigo_shimmer": (195, 180, 230),
    "rainbow_violet_shimmer": (230, 180, 210),
}
LIGHT_DIFF_BG = {
    "diffAdded": (105, 219, 124), "diffRemoved": (255, 168, 180),
    "diffAddedDimmed": (199, 225, 203), "diffRemovedDimmed": (253, 210, 216),
}
LIGHT_DIFF_WORD = {"diffAddedWord": (47, 157, 68), "diffRemovedWord": (209, 69, 75)}

# The subagent colors Claude Code gives agents and teammates, by name: the
# hue each must keep so "the red agent" still reads as red on every theme.
AGENTS = {
    "red": 0, "orange": 24, "yellow": 46, "green": 140,
    "cyan": 188, "blue": 215, "purple": 265, "pink": 330,
}


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, l, s)
    return (round(r * 255), round(g * 255), round(b * 255))


def to_hls(c):
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
    return h * 360, l, s


def lum(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def lift(c, bg, target):
    """Raises c's lightness (hue kept) until it reaches target contrast on bg."""
    h, l, s = to_hls(c)
    while contrast(c, bg) < target and l < 0.97:
        l = min(0.97, l + 0.01)
        c = hsl(h, s, l)
    return c


def darken(c, bg, target):
    """Lowers c's lightness (hue kept) until it reaches target contrast on bg."""
    h, l, s = to_hls(c)
    while contrast(c, bg) < target and l > 0.03:
        l = max(0.03, l - 0.01)
        c = hsl(h, s, l)
    return c


def hue_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def lab(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in c)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a, b):
    return sum((p - q) ** 2 for p, q in zip(lab(a), lab(b))) ** 0.5


def rgb(c):
    return f"rgb({c[0]},{c[1]},{c[2]})"


def hexc(c):
    return "#%02x%02x%02x" % c


def agents(name, hue, accent, bg, fit, light):
    """The eight subagent colors: each keeps its own hue, reads >= 4.5 on bg,
    the session's own is the accent, and no two collapse into each other."""
    out = {}
    for agent, h in AGENTS.items():
        if agent == name:
            out[agent] = accent
            continue
        # One near the session's hue steps further from the background.
        near = hue_gap(h, hue) < 30
        start = hsl(h, 0.80, 0.40 if light else 0.62)
        out[agent] = fit(start, bg, 6.5 if near else 4.8)
    # Pull apart any pair that reads too alike: step the one that is not the
    # session's further from the background until they separate.
    for _ in range(40):
        worst = min(
            (delta_e(out[a], out[b]), a, b)
            for i, a in enumerate(AGENTS) for b in list(AGENTS)[i + 1:]
        )
        if worst[0] >= 22:
            break
        _, a, b = worst
        move = b if a == name else a if b == name else max(a, b, key=lambda k: contrast(out[k], bg))
        c = out[move]
        out[move] = fit(c, bg, contrast(c, bg) + 0.6)
    return {f"{agent}_FOR_SUBAGENTS_ONLY": c for agent, c in out.items()}


def build(name, hue, s_bg, s_acc, l_acc, light=False):
    """One theme: the dark tint, or with light the pale tint and dark text."""
    fit = darken if light else lift
    vivid = hsl(hue, s_acc, l_acc)
    if light:
        bg = hsl(hue, min(0.85, s_bg + 0.2), 0.925)
        accent = darken(hsl(hue, s_acc, min(l_acc, 0.48)), bg, 5.0)
    else:
        bg = hsl(hue, s_bg, 0.125)
        accent = lift(vivid, bg, 5.0)
    o = {}

    # Surfaces: steps of the theme's own hue off the background.
    if light:
        s = min(0.85, s_bg + 0.2)
        o["userMessageBackground"] = hsl(hue, s * 0.8, 0.865)
        o["userMessageBackgroundHover"] = hsl(hue, s * 0.8, 0.835)
        o["composerSidebarBackground"] = hsl(hue, s * 0.8, 0.895)
        o["bashMessageBackgroundColor"] = hsl(hue + 300, s * 0.5, 0.885)
        o["memoryBackgroundColor"] = hsl(hue + 40, s * 0.5, 0.885)
        o["selectionBg"] = hsl(hue, s, 0.78)
    else:
        o["userMessageBackground"] = hsl(hue, s_bg * 0.75, 0.21)
        o["userMessageBackgroundHover"] = hsl(hue, s_bg * 0.75, 0.25)
        o["composerSidebarBackground"] = hsl(hue, s_bg * 0.75, 0.17)
        o["bashMessageBackgroundColor"] = hsl(hue + 300, s_bg * 0.45, 0.20)
        o["memoryBackgroundColor"] = hsl(hue + 40, s_bg * 0.45, 0.20)
        o["selectionBg"] = hsl(hue, s_bg, 0.33)
    o["clawd_background"] = bg

    # Text tiers, tinted toward the hue, each held to a contrast floor.
    if light:
        o["text"] = darken(hsl(hue, 0.35, 0.12), bg, 13)
        o["inverseText"] = hsl(hue, 0.3, 0.97)
        o["inactive"] = darken(hsl(hue, 0.15, 0.40), bg, 5.5)
        o["inactiveShimmer"] = darken(hsl(hue, 0.15, 0.52), bg, 4.5)
        o["subtle"] = darken(hsl(hue, 0.18, 0.72), bg, 1.6)
        o["promptBorder"] = accent
        o["promptBorderShimmer"] = darken(hsl(hue, s_acc, min(l_acc, 0.48) + 0.08), bg, 4.5)
        o["rate_limit_empty"] = hsl(hue, 0.25, 0.80)
    else:
        o["text"] = lift(hsl(hue, 0.35, 0.94), bg, 13)
        o["inverseText"] = hsl(hue, 0.4, 0.06)
        o["inactive"] = lift(hsl(hue, 0.18, 0.62), bg, 5.0)
        o["inactiveShimmer"] = lift(hsl(hue, 0.18, 0.75), bg, 8.0)
        o["subtle"] = lift(hsl(hue, 0.22, 0.34), bg, 2.0)
        o["promptBorder"] = accent
        o["promptBorderShimmer"] = lift(accent, bg, 8.0)
        o["rate_limit_empty"] = hsl(hue, 0.25, 0.30)

    # Accents: readable on the tint; one sharing the theme's hue is pushed
    # further so it never melts into the background or the prompt bar.
    for key, c in (LIGHT if light else DARK).items():
        if key.endswith("_FOR_SUBAGENTS_ONLY"):
            continue
        h, l, s = to_hls(c)
        near = hue_gap(h, hue) < 28 and s > 0.25
        o[key] = fit(c, bg, (7.0 if light else 7.5) if near else 4.8)
    o.update(agents(name, hue, accent, bg, fit, light))

    # Diff rows: backgrounds stand off the tint, words stay readable on them.
    for key, c in (LIGHT_DIFF_BG if light else DIFF_BG).items():
        h, l, s = to_hls(c)
        if light:
            while contrast(c, bg) < 1.25 and l > 0.60:
                l -= 0.01
                c = hsl(h, s, l)
        else:
            while contrast(c, bg) < 1.45 and l < 0.40:
                l += 0.01
                c = hsl(h, s, l)
        o[key] = c
    for key, c in (LIGHT_DIFF_WORD if light else DIFF_WORD).items():
        o[key] = fit(c, bg, 4.5)

    # Terminal: background, text, cursor and a 16-color palette for the tab.
    ansi = []
    for i, c in enumerate(ANSI_BASE):
        if light:
            if i == 0:
                ansi.append(hsl(hue, 0.30, 0.16))
            elif i == 7:
                ansi.append(hsl(hue, 0.20, 0.80))
            elif i == 8:
                ansi.append(darken(hsl(hue, 0.15, 0.42), bg, 4.5))
            elif i == 15:
                ansi.append(hsl(hue, 0.30, 0.98))
            else:
                ansi.append(darken(c, bg, 4.6 if i > 8 else 5.5))
        else:
            if i == 0:
                ansi.append(hsl(hue, s_bg, 0.07))
            elif i == 8:
                ansi.append(lift(hsl(hue, 0.15, 0.45), bg, 3.2))
            elif i in (7, 15):
                ansi.append(lift(hsl(hue, 0.15, 0.80 if i == 7 else 0.95), bg, 9 if i == 7 else 14))
            else:
                ansi.append(lift(c, bg, 6.0 if i > 8 else 4.6))

    skip = set(LIGHT_DIFF_BG if light else DIFF_BG) | {
        "selectionBg", "subtle", "inverseText", "rate_limit_empty", "clawd_background"}
    worst = min((contrast(c, bg), k) for k, c in o.items() if k not in skip and "Background" not in k)
    subs = [o[f"{a}_FOR_SUBAGENTS_ONLY"] for a in AGENTS]
    apart = min(delta_e(a, b) for i, a in enumerate(subs) for b in subs[i + 1:])
    return {
        "name": f"Session {name}{' light' if light else ''}",
        "base": "light" if light else "dark",
        "overrides": {k: rgb(v) for k, v in o.items()},
        "terminal": {
            "background": hexc(bg),
            "foreground": hexc(o["text"]),
            "cursor": hexc(accent),
            "tab": hexc(vivid),
            "ansi": [hexc(c) for c in ansi],
        },
    }, worst, apart


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "themes")
    os.makedirs(out, exist_ok=True)
    floor = 99
    for light in (False, True):
        for name, spec in COLORS.items():
            theme, (ratio, key), apart = build(name, *spec, light=light)
            file = f"{name}-light" if light else name
            with open(os.path.join(out, f"{file}.json"), "w", encoding="utf-8") as f:
                json.dump(theme, f, indent=2)
                f.write("\n")
            floor = min(floor, ratio)
            print(f"{file:12} bg {theme['terminal']['background']}  lowest contrast {ratio:4.1f} ({key})"
                  f"  subagents apart dE {apart:4.1f}")
    if floor < 4.5:
        raise SystemExit(f"a color fell under 4.5:1 ({floor:.2f})")


if __name__ == "__main__":
    main()
