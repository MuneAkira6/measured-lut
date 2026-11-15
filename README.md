# measured-lut

measured-lut fits a 3D LUT (`.cube`) that maps one camera's colours to another's. You give it photos of the same scene taken with both cameras. Everything runs in the browser, and the photos are never uploaded.

**[Open the tool](https://muneakira6.github.io/measured-lut/)**. If you have no photos at hand, press *Try a sample pair*.

It was tested on 286 photo pairs (iPhone 17 Pro Max → X100VI, 93 scenes, converted to JPEG with macOS). After you place the points, the tool scores how well the two photos line up. When the score was 0.6 or more (89 pairs, 43 scenes), the median CIEDE2000 difference on held-out pixels dropped from 6.5 to 1.1:

| Alignment score | Pairs | Held-out ΔE00 median, before → after | P95, before → after |
|---|---|---|---|
| 0.75 or more | 43 | 6.23 → 1.03 | 11.1 → 3.5 |
| 0.6–0.75 | 46 | 7.25 → 1.24 | 13.5 → 5.3 |
| 0.3–0.6 | 112 | 8.57 → 2.34 | 19.5 → 10.1 |
| below 0.3 | 85 | 11.36 → 4.61 | 29.2 → 20.3 |

Below 0.6 the result gets much worse, so the tool asks for better points. In this test the 4 points came from automatic feature matching instead of clicks.

## Why

On forums, photographers ask how to make a phone match their camera, or how to turn file pairs into a LUT ([pixls.us thread, 53 posts](https://discuss.pixls.us/t/creating-3d-cube-luts-for-camera-ooc-styles/30968)). The tools available today are paid, or Python scripts. One of the browser tools that imitate a camera's look describes its own numbers as "estimates, not measurements". This tool measures the difference from your own photos and reports the error on pixels that were not used for fitting.

## How to use

1. Shoot the same scene with both cameras, a few seconds apart and from the same spot. Distant subjects line up best: the alignment is exact only for a flat or far-away scene, and nearby objects shift against the background between the two shots. In the test, 71 of the 89 well-aligned pairs were taken with the phone's 4× telephoto. Choose subjects that don't move, keep the exposures similar, and avoid blown-out sky. A scene with many different colours gives a LUT that covers more of them.
2. Get JPEGs. HEIC is not supported yet, because Chrome cannot decode it. In Photos for Mac, choose File → Export → Export Photos, then set Photo Kind to JPEG and Color Profile to Display P3. Use the same route for the photos you fit and for the photos you later apply the LUT to: on four test photos, a Photos export differed from the same HEIC converted directly with macOS by a median ΔE00 of 1.8–3.4. Shooting JPEG on the iPhone (Settings → Camera → Formats → Most Compatible) has not been tested.
3. Load the camera you want to change as *Source*, and the one to match as *Target*.
4. Click 4 matching points on each photo. Spread them out and put them on sharp details that did not move. Aim for an alignment score of 0.6 or more; in the *Alignment* view, edges should run straight across the checkerboard squares.
5. Check *Pixels used*, adjust the sliders if needed, and press *Fit*.
6. Compare before and after with the slider, and download the `.cube`.

The LUT expects Display P3 input and outputs Display P3. Apply it to the source camera's photos in a Display P3 working space; in an editor that only works in sRGB, colours outside sRGB will come out wrong.

## How it works

### Colour

The browser is told not to colour-manage the image (`colorSpaceConversion: "none"`), so the tool sees the code values stored in the file. To tell sRGB from Display P3, it reads the primaries and tone curve in the ICC profile rather than the profile's name. Files without a profile fall back to the EXIF ColorSpace tag. Other ICC profiles, such as the table-based "Apple Wide Color Sharing Profile" that Photos writes by default, are converted to Display P3 by the browser.

In Chromium, both paths were checked on real files. A Display P3 JPEG decoded this way matched Pillow's decoding without colour management (channel means equal to 3 decimals; sampled pixels identical). A Photos export with the Apple profile matched LittleCMS's conversion to Display P3 (channel means within 0.06; sampled pixels identical).

### Alignment

Four point pairs give a homography (normalised DLT, Hartley & Zisserman, Algorithm 4.2). The source image is warped onto the target frame with bilinear sampling.

### Sampling

Both images are scaled down to 1000 px and blurred slightly (σ = 2 px). Pixels near edges (the top 30 % by gradient), clipped or near-black pixels, and pixels outside the overlap are dropped. 20 % of the 32-px blocks are held out for the error report. Whole blocks are held out rather than single pixels, because neighbouring pixels are nearly duplicates. On three test pairs, holding out random pixels reported medians 0.05–0.11 lower than block holdout.

### Fitting

The fit uses lattice regression ([Garcia & Gupta, NIPS 2009](https://proceedings.neurips.cc/paper_files/paper/2009/file/4b0250793549726d5c1ea3906726ebfe-Paper.pdf); [Garcia, Arora & Gupta, IEEE TIP 2012](http://www.mayagupta.org/publications/GarciaAroraGupta_lattice_regression_IEEETransImageProcessing2012.pdf)). The unknowns are the 33³ lattice values, solved so that the LUT *after trilinear interpolation* matches the pairs. Three terms are added to the data term:

- Thin-plate smoothness: second differences along each axis, plus mixed differences with weight 2 (the "torsion" term in [Gupta et al., JMLR 2016](https://jmlr.org/papers/volume17/15-243/15-243.pdf)). Its null space is exactly the affine functions, so regions without data are filled by smooth continuation. A first-order Laplacian flattens those regions instead; Garcia & Gupta (CIC 2009, 2010) report clipped saturated colours and lost contrast near the gamut boundary.
- A ridge that grows with lattice distance from the nearest sample. It pulls empty corners of the cube back to a prior, a 3×3 matrix fitted in linear light. To compare priors, the 10 % most saturated pixels of each pair were left out of the fit and used as the test. The matrix prior beat the identity on all three test pairs (on one of them: median 2.78 → 1.24, P95 14.7 → 8.8).
- The fit runs on the source's encoded values, because that is the space the `.cube` is applied in. In linear light, the first of the 32 lattice steps would already cover sRGB code values 0–0.19, far too coarse for shadows.

The system is symmetric positive definite. It is solved with Jacobi-preconditioned conjugate gradients without building the matrix: CG only needs matrix × vector, which is one pass over the samples and one over the lattice. With 60,000 pairs this took 106–127 iterations and 1.4–1.8 s on the main thread in Chromium.

### Checks

Colour conversions, CIEDE2000 and the trilinear lookup are tested against reference values generated with [colour-science](https://www.colour-science.org/) (`scripts/golden.py`). Exported `.cube` files are read back with colour-science (`scripts/check_cube.py`); on 500 random colours its lookup and this tool's differed by at most 4.8e-8.

## Limitations

- A 3D LUT is a global mapping: each input colour has exactly one output. If the fit pixels still differ by a median above 3 after fitting, the tool shows a warning. Possible causes are misalignment, movement or a change in light between shots, or local processing in the phone, which a global LUT cannot represent. In the test, 4 % of the pairs with a good alignment score still got this warning.
- One pair covers only part of the colour cube. Everything outside it comes from the prior. Combining several pairs into one LUT is planned.
- Input is 8-bit JPEG only. No HEIC, RAW or HDR gain maps.
- Tested in Chromium only. Safari and Firefox may handle `colorSpaceConversion` or Display P3 canvases differently.

## Problems found during development

- Most test pairs were not aligned well enough. On 286 pairs, the fitted error rose steadily as alignment got worse, and 73 % of pairs scoring below 0.3 ended with the warning. The tool now shows the alignment score (the correlation of fine detail between the two photos) right after the points are placed, before any fitting.
- Photos exports: with default settings, Photos wrote JPEGs with a table-based Apple profile (3 of 4 test photos) or with no profile at all (1 of 4). The tool first refused all of them. The table-based profile is now converted by the browser. Files without a profile are still refused, with a message saying how to export them again.
- Holdout: random-pixel holdout gave slightly better numbers than block holdout (see *Sampling*). The report uses blocks.
- Smoothness term: taken literally, the TIP 2012 regulariser uses second differences along each axis only. In 3-D this leaves twists such as r·g unpenalised: the null space is 8-dimensional instead of 4 (checked numerically). The mixed terms fix this, and a test checks the null space.
- Browser decoding: in Chromium, drawing a Display P3 JPEG onto a default canvas converts it to sRGB. Decoding with conversion turned off, and comparing the result with Pillow, solved this.
- sRGB matrix: a matrix derived from the primaries differed from colour-science's by about 1e-5. IEC 61966-2-1 publishes the matrix rounded to 4 decimals and colour-science uses it, so the tool does too.

## Development

```sh
npm install
npm run dev     # http://localhost:5173/measured-lut/
npm test        # Vitest; no Python needed
# regenerate reference values, or check an exported .cube (needs uv):
uv run -q --no-project --with colour-science --with numpy python -I scripts/golden.py
uv run -q --no-project --with colour-science --with numpy python -I scripts/check_cube.py LUT.cube PROBES.json
```

Built with Vite, TypeScript and React. React is the only runtime dependency. The sample photos in `public/sample/` have had their metadata removed except for colour information.

## Trademarks

iPhone is a trademark of Apple Inc. X100VI is a trademark of FUJIFILM Corporation. This project is not affiliated with, endorsed by, or sponsored by either company. Camera names appear only to describe what was tested.

## License

MIT

## 日本語

同じ場面を2台のカメラで撮った写真のペアから、ブラウザ内で3D LUT（.cube）を作成するツールです。写真は外部に送信しません。
写真ペアから色の対応を実測し、学習に使っていない画素で補正前後の色差（CIEDE2000）を表示します。
ツールは https://muneakira6.github.io/measured-lut/ で使えます。手元に写真がなくても、サンプルの写真ペアで試せます。
使い方と手法の詳細は英語の本文にまとめています。
