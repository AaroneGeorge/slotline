/** Slotline mark: a day line with one slot lifted out of it. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="#1d3557" />
      <path d="M4 15.5h4.2M15.8 15.5H20" stroke="#9fb4d3" strokeWidth="2" strokeLinecap="round" />
      <rect x="9.2" y="7" width="5.6" height="6" rx="1.6" fill="#3ccf84" />
      <path d="M9.2 15.5h5.6" stroke="#9fb4d3" strokeWidth="2" strokeDasharray="1.4 1.6" strokeLinecap="round" />
    </svg>
  );
}
