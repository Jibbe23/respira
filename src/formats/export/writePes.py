# Writes stitches [x, y, cmd, colorIndex] (0.1 mm units, respira command
# bits MOVE = 0x10, TRIM = 0x20) and their threads as a PES file (version 6).
# Run in Pyodide by the pattern worker; `stitches` and `threads` are passed in.
import io

import pystitch
from pystitch.EmbConstant import STITCH, JUMP, TRIM

JS_MOVE = 0x10
JS_TRIM = 0x20


def build_pattern(stitches, threads):
    pattern = pystitch.EmbPattern()
    for t in threads:
        thread = pystitch.EmbThread()
        thread.set(t["hex"])
        if t.get("catalogNumber"):
            thread.catalog_number = t["catalogNumber"]
        if t.get("description"):
            thread.description = t["description"]
        if t.get("brand"):
            thread.brand = t["brand"]
        if t.get("chart"):
            thread.chart = t["chart"]
        pattern.add_thread(thread)

    color = None
    for x, y, cmd, color_index in stitches:
        if color is not None and color_index != color:
            pattern.color_change()
        color = color_index
        if cmd & JS_TRIM:
            pattern.add_command(TRIM)
        pattern.add_stitch_absolute(JUMP if cmd & JS_MOVE else STITCH, x, y)
    pattern.end()
    return pattern


def write_pes(stitches, threads):
    stream = io.BytesIO()
    pystitch.write_pes(build_pattern(stitches, threads), stream, {"version": 6})
    return stream.getvalue()
