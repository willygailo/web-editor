export interface StickerItem {
  id: string;
  label: string;
  svg: string;
}

export const STICKER_CATALOG: StickerItem[] = [
  {
    id: "fire",
    label: "Hot / Fire",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M67 10c4 22-14 34-14 52 0 11 8 20 19 20 12 0 21-10 21-24 0-11-5-21-10-28 18 11 31 30 31 53 0 24-20 39-48 39-27 0-48-18-48-44 0-28 21-51 49-68Z" fill="#ff5722"/><path d="M64 46c3 11-7 19-7 29 0 8 6 14 14 14 9 0 14-7 14-16 0-8-4-15-9-20 10 8 17 20 17 34 0 17-14 29-31 29-18 0-31-13-31-31 0-18 14-31 33-39Z" fill="#ffca28"/></svg>`,
  },
  {
    id: "sparkles",
    label: "Sparkles",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 10l11 36 36 11-36 11-11 36-11-36-36-11 36-11z" fill="#22d3ee"/><path d="M102 18l5 15 15 5-15 5-5 15-5-15-15-5 15-5z" fill="#fde047"/><path d="M26 78l4 12 12 4-12 4-4 12-4-12-12-4 12-4z" fill="#fb7185"/></svg>`,
  },
  {
    id: "heart",
    label: "Heart",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 112S16 82 16 46c0-17 13-30 29-30 10 0 19 5 19 14 0-9 9-14 19-14 16 0 29 13 29 30 0 36-48 66-48 66z" fill="#f43f5e"/><path d="M36 34c-6 4-9 10-9 17" stroke="#ffe4e6" stroke-width="6" stroke-linecap="round" fill="none"/></svg>`,
  },
  {
    id: "arrow-down",
    label: "Look Here",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M52 16h24v52h22L64 112 30 68h22z" fill="#fde047" stroke="#090b10" stroke-width="6" stroke-linejoin="round"/></svg>`,
  },
  {
    id: "rec-badge",
    label: "REC Cam",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 72"><rect x="4" y="4" width="184" height="64" rx="18" fill="#0f172a" fill-opacity="0.86" stroke="#f43f5e" stroke-width="5"/><circle cx="38" cy="36" r="14" fill="#f43f5e"/><text x="66" y="46" font-family="DejaVu Sans,sans-serif" font-size="32" font-weight="800" fill="#ffffff">REC</text></svg>`,
  },
  {
    id: "star-burst",
    label: "VIP Star",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><polygon points="64,8 79,43 118,47 88,73 97,111 64,91 31,111 40,73 10,47 49,43" fill="#facc15" stroke="#0f172a" stroke-width="5" stroke-linejoin="round"/></svg>`,
  },
];

export function getStickerById(id: string): StickerItem {
  return STICKER_CATALOG.find((s) => s.id === id) ?? STICKER_CATALOG[0];
}
