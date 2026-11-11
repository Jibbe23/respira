# Writes stitches [x, y, cmd, colorIndex] (0.1 mm units, respira command
# bits MOVE = 0x10, TRIM = 0x20) and their threads as a PES file (version 6).
# Run in Pyodide by the pattern worker; `stitches` and `threads` are passed in.
import io

import pystitch
from pystitch.EmbConstant import STITCH, JUMP, TRIM

JS_MOVE = 0x10
JS_TRIM = 0x20


def ascii_text(value):
    # The PES writer stores the character count, then UTF-8 bytes: keep the
    # text ASCII so both agree (e.g. "Grün" becomes "Grn")
    return str(value).encode("ascii", "ignore").decode("ascii")


def make_thread(t):
    thread = pystitch.EmbThread()
    thread.set(t["hex"])
    if t.get("catalogNumber"):
        thread.catalog_number = ascii_text(t["catalogNumber"])
    if t.get("description"):
        thread.description = ascii_text(t["description"])
    if t.get("brand"):
        thread.brand = ascii_text(t["brand"])
    if t.get("chart"):
        thread.chart = ascii_text(t["chart"])
    return thread


def build_pattern(stitches, threads):
    # One thread per color block, taken from the block's color index (indices
    # may skip a thread or come back to one)
    pattern = pystitch.EmbPattern()
    color = None
    for x, y, cmd, color_index in stitches:
        if color_index != color:
            if color is not None:
                pattern.color_change()
            pattern.add_thread(make_thread(threads[int(color_index)]))
            color = color_index
        if cmd & JS_TRIM:
            pattern.add_command(TRIM)
            if not cmd & JS_MOVE:
                # A cut from an imported file: only the cut, no stitch
                continue
        pattern.add_stitch_absolute(JUMP if cmd & JS_MOVE else STITCH, x, y)
    pattern.end()
    return pattern


def write_pes(stitches, threads):
    stream = io.BytesIO()
    pystitch.write_pes(build_pattern(stitches, threads), stream, {"version": 6})
    return stream.getvalue()
