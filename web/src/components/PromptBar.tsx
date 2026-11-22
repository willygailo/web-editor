import { Sparkles, Wand2 } from "lucide-react";

const QUICK_PROMPTS = [
  { label: "🔥 Hype 15s TikTok", prompt: "Gawa ka ng hype 15s TikTok edit with smooth zoom" },
  { label: "🌴 Chill Vlog 20s", prompt: "Chill aesthetic travel vlog 20s with crossfade" },
  { label: "⚡ Beat Flash 12s", prompt: "Fast beat flash montage 12s synced to music" },
  { label: "🎬 16:9 Cinematic", prompt: "Cinematic 16:9 film story with warm color" },
  { label: "🛍️ Product 1:1 Ad", prompt: "Punchy 1:1 product promo ad \"MUST HAVE\"" },
];

export type AiMode = "auto" | "claude" | "gemini" | "offline";

interface PromptBarProps {
  prompt: string;
  onPromptChange: (val: string) => void;
  onSubmit: (overridePrompt?: string) => void;
  isGenerating: boolean;
  disabled: boolean;
  mode: AiMode;
  onModeChange: (mode: AiMode) => void;
  hasProject: boolean;
}

export function PromptBar({
  prompt,
  onPromptChange,
  onSubmit,
  isGenerating,
  disabled,
  mode,
  onModeChange,
  hasProject,
}: PromptBarProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-2 rounded-2xl border border-slate-800/80 bg-[#111520] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-cyan-300 uppercase">
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span>AI Auto-Cut Director</span>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-full bg-[#090b10] p-0.5 text-[11px]">
          {(
            [
              { id: "auto", label: "Auto", active: "bg-cyan-500/20 text-cyan-300" },
              { id: "claude", label: "Claude 5.5", active: "bg-orange-500/20 text-orange-300" },
              { id: "gemini", label: "Gemini", active: "bg-blue-500/20 text-blue-300" },
              { id: "offline", label: "Offline", active: "bg-amber-500/20 text-amber-300" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onModeChange(item.id)}
              className={`rounded-full px-2 py-1 font-medium transition ${
                mode === item.id ? item.active : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder='e.g. "Gawa ka ng hype 15s TikTok edit with smooth zoom"'
          aria-label="AI edit prompt"
          className="min-w-0 flex-1 rounded-xl border border-slate-700/80 bg-[#090b10] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={disabled || isGenerating || !prompt.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-3.5 py-2 text-sm font-bold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Wand2 className="size-4" aria-hidden="true" />
          <span>{isGenerating ? "Editing..." : hasProject ? "Remix" : "Auto Edit"}</span>
        </button>
      </div>

      <div className="studio-tablist pb-0.5" aria-label="Quick edit prompt suggestions">
        {QUICK_PROMPTS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => {
              onPromptChange(chip.prompt);
              if (!disabled && !isGenerating) {
                onSubmit(chip.prompt);
              }
            }}
            className="shrink-0 rounded-full border border-slate-700/70 bg-[#181e2d] px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:border-cyan-400/70 hover:text-cyan-200"
          >
            {chip.label}
          </button>
        ))}
      </div>
    </form>
  );
}
