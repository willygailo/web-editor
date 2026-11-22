import {
  getAspectDimensions,
  getOverlayNormalizedPos,
  type AspectRatio,
  type OverlayPosition,
  type OverlayStyle,
  type TextOverlay,
} from "@cutflow/shared";

function formatAssTime(sec: number): string {
  const safe = Math.max(0, sec);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function hexToAssBgr(color?: string): string | null {
  if (!color) return null;
  const trimmed = color.trim();

  if (trimmed.startsWith("#")) {
    const clean = trimmed.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
      const r = clean[0] + clean[0];
      const g = clean[1] + clean[1];
      const b = clean[2] + clean[2];
      return `&H00${b}${g}${r}`.toUpperCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
      const rr = clean.slice(0, 2);
      const gg = clean.slice(2, 4);
      const bb = clean.slice(4, 6);
      return `&H00${bb}${gg}${rr}`.toUpperCase();
    }
    if (/^[0-9a-fA-F]{8}$/.test(clean)) {
      const rr = clean.slice(0, 2);
      const gg = clean.slice(2, 4);
      const bb = clean.slice(4, 6);
      const alpha = Math.max(0, Math.min(255, 255 - parseInt(clean.slice(6, 8), 16)));
      const aa = alpha.toString(16).padStart(2, "0");
      return `&H${aa}${bb}${gg}${rr}`.toUpperCase();
    }
    return null;
  }

  const rgbaMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([01](?:\.\d+)?|\.\d+))?\s*\)$/i.exec(
      trimmed
    );
  if (rgbaMatch) {
    const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    const rr = clamp255(Number(rgbaMatch[1]));
    const gg = clamp255(Number(rgbaMatch[2]));
    const bb = clamp255(Number(rgbaMatch[3]));
    const alphaFloat = rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, Number(rgbaMatch[4]))) : 1;
    const aa = clamp255((1 - alphaFloat) * 255);
    return `&H${aa}${bb}${gg}${rr}`.toUpperCase();
  }

  return null;
}

function styleNameFor(style: OverlayStyle, pos: OverlayPosition): string {
  return `${style}-${pos}`;
}

export function generateAssSubtitles(
  overlays: TextOverlay[],
  aspectRatio: AspectRatio,
  quality: "720p" | "1080p" = "1080p"
): string {
  const { width, height } = getAspectDimensions(aspectRatio, quality);
  const scale = width / 1080;
  const fontSizeHook = Math.round(64 * scale);
  const fontSizePop = Math.round(54 * scale);
  const fontSizeCaption = Math.round(44 * scale);

  const positions: OverlayPosition[] = ["top", "center", "bottom"];
  const styles: string[] = [];

  for (const pos of positions) {
    // Use alignment 5 (center anchor) so \pos(x,y) places centers consistently with Canvas
    styles.push(
      `Style: ${styleNameFor("bold-hook", pos)},DejaVu Sans,${fontSizeHook},&H00FFFFFF,&H000000FF,&H00120A1E,&H80000000,-1,0,0,0,100,100,2,0,1,4,2,5,60,60,20,1`
    );
    styles.push(
      `Style: ${styleNameFor("capcut-pop", pos)},DejaVu Sans,${fontSizePop},&H00141414,&H000000FF,&H003CE6FF,&H003CE6FF,-1,0,0,0,100,100,1,0,3,10,0,5,60,60,20,1`
    );
    styles.push(
      `Style: ${styleNameFor("minimal-caption", pos)},DejaVu Sans,${fontSizeCaption},&H00F8FAFC,&H000000FF,&H60000000,&H60000000,0,0,0,0,100,100,1,0,1,2,1,5,70,70,20,1`
    );
    styles.push(
      `Style: ${styleNameFor("neon-badge", pos)},DejaVu Sans,${fontSizePop},&H00FFFF22,&H000000FF,&H004D12FF,&H80000000,-1,0,0,0,100,100,2,0,3,8,0,5,60,60,20,1`
    );
  }

  const events = overlays.map((o) => {
    const styleName = styleNameFor(o.style, o.position);
    const { xNorm, yNorm } = getOverlayNormalizedPos(o);
    const px = Math.round(xNorm * width);
    const py = Math.round(yNorm * height);
    const baseScale = Math.round((o.scale ?? 1) * 100);
    const rot = Number((-(o.rotationDeg ?? 0)).toFixed(1));

    const tags: string[] = [`\\an5`];
    if (o.animation === "slide-up") {
      const startY = Math.min(height - 10, py + Math.round(height * 0.04));
      tags.push(`\\move(${px},${startY},${px},${py},0,220)`);
      tags.push(`\\fad(140,120)`);
      tags.push(`\\fscx${baseScale}\\fscy${baseScale}`);
    } else if (o.animation === "pop") {
      const s0 = Math.max(20, Math.round(baseScale * 0.72));
      const s1 = Math.round(baseScale * 1.07);
      tags.push(`\\pos(${px},${py})`);
      tags.push(`\\fscx${s0}\\fscy${s0}`);
      tags.push(`\\t(0,130,\\fscx${s1}\\fscy${s1})`);
      tags.push(`\\t(130,220,\\fscx${baseScale}\\fscy${baseScale})`);
      tags.push(`\\fad(80,100)`);
    } else if (o.animation === "fade") {
      tags.push(`\\pos(${px},${py})\\fscx${baseScale}\\fscy${baseScale}\\fad(220,220)`);
    } else {
      tags.push(`\\pos(${px},${py})\\fscx${baseScale}\\fscy${baseScale}`);
    }

    if (Math.abs(rot) > 0.2) {
      tags.push(`\\frz${rot}`);
    }

    const primaryColor = hexToAssBgr(o.color);
    if (primaryColor) tags.push(`\\1c${primaryColor}&`);
    const bgColor = hexToAssBgr(o.bgColor);
    if (bgColor) tags.push(`\\3c${bgColor}&\\4c${bgColor}&`);

    return `Dialogue: 0,${formatAssTime(o.startSec)},${formatAssTime(o.endSec)},${styleName},,0,0,0,,{${tags.join("")}}${escapeAssText(o.text)}`;
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 1",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
