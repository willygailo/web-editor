import { useState } from "react";
import { Check, Copy, Sparkles } from "lucide-react";

interface SocialCaptionCardProps {
  socialCaption?: string;
  hashtags?: string[];
}

export function SocialCaptionCard({ socialCaption, hashtags }: SocialCaptionCardProps) {
  const [copied, setCopied] = useState(false);

  const normalizedTags = (hashtags ?? []).map((t) => (t.startsWith("#") ? t : `#${t}`));
  const combinedText = [socialCaption?.trim(), normalizedTags.join(" ")].filter(Boolean).join("\n\n");

  if (!combinedText) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(combinedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-HTTPS contexts
    }
  };

  return (
    <div className="rounded-lg border border-indigo-500/25 bg-indigo-950/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-300">
          <Sparkles className="w-3.5 h-3.5" />
          Ready-to-Post Caption &amp; Hashtags
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-500/20 hover:bg-indigo-500/35 text-indigo-200 text-[11px] font-medium transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy Caption
            </>
          )}
        </button>
      </div>
      {socialCaption?.trim() ? (
        <p className="text-xs text-zinc-200 whitespace-pre-line leading-relaxed">{socialCaption.trim()}</p>
      ) : null}
      {normalizedTags.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {normalizedTags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[10px] font-medium"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
