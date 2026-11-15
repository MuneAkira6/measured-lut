// Click matching points on the two photos. Points are paired by order: point 1 on
// the source goes with point 1 on the target. Drag a point to move it.

import { useEffect, useRef } from "react";
import type { Point } from "./geometry";
import type { Photo } from "./decode";

const HIT = 12; // px on screen

export function PointPicker(props: {
  photo: Photo;
  points: Point[];
  onChange: (pts: Point[]) => void;
  label: string;
}) {
  const { photo, points, onChange, label } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number | null>(null);
  const { width, height } = photo.bitmap;

  useEffect(() => {
    const c = canvas.current!;
    const cssW = c.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(((cssW * height) / width) * dpr);
    const ctx = c.getContext("2d", { colorSpace: "display-p3" })!;
    ctx.drawImage(photo.bitmap, 0, 0, c.width, c.height);
    const k = c.width / width;
    const style = getComputedStyle(c);
    const ink = style.getPropertyValue("--marker").trim() || "#fff";
    const halo = style.getPropertyValue("--marker-halo").trim() || "#000";
    ctx.font = `${12 * dpr}px ${style.fontFamily}`;
    points.forEach(([x, y], i) => {
      const px = x * k;
      const py = y * k;
      for (const [color, lw] of [
        [halo, 3],
        [ink, 1],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw * dpr;
        ctx.beginPath();
        ctx.moveTo(px - 8 * dpr, py);
        ctx.lineTo(px - 3 * dpr, py);
        ctx.moveTo(px + 3 * dpr, py);
        ctx.lineTo(px + 8 * dpr, py);
        ctx.moveTo(px, py - 8 * dpr);
        ctx.lineTo(px, py - 3 * dpr);
        ctx.moveTo(px, py + 3 * dpr);
        ctx.lineTo(px, py + 8 * dpr);
        ctx.stroke();
      }
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = halo;
      ctx.strokeText(String(i + 1), px + 6 * dpr, py - 6 * dpr);
      ctx.fillStyle = ink;
      ctx.fillText(String(i + 1), px + 6 * dpr, py - 6 * dpr);
    });
  }, [photo, points, width, height]);

  const toImage = (e: React.PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
  };
  const hit = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const k = r.width / width;
    const [x, y] = toImage(e);
    return points.findIndex(([px, py]) => Math.hypot((px - x) * k, (py - y) * k) < HIT);
  };

  return (
    <figure className="picker">
      <figcaption>
        {label} <span className="dim">{points.length}/4 points</span>
      </figcaption>
      <canvas
        ref={canvas}
        onPointerDown={(e) => {
          const i = hit(e);
          if (i >= 0) {
            drag.current = i;
            (e.target as Element).setPointerCapture(e.pointerId);
          } else if (points.length < 4) {
            onChange([...points, toImage(e)]);
          }
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const next = points.slice();
          next[drag.current] = toImage(e);
          onChange(next);
        }}
        onPointerUp={() => (drag.current = null)}
      />
    </figure>
  );
}
