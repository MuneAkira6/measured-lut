"""Generate reference values for tests/color.test.ts with colour-science.

Run from the repo root:
  uv run -q --no-project --with colour-science --with numpy python -I scripts/golden.py
Writes tests/golden/color.json. Commit the JSON; the tests do not need Python.
"""
import json
import pathlib

import colour
import numpy as np

rng = np.random.default_rng(20261115)
D65 = colour.CCS_ILLUMINANTS["CIE 1931 2 Degree Standard Observer"]["D65"]

# Encoded RGB: random values plus the corners, mid grey and values near the
# linear/power seam of the transfer curve (0.04045 encoded).
rgb = np.concatenate([
    rng.random((40, 3)),
    np.array([[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5],
              [0.04, 0.0405, 0.041], [0.003, 0.2, 0.9]]),
])

spaces = {}
for name, cs in (("srgb", colour.models.RGB_COLOURSPACE_sRGB),
                 ("display-p3", colour.models.RGB_COLOURSPACE_DISPLAY_P3)):
    linear = cs.cctf_decoding(rgb)
    xyz = linear @ cs.matrix_RGB_to_XYZ.T
    spaces[name] = {
        "matrix": cs.matrix_RGB_to_XYZ.tolist(),
        "linear": linear.tolist(),
        "xyz": xyz.tolist(),
        "lab": colour.XYZ_to_Lab(xyz, D65).tolist(),
    }

srgb, p3 = colour.models.RGB_COLOURSPACE_sRGB, colour.models.RGB_COLOURSPACE_DISPLAY_P3
srgb_to_p3 = np.linalg.inv(p3.matrix_RGB_to_XYZ) @ srgb.matrix_RGB_to_XYZ

# CIEDE2000 pairs: random, near-neutral (where the formula is least stable),
# and pairs straddling the a* = 0 axis.
lab1 = np.concatenate([
    np.column_stack([rng.uniform(5, 95, 40), rng.uniform(-80, 80, 40), rng.uniform(-80, 80, 40)]),
    np.column_stack([rng.uniform(20, 90, 20), rng.uniform(-2, 2, 20), rng.uniform(-2, 2, 20)]),
])
lab2 = lab1 + rng.normal(0, 3, lab1.shape)
lab2[40:, 1] = -lab1[40:, 1]

out = {
    "rgb": rgb.tolist(),
    "spaces": spaces,
    "srgb_to_p3": srgb_to_p3.tolist(),
    "de2000": {
        "lab1": lab1.tolist(),
        "lab2": lab2.tolist(),
        "de": colour.delta_E(lab1, lab2, method="CIE 2000").tolist(),
    },
    "colour_version": colour.__version__,
}
path = pathlib.Path("tests/golden/color.json")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, indent=1))
print(f"wrote {path} with colour-science {colour.__version__}")
