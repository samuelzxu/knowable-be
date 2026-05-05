interface BrandLogoProps {
  subtitle?: string;
}

// Mirrors the macOS app's LaunchView (KnowableApp.swift) so this site and
// the desktop app feel like one product:
//   - filled star, accent orange (#E8704A) → text-knowable-orange
//   - "Knowable" bold serif wordmark in textPrimary
//   - optional muted subtitle
// `font-serif` falls back to the system serif (New York on Apple stacks,
// Georgia/Times elsewhere), matching the macOS app's `.system(..., design: .serif)`.
export function BrandLogo({ subtitle = "Educator dashboard" }: BrandLogoProps) {
  return (
    <div className="flex flex-col items-center gap-2.5 mb-8">
      <svg
        className="w-8 h-8 text-knowable-orange"
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2 L14.25 8.91 L21.51 8.91 L15.63 13.18 L17.88 20.09 L12 15.82 L6.12 20.09 L8.37 13.18 L2.49 8.91 L9.75 8.91 Z" />
      </svg>
      <h1 className="font-serif font-bold text-[34px] leading-none text-knowable-primary dark:text-cream-100 tracking-tight">
        Knowable
      </h1>
      {subtitle && (
        <p className="text-[15px] text-knowable-muted dark:text-cream-300/70">{subtitle}</p>
      )}
    </div>
  );
}
