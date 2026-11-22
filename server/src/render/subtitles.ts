import {
  getAspectDimensions,
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

function alignmentForPosition(pos: OverlayPosition): number {
  switch (pos) {
    case "top":
      return 8;
    case "center":
      return 5;
    case "bottom":
      return 2;
  }
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
  const marginV = Math.round(height * 0.12);

  const positions: OverlayPosition[] = ["top", "center", "bottom"];
  const styles: string[] = [];

  for (const pos of positions) {
    const align = alignmentForPosition(pos);
    const vMargin = pos === "center" ? 20 : marginV;

    // ASS colors are &HAABBGGRR
    styles.push(
      `Style: ${styleNameFor("bold-hook", pos)},DejaVu Sans,${fontSizeHook},&H00FFFFFF,&H000000FF,&H00120A1E,&H80000000,-1,0,0,0,100,100,2,0,1,4,2,${align},60,60,${vMargin},1`
    );
    styles.push(
      `Style: ${styleNameFor("capcut-pop", pos)},DejaVu Sans,${fontSizePop},&H00141414,&H000000FF,&H003CE6FF,&H003CE6FF,-1,0,0,0,100,100,1,0,3,10,0,${align},60,60,${vMargin},1`
    );
    styles.push(
      `Style: ${styleNameFor("minimal-caption", pos)},DejaVu Sans,${fontSizeCaption},&H00F8FAFC,&H000000FF,&H60000000,&H60000000,0,0,0,0,100,100,1,0,1,2,1,${align},70,70,${vMargin},1`
    );
    styles.push(
      `Style: ${styleNameFor("neon-badge", pos)},DejaVu Sans,${fontSizePop},&H00FFFF22,&H000000FF,&H004D12FF,&H80000000,-1,0,0,0,100,100,2,0,3,8,0,${align},60,60,${vMargin},1`
    );
  }

  const events = overlays.map((o) => {
    const styleName = styleNameFor(o.style, o.position);
    const anim = o.style === "capcut-pop" || o.style === "bold-hook" ? "{\\fad(120,120)}" : "{\\fad(180,180)}";
    return `Dialogue: 0,${formatAssTime(o.startSec)},${formatAssTime(o.endSec)},${styleName},,0,0,0,,${anim}${escapeAssText(o.text)}`;
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
