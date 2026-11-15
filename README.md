# measured-lut

measured-lut fits a 3D LUT (`.cube`) that maps one camera's colours to another's, using photos you took of the same scene with both cameras. It runs entirely in the browser, and your photos are never uploaded.

On three test pairs (iPhone 17 Pro Max main camera → X100VI, JPEG), the median CIEDE2000 difference on held-out pixels dropped from 3.3–5.1 to 0.75–0.88:

| Pair | Held-out ΔE00 median, before → after | P95, before → after |
|---|---|---|
| 1 | 5.09 → 0.86 | 9.06 → 3.82 |
| 2 | 3.26 → 0.88 | 8.68 → 3.93 |
| 3 (portrait source) | 5.04 → 0.75 | 10.05 → 3.84 |

A fourth pair, a backlit tree canopy, only went from 9.98 to 6.17 (median). See [Limitations](#limitations).

## Why

The tool measures how far apart two cameras are, using your own photo pairs, and checks the result on pixels left out of the fit. On forums, photographers ask how to make a phone match their camera, or how to turn file pairs into a LUT ([pixls.us thread, 53 posts](https://discuss.pixls.us/t/creating-3d-cube-luts-for-camera-ooc-styles/30968)). The tools available today are paid, or Python scripts. One of the browser tools that imitate a camera's look describes its own numbers as "estimates, not measurements".

## How to use

1. Shoot the same scene with both cameras, a few seconds apart and from about the same spot. Choose subjects that don't move, keep the exposures similar, and avoid blown-out sky. A scene with more different colours gives a LUT that covers more of them.
2. Get JPEGs. HEIC is not supported yet, because Chrome cannot decode it. On an iPhone, you can set Settings → Camera → Formats → Most Compatible, or export from Photos as JPEG. Whether these two give the same colours has not been measured yet. Only sRGB and Display P3 JPEGs are accepted. Other spaces, such as Adobe RGB, are refused rather than guessed.
3. Load the camera you want to change as *Source* and the one to match as *Target*.
4. Click 4 matching points on each photo. Spread them out and put them on things that did not move. The *Alignment* view shows a checkerboard of both photos; edges should run straight across the squares.
5. Check *Pixels used*, adjust the sliders if needed, and press *Fit*.
6. Read the error table, compare before and after with the slider, and download the `.cube`.

The LUT expects Display P3 input and outputs Display P3. Apply it to the source camera's photos in a Display P3 working space. In an editor that works only in sRGB, colours outside sRGB will come out wrong.

## How it works

### Colour

The browser is told not to colour-manage the image (`colorSpaceConversion: "none"`), so the tool sees the code values stored in the file. To tell sRGB from Display P3, it reads the primaries and tone curve in the ICC profile rather than the profile's name. Files without a profile fall back to the EXIF ColorSpace tag. The tool then converts sRGB to Display P3 itself. In Chromium, a Display P3 test image decoded this way matched Pillow's decoding without colour management (channel means equal to 3 decimals; sampled pixels identical).

### Alignment

Four point pairs give a homography (normalised DLT, Hartley & Zisserman, Algorithm 4.2). The source image is warped onto the target frame with bilinear sampling.

### Sampling

Both images are scaled down to 1000 px and blurred slightly (σ = 2 px). Several kinds of pixels are dropped: pixels near edges (the top 30 % by gradient), clipped or near-black pixels, and pixels outside the overlap. 20 % of the 32-px blocks are held out for the error report. Whole blocks are held out rather than single pixels, because neighbouring pixels are nearly duplicates. On the three pairs, holding out random pixels reported medians 0.05–0.11 lower than block holdout, and a lower P95 on two of them.

### Fitting

The fit uses lattice regression ([Garcia & Gupta, NIPS 2009](https://proceedings.neurips.cc/paper_files/paper/2009/file/4b0250793549726d5c1ea3906726ebfe-Paper.pdf); [Garcia, Arora & Gupta, IEEE TIP 2012](http://www.mayagupta.org/publications/GarciaAroraGupta_lattice_regression_IEEETransImageProcessing2012.pdf)). The unknowns are the 33³ lattice values. They are solved so that the LUT *after trilinear interpolation* matches the pairs, instead of fitting a function first and sampling it onto the lattice. Three terms are added to the data term:

- A thin-plate smoothness term: second differences along each axis, plus mixed differences with weight 2 (the "torsion" term in [Gupta et al., JMLR 2016](https://jmlr.org/papers/volume17/15-243/15-243.pdf)). Its null space is exactly the affine functions, so regions without data are filled by smooth continuation. A first-order Laplacian flattens those regions instead; Garcia & Gupta (CIC 2009, 2010) report clipped saturated colours and lost contrast near the gamut boundary.
- A ridge that grows with lattice distance from the nearest sample. It pulls empty corners of the cube back to a prior: a 3×3 matrix fitted in linear light. To compare priors, the 10 % most saturated pixels of each pair were left out of the fit and used as the test. The matrix prior beat the identity on all three pairs (on pair 3: median 2.78 → 1.24, P95 14.7 → 8.8).
- The fit runs on the source's encoded values, because that is the space the `.cube` is applied in. In linear light, the first of the 32 lattice steps would already cover sRGB code values 0–0.19, which is far too coarse for shadows.

The resulting system is symmetric positive definite. It is solved with Jacobi-preconditioned conjugate gradients, and the matrix is never built: CG only needs matrix × vector, which is one pass over the samples and one over the lattice. With 60,000 pairs this took 106–127 iterations and 1.4–1.8 s on the main thread in Chromium. Moving the fit to a Web Worker is planned.

### Checks

Colour conversions, CIEDE2000 and the trilinear lookup are tested against reference values generated with [colour-science](https://www.colour-science.org/) (`scripts/golden.py`). The `.cube` files are read back with colour-science (`scripts/check_cube.py`). On 500 random colours, its lookup and this tool's differed by at most 4.8e-8.

## Limitations

- A 3D LUT is a global mapping: each input colour has exactly one output. If the fit pixels still differ by a median above 3 after fitting, the tool shows a warning. Possible causes are misalignment, movement or a change in light between shots, or local processing in the phone, which a global LUT cannot represent. The backlit-canopy pair ended at 5.5 on its fit pixels. Which of these causes applies there has not been checked.
- One pair covers only part of the colour cube. Everything outside it comes from the prior. Combining several pairs into one LUT is planned.
- Only 8-bit JPEG input in sRGB or Display P3. No HEIC, RAW or HDR gain maps.
- Tested in Chromium only. Safari and Firefox may handle `colorSpaceConversion` or Display P3 canvases differently.

## Problems found during development

- Holdout choice: random-pixel holdout gave slightly better numbers than block holdout (see *Sampling*). The report uses blocks.
- Smoothness term: taken literally, the TIP 2012 regulariser uses second differences along each axis only. In 3-D this leaves twists such as r·g unpenalised: the null space is 8-dimensional instead of 4 (checked numerically). Adding the mixed terms fixed this, and a test checks the null space.
- Browser decoding: in Chromium, drawing a Display P3 JPEG onto a default canvas converts it to sRGB. Decoding with conversion turned off, and comparing the result with Pillow, solved this.
- sRGB matrix: a matrix derived from the primaries differed from colour-science's by about 1e-5. IEC 61966-2-1 publishes the matrix rounded to 4 decimals, and colour-science uses that one, so the tool does too.

## Development

```sh
npm install
npm run dev     # http://localhost:5173/measured-lut/
npm test        # Vitest; no Python needed
# regenerate reference values, or check an exported .cube (needs uv):
uv run -q --no-project --with colour-science --with numpy python -I scripts/golden.py
uv run -q --no-project --with colour-science --with numpy python -I scripts/check_cube.py LUT.cube PROBES.json
```

Built with Vite, TypeScript and React. React is the only runtime dependency.

## AI usage

Tools: Claude Code (Claude Opus 5.5).

What it was used for, and what I decided: I chose this project, approved its rules before any code was written (measure only, no presets or imitations of a camera's look, no uploads, no third-party trademarks in names), and approved the plan for each step. The approach builds on an earlier Python study of my own two cameras. Claude Code searched the literature and design references, wrote the code, tests and this README, and ran the experiments reported above.

Verification: see *Checks*, plus the end-to-end runs on four real photo pairs in Chromium reported at the top.

Errors and open issues: Claude's tests and its own review caught two mistakes before they were committed: the sRGB matrix, and a preconditioner bug where an array was used in place of one of its elements. The first fit test also used a threshold that noise alone could exceed; it now checks RMS error and worst-case error separately. I have not yet reviewed all of the code line by line.

## Trademarks

iPhone is a trademark of Apple Inc. X100VI is a trademark of FUJIFILM Corporation. This project is not affiliated with, endorsed by, or sponsored by either company. Camera names appear only to describe what was tested.

## License

MIT

## 日本語

同じ場面を2台のカメラで撮った写真のペアから、ブラウザ内で3D LUT（.cube）を作成するツールです。写真は外部に送信しません。
写真ペアから色の対応を実測し、学習に使っていない画素で補正前後の色差（CIEDE2000）を表示します。
手法はlattice regressionで、平滑化にthin-plate正則化を使っています。使い方、手法、制約の詳細は英語の本文にまとめています。
