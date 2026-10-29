import { ImageResponse } from 'next/og'

export const size = {
  width: 180,
  height: 180,
}

export const contentType = 'image/png'

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#020617"/><stop offset="1" stop-color="#0b1f4d"/></linearGradient>
  <linearGradient id="pb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#8bdcff"/><stop offset="1" stop-color="#1677ff"/></linearGradient>
</defs>
<circle cx="32" cy="32" r="30" fill="url(#bg)" stroke="#22d3ee" stroke-width="2"/>
<path d="M18 18h18c7 0 11 4 11 9s-4 9-11 9h-9v10h-9V18Zm9 7v4h8c2.5 0 4-1 4-2s-1.5-2-4-2h-8Z" fill="url(#pb)"/>
<path d="M18 47c10-1 20-6 27-15-3 7-8 13-15 17-4 2-8 2-12-2Z" fill="#12d8ff"/>
<path d="M44 15l1.2 3.1L48 19l-2.8.9L44 23l-1.2-3.1L40 19l2.8-.9L44 15Z" fill="#22d3ee"/>
</svg>`

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#020617',
      }}
    >
      <img
        src={`data:image/svg+xml,${encodeURIComponent(logoSvg)}`}
        width="180"
        height="180"
      />
    </div>,
    size,
  )
}
