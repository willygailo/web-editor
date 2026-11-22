import type {
  AspectRatio,
  FilterPreset,
  MotionPreset,
  OverlayStyle,
  TransitionType,
} from "./edl.js";

export interface CutTemplatePreset {
  id: string;
  name: string;
  tagline: string;
  badge: string;
  defaultAspectRatio: AspectRatio;
  defaultDurationSec: number;
  bpm: number;
  minClipSec: number;
  maxClipSec: number;
  motions: MotionPreset[];
  transitions: TransitionType[];
  transitionDurationSec: number;
  filter: FilterPreset;
  overlayStyle: OverlayStyle;
  defaultHookText: string;
  keywords: string[];
  accentColor: string;
}

export const CUT_TEMPLATE_PRESETS: CutTemplatePreset[] = [
  {
    id: "hype-zoom",
    name: "Hype Beat Zoom",
    tagline: "Fast TikTok/Reels cuts with punch zoom & flash transitions",
    badge: "Viral Reels",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 15,
    bpm: 128,
    minClipSec: 0.9,
    maxClipSec: 1.7,
    motions: ["punch-zoom", "zoom-in", "zoom-out", "punch-zoom"],
    transitions: ["zoom-blur", "flash-white", "slide-left"],
    transitionDurationSec: 0.22,
    filter: "vivid",
    overlayStyle: "bold-hook",
    defaultHookText: "WAIT FOR THE DROP",
    keywords: ["hype", "tiktok", "reels", "mabilis", "fast", "zoom", "drop", "party", "dance", "edit"],
    accentColor: "#ff4d6d",
  },
  {
    id: "chill-vlog",
    name: "Chill Travel Vlog",
    tagline: "Warm film tones, smooth pans, and laid-back pacing",
    badge: "Aesthetic",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 20,
    bpm: 92,
    minClipSec: 2.0,
    maxClipSec: 3.4,
    motions: ["zoom-in", "pan-right", "zoom-out", "pan-left"],
    transitions: ["crossfade"],
    transitionDurationSec: 0.4,
    filter: "warm-film",
    overlayStyle: "minimal-caption",
    defaultHookText: "weekend escape",
    keywords: ["chill", "vlog", "travel", "beach", "aesthetic", "relax", "smooth", "warm", "day in my life"],
    accentColor: "#f59e0b",
  },
  {
    id: "beat-flash",
    name: "Beat Flash Sync",
    tagline: "Ultra-snappy montage locked to rhythmic beat drops",
    badge: "135 BPM",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 12,
    bpm: 135,
    minClipSec: 0.65,
    maxClipSec: 1.15,
    motions: ["punch-zoom", "zoom-in"],
    transitions: ["flash-white", "cut", "flash-white"],
    transitionDurationSec: 0.16,
    filter: "vivid",
    overlayStyle: "neon-badge",
    defaultHookText: "ON THE BEAT",
    keywords: ["beat", "flash", "montage", "sync", "gym", "gaming", "highlights", "action", "astig"],
    accentColor: "#22d3ee",
  },
  {
    id: "cinematic-story",
    name: "Cinematic Story",
    tagline: "Widescreen moody color grade with gentle crossfades",
    badge: "16:9 Film",
    defaultAspectRatio: "16:9",
    defaultDurationSec: 24,
    bpm: 80,
    minClipSec: 2.4,
    maxClipSec: 4.2,
    motions: ["zoom-out", "pan-left", "zoom-in", "pan-right"],
    transitions: ["crossfade"],
    transitionDurationSec: 0.5,
    filter: "cinematic",
    overlayStyle: "minimal-caption",
    defaultHookText: "CHAPTER ONE",
    keywords: ["cinematic", "movie", "film", "story", "landscape", "youtube", "moody", "dramatic"],
    accentColor: "#a78bfa",
  },
  {
    id: "product-showcase",
    name: "Smart Product Ad",
    tagline: "Punchy e-commerce showcase with slide transitions & CTA hook",
    badge: "Promo / Ad",
    defaultAspectRatio: "1:1",
    defaultDurationSec: 15,
    bpm: 118,
    minClipSec: 1.2,
    maxClipSec: 2.2,
    motions: ["zoom-in", "punch-zoom", "pan-right"],
    transitions: ["slide-left", "zoom-blur"],
    transitionDurationSec: 0.24,
    filter: "vivid",
    overlayStyle: "capcut-pop",
    defaultHookText: "MUST HAVE THIS",
    keywords: ["product", "ad", "promo", "shop", "sale", "food", "review", "unboxing", "square"],
    accentColor: "#10b981",
  },
];

export function getTemplatePresetById(id?: string): CutTemplatePreset {
  return (
    CUT_TEMPLATE_PRESETS.find((preset) => preset.id === id) ??
    CUT_TEMPLATE_PRESETS[0]
  );
}
