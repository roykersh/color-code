"""Generates themes/<color>.json for the color-code plugin.

Each file is a Claude Code custom theme ("base" + "overrides") plus a
"terminal" block the mod sends to the Windows Terminal tab as OSC 10/11/12/4.
Every color is checked for contrast against its own tinted background, so the
model name, modes, tokens, diffs and dim text stay readable on every theme.

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


def hue_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def rgb(c):
    return f"rgb({c[0]},{c[1]},{c[2]})"


def hexc(c):
    return "#%02x%02x%02x" % c


def build(name, hue, s_bg, s_acc, l_acc):
    bg = hsl(hue, s_bg, 0.125)
    accent = lift(hsl(hue, s_acc, l_acc), bg, 5.0)
    o = {}

    # Surfaces: steps of the theme's own hue above the background.
    o["userMessageBackground"] = hsl(hue, s_bg * 0.75, 0.21)
    o["userMessageBackgroundHover"] = hsl(hue, s_bg * 0.75, 0.25)
    o["composerSidebarBackground"] = hsl(hue, s_bg * 0.75, 0.17)
    o["bashMessageBackgroundColor"] = hsl(hue + 300, s_bg * 0.45, 0.20)
    o["memoryBackgroundColor"] = hsl(hue + 40, s_bg * 0.45, 0.20)
    o["selectionBg"] = hsl(hue, s_bg, 0.33)
    o["clawd_background"] = bg

    # Text tiers, tinted toward the hue, each held to a contrast floor.
    o["text"] = lift(hsl(hue, 0.35, 0.94), bg, 13)
    o["inverseText"] = hsl(hue, 0.4, 0.06)
    o["inactive"] = lift(hsl(hue, 0.18, 0.62), bg, 5.0)
    o["inactiveShimmer"] = lift(hsl(hue, 0.18, 0.75), bg, 8.0)
    o["subtle"] = lift(hsl(hue, 0.22, 0.34), bg, 2.0)
    o["promptBorder"] = accent
    o["promptBorderShimmer"] = lift(accent, bg, 8.0)
    o["rate_limit_empty"] = hsl(hue, 0.25, 0.30)

    # Accents: readable on the tint; one sharing the theme's hue is lifted
    # further so it never melts into the background or the prompt bar.
    for key, c in DARK.items():
        h = to_hls(c)[0]
        near = hue_gap(h, hue) < 28 and to_hls(c)[2] > 0.25
        o[key] = lift(c, bg, 7.5 if near else 4.8)
    o[f"{name}_FOR_SUBAGENTS_ONLY"] = accent

    # Diff rows: backgrounds stand off the tint, words stay readable on them.
    for key, c in DIFF_BG.items():
        h, l, s = to_hls(c)
        while contrast(c, bg) < 1.45 and l < 0.40:
            l += 0.01
            c = hsl(h, s, l)
        o[key] = c
    for key, c in DIFF_WORD.items():
        o[key] = lift(c, bg, 4.5)

    # Terminal: background, text, cursor and a 16-color palette for the tab.
    ansi = []
    for i, c in enumerate(ANSI_BASE):
        if i == 0:
            ansi.append(hsl(hue, s_bg, 0.07))
        elif i == 8:
            ansi.append(lift(hsl(hue, 0.15, 0.45), bg, 3.2))
        elif i in (7, 15):
            ansi.append(lift(hsl(hue, 0.15, 0.80 if i == 7 else 0.95), bg, 9 if i == 7 else 14))
        else:
            ansi.append(lift(c, bg, 6.0 if i > 8 else 4.6))

    worst = min(
        (contrast(c, bg), k)
        for k, c in o.items()
        if k not in DIFF_BG and "Background" not in k and k not in ("selectionBg", "subtle", "inverseText", "rate_limit_empty", "clawd_background")
    )
    return {
        "name": f"Session {name}",
        "base": "dark",
        "overrides": {k: rgb(v) for k, v in o.items()},
        "terminal": {
            "background": hexc(bg),
            "foreground": hexc(o["text"]),
            "cursor": hexc(accent),
            "ansi": [hexc(c) for c in ansi],
        },
    }, worst


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "themes")
    os.makedirs(out, exist_ok=True)
    for name, spec in COLORS.items():
        theme, (ratio, key) = build(name, *spec)
        with open(os.path.join(out, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(theme, f, indent=2)
            f.write("\n")
        print(f"{name:7} bg {theme['terminal']['background']}  lowest contrast {ratio:4.1f} ({key})")


if __name__ == "__main__":
    main()
