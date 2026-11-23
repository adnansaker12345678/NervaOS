export function AuraMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
    {[0, 90, 180, 270].map((angle) => <path key={angle} d="M20 20C9 23 0 15 3 8C6 1 16 3 20 20Z" fill="currentColor" transform={`rotate(${angle} 20 20)`} />)}
  </svg>;
}

export function OrbitArt() {
  return <svg className="orbit-art" width="190" height="87" viewBox="0 0 190 87" fill="none" aria-hidden="true">
    <path d="M-7 81C23 9 113-12 160 15C205 41 142 92 75 69C11 47 60-6 116 8" stroke="currentColor" strokeWidth=".8" opacity=".35" />
    <path d="M-7 73C23 1 113-20 160 7C205 33 142 84 75 61C11 39 60-14 116 0" stroke="currentColor" strokeWidth=".8" opacity=".25" />
    <path d="M-7 89C23 17 113-4 160 23C205 49 142 100 75 77C11 55 60 2 116 16" stroke="currentColor" strokeWidth=".8" opacity=".4" />
    <path d="M-7 97C23 25 113 4 160 31C205 57 142 108 75 85C11 63 60 10 116 24" stroke="currentColor" strokeWidth=".8" opacity=".22" />
    <path d="M139 27L141.2 33.8L148 36L141.2 38.2L139 45L136.8 38.2L130 36L136.8 33.8L139 27Z" fill="currentColor" />
    <circle cx="51" cy="34" r="3.5" fill="#EDF1E9" stroke="currentColor" strokeWidth="1" />
  </svg>;
}
