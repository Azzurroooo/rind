"""Standalone terminal theme sampler. Run: python preview_themes.py --help."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import os
import shutil
import sys


# name, background, foreground, muted, blue, green, red, yellow, purple, cyan
# Representative dark variants; sample roles are mapped consistently for comparison.
THEMES = {
    "catppuccin": ("Catppuccin Mocha", "1e1e2e", "cdd6f4", "a6adc8", "89b4fa", "a6e3a1", "f38ba8", "f9e2af", "cba6f7", "94e2d5"),
    "dracula": ("Dracula", "282a36", "f8f8f2", "6272a4", "bd93f9", "50fa7b", "ff5555", "f1fa8c", "ff79c6", "8be9fd"),
    "gruvbox": ("Gruvbox Dark", "282828", "ebdbb2", "928374", "83a598", "b8bb26", "fb4934", "fabd2f", "d3869b", "8ec07c"),
    "nord": ("Nord", "2e3440", "d8dee9", "81a1c1", "81a1c1", "a3be8c", "bf616a", "ebcb8b", "b48ead", "88c0d0"),
    "tokyo-night": ("Tokyo Night", "1a1b26", "c0caf5", "565f89", "7aa2f7", "9ece6a", "f7768e", "e0af68", "bb9af7", "7dcfff"),
    "rose-pine": ("Rose Pine", "191724", "e0def4", "908caa", "31748f", "9ccfd8", "eb6f92", "f6c177", "c4a7e7", "ebbcba"),
    "solarized": ("Solarized Dark", "002b36", "839496", "586e75", "268bd2", "859900", "dc322f", "b58900", "6c71c4", "2aa198"),
    "one-dark": ("One Dark", "282c34", "abb2bf", "5c6370", "61afef", "98c379", "e06c75", "e5c07b", "c678dd", "56b6c2"),
    "monokai": ("Monokai", "272822", "f8f8f2", "75715e", "66d9ef", "a6e22e", "f92672", "e6db74", "ae81ff", "a1efe4"),
    "everforest": ("Everforest Dark Medium", "2d353b", "d3c6aa", "859289", "7fbbb3", "a7c080", "e67e80", "dbbc7f", "d699b6", "83c092"),
}
ROLES = ("bg", "fg", "muted", "blue", "green", "red", "yellow", "purple", "cyan")
RESET = "\x1b[0m"


def rgb(hex_color: str, background: bool = False) -> str:
    channels = ";".join(str(int(hex_color[i:i + 2], 16)) for i in (0, 2, 4))
    return f"\x1b[{48 if background else 38};2;{channels}m"


@contextmanager
def windows_ansi(enabled: bool):
    """Enable Windows VT output only for this run, restoring the prior mode."""
    restore = None
    if enabled and os.name == "nt" and sys.stdout.isatty():
        import ctypes
        import msvcrt
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        handle = msvcrt.get_osfhandle(sys.stdout.fileno())
        mode = wintypes.DWORD()
        if kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            if kernel.SetConsoleMode(handle, mode.value | 0x0004):
                restore = (kernel, handle, mode.value)
    try:
        yield
    finally:
        if restore:
            kernel, handle, mode = restore
            kernel.SetConsoleMode(handle, mode)


def preview(key: str, width: int, color: bool, terminal_background: bool) -> None:
    name, *values = THEMES[key]
    palette = dict(zip(ROLES, values))
    background = rgb(palette["bg"], True) if color and not terminal_background else ""
    padding = 2 if width >= 12 else 0
    content_width = max(1, width - 2 * padding)

    def line(*segments: tuple[str, str]) -> None:
        # All sample text is ASCII, so character count equals terminal cell width.
        # Wrap before painting; ANSI sequences never affect the measured width.
        parts: list[str] = []
        used = 0

        def flush() -> None:
            body = " " * padding + "".join(parts) + " " * (width - padding - used)
            print(background + body + (RESET if color else ""))

        for role, text in segments:
            while text:
                chunk, text = text[:content_width - used], text[content_width - used:]
                parts.append((rgb(palette[role]) if color else "") + chunk)
                used += len(chunk)
                if used == content_width:
                    flush()
                    parts = []
                    used = 0
        if parts or not segments:
            flush()

    line()
    line(("fg", name), ("muted", f"  [{key}]"))
    line(("muted", f"Background #{palette['bg'].upper()} / Text #{palette['fg'].upper()}"))
    line()
    line(*[(role, "##### ") for role in ("red", "yellow", "green", "cyan", "blue", "purple", "fg", "muted")])
    line(("green", "user@host "), ("blue", "~/project "), ("purple", "(main) "), ("fg", "$ rind"))
    line(("fg", "How can I help you today?"))
    line(("muted", "Thinking... inspecting the workspace"))
    line(("green", "PASS  "), ("fg", "24 tests passed"))
    line(("yellow", "WARN  "), ("fg", "Cached model list is 24 hours old"))
    line(("red", "ERROR "), ("fg", "Connection failed; cached data retained"))
    line(("cyan", "src/main.py"), ("muted", ":12  updated just now"))
    line()
    line(("purple", "def "), ("blue", "greet"), ("fg", "(name):"))
    line(("purple", "    return "), ("green", 'f"Hello, {name}!"'))
    line(("muted", "# A quiet comment beside colorful syntax"))
    line()
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview ten terminal palettes using 24-bit ANSI colors. No dependencies or settings changes.")
    parser.add_argument("--theme", nargs="+", choices=THEMES, help="Show only these themes, in order")
    parser.add_argument("--terminal-background", action="store_true", help="Keep your terminal background; compare text colors only")
    parser.add_argument("--color", choices=("auto", "always", "never"), default="auto", help="Default: colors on a TTY, plain text when redirected")
    args = parser.parse_args()
    # Color is the purpose of this explicit preview: NO_COLOR does not suppress it.
    color = args.color == "always" or (args.color == "auto" and sys.stdout.isatty())
    width = max(1, min(78, shutil.get_terminal_size((80, 24)).columns - 1))
    with windows_ansi(color):
        print("Terminal theme preview | 24-bit color | scroll to compare")
        print("Sample text only; no commands shown below are executed.\n")
        for key in args.theme or THEMES:
            preview(key, width, color, args.terminal_background)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
