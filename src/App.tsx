import { useEffect, useMemo, useRef, useState } from "react";
import { AlignView } from "./AlignView";
import { PointPicker } from "./PointPicker";
import { pixels, readPhoto, type Photo } from "./decode";
import { fitLut, type FitOptions, type FitResult } from "./fit";
import { homography, warp, type Point } from "./geometry";
import { toCube } from "./lut";
import { Preview } from "./preview";
import { deltaEStats, type ErrorStats } from "./report";
import { DEFAULT_SAMPLE_OPTIONS, alignmentScore, samplePairs, type SampleOptions } from "./samples";

/** Long side of the images the fitter works on. */
const WORK = 1000;

/** A phone -> camera pair shipped with the site, with its 4 point pairs already placed. */
const SAMPLE = {
  source: "sample/source.jpg",
  target: "sample/target.jpg",
  ptsA: [[505.0, 308.2], [1496.9, 227.2], [1264.5, 904.8], [481.9, 756.1]] as Point[],
  ptsB: [[564.5, 210.7], [1578.8, 124.9], [1345.1, 822.2], [540.4, 669.2]] as Point[],
};

export function App() {
  const [src, setSrc] = useState<Photo | null>(null);
  const [dst, setDst] = useState<Photo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ptsA, setPtsA] = useState<Point[]>([]);
  const [ptsB, setPtsB] = useState<Point[]>([]);
  const [opts, setOpts] = useState<SampleOptions>(DEFAULT_SAMPLE_OPTIONS);
  const [view, setView] = useState<"check" | "pixels">("check");
  const [smooth, setSmooth] = useState(1);
  const [prior, setPrior] = useState<FitOptions["prior"]>("matrix");
  const [fit, setFit] = useState<{ result: FitResult; check: [ErrorStats, ErrorStats]; train: [ErrorStats, ErrorStats] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (which: "src" | "dst") => async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const p = await readPhoto(file);
      (which === "src" ? setSrc : setDst)(p);
      (which === "src" ? setPtsA : setPtsB)([]);
      setFit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadSample = async () => {
    setError(null);
    try {
      const get = async (path: string) => {
        const res = await fetch(import.meta.env.BASE_URL + path);
        if (!res.ok) throw new Error(`Could not load ${path}`);
        return readPhoto(new File([await res.blob()], path.split("/").pop()!, { type: "image/jpeg" }));
      };
      const [a, b] = await Promise.all([get(SAMPLE.source), get(SAMPLE.target)]);
      setSrc(a);
      setDst(b);
      setPtsA(SAMPLE.ptsA);
      setPtsB(SAMPLE.ptsB);
      setFit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const workA = useMemo(() => (src ? pixels(src, WORK) : null), [src]);
  const workB = useMemo(() => (dst ? pixels(dst, WORK) : null), [dst]);

  // Registration on the working-size images: points are stored in full-size pixels.
  const registered = useMemo(() => {
    if (!workA || !workB || ptsA.length < 4 || ptsB.length < 4) return null;
    try {
      const sa = workA.scale;
      const sb = workB.scale;
      const H = homography(
        ptsA.map(([x, y]) => [x * sa, y * sa]),
        ptsB.map(([x, y]) => [x * sb, y * sb]),
      );
      return { H, ...warp(workA.rgb, workA.w, workA.h, H, workB.w, workB.h) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [workA, workB, ptsA, ptsB]);

  const score = useMemo(() => {
    if (!registered || "error" in registered || !workB) return null;
    return alignmentScore(registered.rgb, registered.valid, workB.rgb, workB.w, workB.h);
  }, [registered, workB]);

  const samples = useMemo(() => {
    if (!registered || "error" in registered || !workB) return null;
    return samplePairs(registered.rgb, registered.valid, workB.rgb, workB.w, workB.h, opts);
  }, [registered, workB, opts]);

  // Changing points or sampling makes an old fit stale.
  useEffect(() => setFit(null), [samples]);

  const runFit = () => {
    if (!samples) return;
    setBusy(true);
    // Let the "Fitting" state paint before the main thread is busy (a Worker comes in v0.2).
    setTimeout(() => {
      const result = fitLut(samples.fit, { size: 33, smoothness: smooth, prior });
      setFit({
        result,
        check: [deltaEStats(samples.check), deltaEStats(samples.check, result.lut)],
        train: [deltaEStats(samples.fit), deltaEStats(samples.fit, result.lut)],
      });
      setBusy(false);
    }, 30);
  };

  const exportCube = () => {
    if (!fit || !src || !dst) return;
    const text = toCube(fit.result.lut, "measured-lut", [
      `Fitted by measured-lut from ${src.name} -> ${dst.name}`,
      "Input and output: Display P3, sRGB transfer curve (code values 0..1)",
      `Held-out CIEDE2000 median ${fit.check[0].median.toFixed(2)} -> ${fit.check[1].median.toFixed(2)}`,
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${src.name.replace(/\.[^.]+$/, "")}-to-${dst.name.replace(/\.[^.]+$/, "")}.cube`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main>
      <header>
        <h1>measured-lut</h1>
        <p>
          Fit a 3D LUT from two photos of the same scene, one from each camera. The photos stay on this computer;
          nothing is uploaded.
        </p>
      </header>

      <section>
        <h2>1. Photos</h2>
        <div className="pair">
          <PhotoInput label="Source: the camera to change" photo={src} onFile={load("src")} />
          <PhotoInput label="Target: the colours to match" photo={dst} onFile={load("dst")} />
        </div>
        <button onClick={loadSample}>Try a sample pair</button>
        {error && <p className="error">{error}</p>}
      </section>

      {src && dst && (
        <section>
          <h2>2. Align</h2>
          <p className="note">
            Click the same 4 points on both photos, spread out and on things that did not move. Drag a point to adjust it.
          </p>
          <div className="pair">
            <PointPicker label="Source" photo={src} points={ptsA} onChange={setPtsA} />
            <PointPicker label="Target" photo={dst} points={ptsB} onChange={setPtsB} />
          </div>
          <button
            onClick={() => {
              setPtsA([]);
              setPtsB([]);
            }}
          >
            Clear points
          </button>
          {registered && "error" in registered && <p className="error">{registered.error}</p>}
          {score !== null &&
            (score >= 0.6 ? (
              <p className="note">Alignment score {score.toFixed(2)} (0.6 or more is good).</p>
            ) : (
              <p className="error">
                Alignment score {Number.isNaN(score) ? "n/a" : score.toFixed(2).replace("-0.00", "0.00")}. Below 0.6, most test pairs fitted poorly. Put
                the points on sharp details that did not move, spread across the frame. If that does not help, the two
                shots were probably taken from too far apart.
              </p>
            ))}
        </section>
      )}

      {registered && !("error" in registered) && workB && samples && (
        <section>
          <h2>3. Pixels</h2>
          <div className="split">
            <div>
              <div className="tabs">
                <button aria-pressed={view === "check"} onClick={() => setView("check")}>
                  Alignment
                </button>
                <button aria-pressed={view === "pixels"} onClick={() => setView("pixels")}>
                  Pixels used
                </button>
              </div>
              <AlignView
                warped={registered.rgb}
                valid={registered.valid}
                target={workB.rgb}
                labels={samples.labels}
                w={workB.w}
                h={workB.h}
                mode={view}
              />
              <p className="note">
                {view === "check"
                  ? "Squares alternate between the warped source and the target. Edges should run straight across."
                  : "Dimmed: not used. Dotted blocks: held out to measure the error."}
              </p>
            </div>
            <div className="controls">
              <Slider label="Blur (px)" value={opts.sigma} min={0} max={6} step={0.5} onChange={(v) => setOpts({ ...opts, sigma: v })} />
              <Slider label="Keep flattest (%)" value={opts.edgePercentile} min={10} max={100} step={5} onChange={(v) => setOpts({ ...opts, edgePercentile: v })} />
              <Slider label="Highlight cut" value={opts.highlight} min={0.8} max={1} step={0.01} onChange={(v) => setOpts({ ...opts, highlight: v })} />
              <Slider label="Shadow cut (% luminance)" value={opts.shadow * 100} min={0} max={10} step={0.5} onChange={(v) => setOpts({ ...opts, shadow: v / 100 })} />
              <Slider label="Held out (%)" value={opts.holdout * 100} min={5} max={50} step={5} onChange={(v) => setOpts({ ...opts, holdout: v / 100 })} />
              <table>
                <tbody>
                  <tr><td>Fit</td><td className="num">{samples.counts.fit.toLocaleString()}</td></tr>
                  <tr><td>Held out</td><td className="num">{samples.counts.check.toLocaleString()}</td></tr>
                  <tr><td>Near edges</td><td className="num">{samples.counts.edge.toLocaleString()}</td></tr>
                  <tr><td>Clipped or dark</td><td className="num">{samples.counts.clipped.toLocaleString()}</td></tr>
                  <tr><td>Outside overlap</td><td className="num">{samples.counts.outside.toLocaleString()}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {samples && (
        <section>
          <h2>4. Fit</h2>
          <div className="row">
            <Slider label="Smoothness (log10)" value={Math.log10(smooth)} min={-2} max={2} step={0.25} onChange={(v) => setSmooth(10 ** v)} />
            <label className="slider">
              <span className="slider-head">Where there is no data</span>
              <select value={prior} onChange={(e) => setPrior(e.target.value as FitOptions["prior"])}>
                <option value="matrix">Follow a 3×3 matrix fit</option>
                <option value="identity">Leave colours unchanged</option>
              </select>
            </label>
            <button className="primary" disabled={busy || samples.fit.src.length === 0} onClick={runFit}>
              {busy ? "Fitting…" : "Fit 33³ LUT"}
            </button>
          </div>
          {fit && (
            <>
              <table className="report">
                <thead>
                  <tr><th>CIEDE2000</th><th className="num">median</th><th className="num">P95</th><th className="num">pairs</th></tr>
                </thead>
                <tbody>
                  <StatRow name="Held out, before" s={fit.check[0]} />
                  <StatRow name="Held out, after" s={fit.check[1]} strong />
                  <StatRow name="Fit pixels, before" s={fit.train[0]} />
                  <StatRow name="Fit pixels, after" s={fit.train[1]} />
                </tbody>
              </table>
              {fit.train[1].median > 3 && (
                <p className="error">
                  Even the pixels used for fitting still differ by a median of {fit.train[1].median.toFixed(1)}. The photos
                  are probably not aligned, or something in the scene moved or changed light between the shots.
                </p>
              )}
              <p className="note">
                Solved in {fit.result.ms.toFixed(0)} ms, {fit.result.iterations} iterations. Only the held-out rows say how
                well the LUT generalises; the fit rows are what it was trained on.
              </p>
            </>
          )}
        </section>
      )}

      {fit && src && (
        <section>
          <h2>5. Compare and export</h2>
          <Compare photo={src} fit={fit.result} />
          <button className="primary" onClick={exportCube}>
            Download .cube
          </button>
          <p className="note">The LUT expects Display P3 input and writes Display P3. Apply it to the source camera's photos.</p>
        </section>
      )}
    </main>
  );
}

function PhotoInput(props: { label: string; photo: Photo | null; onFile: (f: File | undefined) => void }) {
  const { label, photo, onFile } = props;
  return (
    <label
      className="drop"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFile(e.dataTransfer.files[0]);
      }}
    >
      <span>{label}</span>
      <input className="hidden-input" type="file" accept="image/jpeg" onChange={(e) => onFile(e.target.files?.[0])} />
      {!photo && <span className="note">Choose a JPEG, or drop one here.</span>}
      {photo && (
        <span className="dim">
          {photo.name} · {photo.bitmap.width}×{photo.bitmap.height} · {photo.color.space === "display-p3" ? "Display P3" : "sRGB"} (
          {photo.color.source === "icc" ? `ICC: ${photo.color.detail}` : photo.color.detail})
        </span>
      )}
    </label>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const { label, value, min, max, step, onChange } = props;
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <span className="num">{Number(value.toFixed(2))}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function StatRow({ name, s, strong }: { name: string; s: ErrorStats; strong?: boolean }) {
  return (
    <tr className={strong ? "strong" : undefined}>
      <td>{name}</td>
      <td className="num">{s.median.toFixed(2)}</td>
      <td className="num">{s.p95.toFixed(2)}</td>
      <td className="num">{s.n.toLocaleString()}</td>
    </tr>
  );
}

function Compare({ photo, fit }: { photo: Photo; fit: FitResult }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<Preview | null>(null);
  const [split, setSplit] = useState(0.5);

  useEffect(() => {
    const c = canvas.current!;
    const { width, height } = photo.bitmap;
    const scale = Math.min(1, 2048 / Math.max(width, height));
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
    preview.current ??= new Preview(c);
    preview.current.setPhoto(photo.bitmap, photo.color.space ?? "srgb");
  }, [photo]);

  useEffect(() => {
    const p = preview.current!;
    p.setLut(fit.lut);
    p.split = split;
    p.draw();
  }, [fit, split]);

  return (
    <div className="compare">
      <canvas ref={canvas} className="full" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label="Before / after split"
      />
      <div className="row dim">
        <span>Before</span>
        <span>After</span>
      </div>
    </div>
  );
}
