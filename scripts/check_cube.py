"""Read a .cube written by measured-lut back with colour-science and compare.

  uv run -q --no-project --with colour-science --with numpy python -I scripts/check_cube.py LUT.cube PROBES.json

PROBES.json: {"in": [[r, g, b], ...], "out": [[r, g, b], ...]} where "out" is what
measured-lut's own trilinear lookup returned for "in". The script checks that
colour-science parses the file (size, domain) and that its trilinear lookup on
the same inputs agrees.
"""
import json
import sys

import colour
import numpy as np

lut = colour.read_LUT(sys.argv[1])
probes = json.load(open(sys.argv[2]))
x, ours = np.array(probes["in"]), np.array(probes["out"])
theirs = lut.apply(x, interpolator=colour.algebra.table_interpolation_trilinear)
diff = np.abs(theirs - ours)
print(f"{type(lut).__name__} size={lut.size} domain={lut.domain.tolist()} title={lut.name!r}")
print(f"probes={len(x)} max|diff|={diff.max():.2e} ({diff.max() * 255:.4f} of an 8-bit code value)")
sys.exit(0 if lut.size == 33 and diff.max() < 1e-5 else 1)
