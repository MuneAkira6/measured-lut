// Two diagnostic views on the working-size images, both drawn in Display P3:
// - "check": a checkerboard of warped source and target. Misalignment shows as
//   breaks in lines that cross square borders.
// - "pixels": which pixels feed the fit, which are held out, which were dropped.

import { useEffect, useRef } from "react";
import { Label } from "./samples";

export function AlignView(props: {
  warped: Float32Array;
  valid: Uint8Array;
  target: Float32Array;
  labels: Uint8Array | null;
  w: number;
  h: number;
  mode: "check" | "pixels";
}) {
  const { warped, valid, target, labels, w, h, mode } = props;
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current!;
    c.width = w;
    c.height = h;
    const img = new ImageData(w, h, { colorSpace: "display-p3" });
    const d = img.data;
    const square = Math.max(16, Math.round(w / 12));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let src = target;
        let k = 1;
        if (mode === "check") {
          if (((Math.floor(x / square) + Math.floor(y / square)) & 1) === 1 && valid[i]) src = warped;
        } else if (labels) {
          const l = labels[i];
          // Dropped pixels are shown at a fifth of their brightness; held-out blocks get a dotted edge.
          if (l !== Label.Fit && l !== Label.Check) k = 0.2;
          if (l === Label.Check && (x % 32 === 0 || y % 32 === 0) && (x + y) % 2 === 0) k = 0;
        }
        d[i * 4] = src[i * 3] * k * 255;
        d[i * 4 + 1] = src[i * 3 + 1] * k * 255;
        d[i * 4 + 2] = src[i * 3 + 2] * k * 255;
        d[i * 4 + 3] = 255;
      }
    }
    c.getContext("2d", { colorSpace: "display-p3" })!.putImageData(img, 0, 0);
  }, [warped, valid, target, labels, w, h, mode]);

  return <canvas ref={canvas} className="full" />;
}
