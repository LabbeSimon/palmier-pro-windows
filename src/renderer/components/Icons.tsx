/**
 * Icon set. Drawn on a 16×16 grid, solid fills, one visual weight — so the
 * toolbar reads as one system rather than as assorted glyphs.
 */

type IconProps = { className?: string }

const svg = (path: React.ReactNode) =>
  function Icon({ className }: IconProps) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
        {path}
      </svg>
    )
  }

export const IconPlay = svg(<path d="M4.5 2.8v10.4a.6.6 0 0 0 .92.5l8.2-5.2a.6.6 0 0 0 0-1L5.42 2.3a.6.6 0 0 0-.92.5Z" />)

export const IconPause = svg(
  <>
    <rect x="4" y="2.6" width="3" height="10.8" rx=".7" />
    <rect x="9" y="2.6" width="3" height="10.8" rx=".7" />
  </>,
)

export const IconStart = svg(
  <>
    <rect x="3" y="2.6" width="2" height="10.8" rx=".7" />
    <path d="M13.1 2.9v10.2a.6.6 0 0 1-.93.5L6.2 8.5a.6.6 0 0 1 0-1l5.97-5.1a.6.6 0 0 1 .93.5Z" />
  </>,
)

export const IconEnd = svg(
  <>
    <rect x="11" y="2.6" width="2" height="10.8" rx=".7" />
    <path d="M2.9 2.9v10.2a.6.6 0 0 0 .93.5L9.8 8.5a.6.6 0 0 0 0-1L3.83 2.4a.6.6 0 0 0-.93.5Z" />
  </>,
)

export const IconPrevFrame = svg(
  <>
    <rect x="3.4" y="3" width="1.8" height="10" rx=".6" />
    <path d="M12.6 3.4v9.2a.6.6 0 0 1-.93.5L6.9 8.5a.6.6 0 0 1 0-1l4.77-4.6a.6.6 0 0 1 .93.5Z" />
  </>,
)

export const IconNextFrame = svg(
  <>
    <rect x="10.8" y="3" width="1.8" height="10" rx=".6" />
    <path d="M3.4 3.4v9.2a.6.6 0 0 0 .93.5L9.1 8.5a.6.6 0 0 0 0-1L4.33 2.9a.6.6 0 0 0-.93.5Z" />
  </>,
)

export const IconSplit = svg(
  <>
    <rect x="7.2" y="1.5" width="1.6" height="13" rx=".6" />
    <path d="M2 3.2h3.4v9.6H2zM10.6 3.2H14v9.6h-3.4z" opacity=".55" />
  </>,
)

export const IconEye = svg(
  <path d="M8 3.2c-3.1 0-5.7 2-7 4.8 1.3 2.8 3.9 4.8 7 4.8s5.7-2 7-4.8c-1.3-2.8-3.9-4.8-7-4.8Zm0 8a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Zm0-1.7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />,
)

export const IconEyeOff = svg(
  <>
    <path d="M8 3.2c-3.1 0-5.7 2-7 4.8a11 11 0 0 0 2.6 3.2l1.3-1.3A8.6 8.6 0 0 1 3 8c1.2-2 3-3.1 5-3.1.7 0 1.3.1 2 .4l1.3-1.4A7.7 7.7 0 0 0 8 3.2Zm4.4 1.6-1.3 1.3c.7.6 1.3 1.3 1.9 1.9-1.2 2-3 3.1-5 3.1-.7 0-1.3-.1-2-.4L4.7 12a7.7 7.7 0 0 0 3.3.8c3.1 0 5.7-2 7-4.8a11 11 0 0 0-2.6-3.2Z" />
    <rect x="1.4" y="13.2" width="15" height="1.7" rx=".8" transform="rotate(-45 1.4 13.2)" />
  </>,
)

export const IconVolume = svg(
  <>
    <path d="M7.6 2.6 4.4 5.3H2.2a.7.7 0 0 0-.7.7v4a.7.7 0 0 0 .7.7h2.2l3.2 2.7a.6.6 0 0 0 1-.5V3.1a.6.6 0 0 0-1-.5Z" />
    <path d="M10.4 5.6a.8.8 0 0 0-.1 1.2 1.8 1.8 0 0 1 0 2.4.8.8 0 1 0 1.1 1.1 3.4 3.4 0 0 0 0-4.6.8.8 0 0 0-1 0Z" />
  </>,
)

export const IconMute = svg(
  <>
    <path d="M7.6 2.6 4.4 5.3H2.2a.7.7 0 0 0-.7.7v4a.7.7 0 0 0 .7.7h2.2l3.2 2.7a.6.6 0 0 0 1-.5V3.1a.6.6 0 0 0-1-.5Z" />
    <path d="M14.3 6.2a.7.7 0 0 0-1 0L12 7.5l-1.3-1.3a.7.7 0 1 0-1 1L11 8.5l-1.3 1.3a.7.7 0 1 0 1 1L12 9.5l1.3 1.3a.7.7 0 1 0 1-1L13 8.5l1.3-1.3a.7.7 0 0 0 0-1Z" />
  </>,
)

export const IconZoomIn = svg(
  <>
    <rect x="7.2" y="3.4" width="1.6" height="9.2" rx=".7" />
    <rect x="3.4" y="7.2" width="9.2" height="1.6" rx=".7" />
  </>,
)

export const IconZoomOut = svg(<rect x="3.4" y="7.2" width="9.2" height="1.6" rx=".7" />)

export const IconTrash = svg(
  <path d="M6.2 1.6a.7.7 0 0 0-.7.7v.6H2.8a.7.7 0 1 0 0 1.4h10.4a.7.7 0 1 0 0-1.4h-2.7v-.6a.7.7 0 0 0-.7-.7Zm-2.3 4 .6 7.7a1.2 1.2 0 0 0 1.2 1.1h5a1.2 1.2 0 0 0 1.2-1.1l.6-7.7Z" />,
)

export const IconText = svg(
  <path d="M2.6 2.4a.8.8 0 0 0-.8.8v1.6a.8.8 0 0 0 1.6 0V4h3.8v8H6a.8.8 0 0 0 0 1.6h4a.8.8 0 0 0 0-1.6H8.8V4h3.8v.8a.8.8 0 0 0 1.6 0V3.2a.8.8 0 0 0-.8-.8Z" />,
)

export const IconImport = svg(
  <>
    <path d="M8 1.8a.8.8 0 0 0-.8.8v5.3L5.5 6.2a.8.8 0 1 0-1.1 1.1l3 3a.8.8 0 0 0 1.16 0l3-3a.8.8 0 0 0-1.12-1.1L8.8 7.9V2.6a.8.8 0 0 0-.8-.8Z" />
    <path d="M2.6 9.6a.8.8 0 0 1 .8.8v2.2h9.2v-2.2a.8.8 0 1 1 1.6 0v2.6a1.2 1.2 0 0 1-1.2 1.2H3.0a1.2 1.2 0 0 1-1.2-1.2v-2.6a.8.8 0 0 1 .8-.8Z" />
  </>,
)

export const IconUndo = svg(
  <path d="M4.3 5.6h4.3a4.4 4.4 0 0 1 0 8.8H6a.8.8 0 0 1 0-1.6h2.6a2.8 2.8 0 0 0 0-5.6H4.3l1.6 1.6A.8.8 0 0 1 4.8 10L1.9 7.1a.8.8 0 0 1 0-1.1l2.9-2.9a.8.8 0 0 1 1.1 1.1Z" />,
)

export const IconRedo = svg(
  <path d="M11.7 5.6H7.4a4.4 4.4 0 0 0 0 8.8H10a.8.8 0 0 0 0-1.6H7.4a2.8 2.8 0 0 1 0-5.6h4.3l-1.6 1.6a.8.8 0 0 0 1.1 1.2l2.9-2.9a.8.8 0 0 0 0-1.1l-2.9-2.9a.8.8 0 0 0-1.1 1.1Z" />,
)

export const IconRipple = svg(
  <>
    <path d="M2 4.2h4.2v7.6H2z" opacity=".5" />
    <path d="M13.9 4.2v7.6a.5.5 0 0 1-.78.42L8.4 8.42a.5.5 0 0 1 0-.84l4.72-3.8a.5.5 0 0 1 .78.42Z" />
  </>,
)

export const IconLock = svg(
  <>
    <path d="M8 1.4a3.6 3.6 0 0 0-3.6 3.6v1.6h1.8V5a1.8 1.8 0 1 1 3.6 0v1.6h1.8V5A3.6 3.6 0 0 0 8 1.4Z" />
    <rect x="3.2" y="6.6" width="9.6" height="8" rx="1.2" />
  </>,
)

export const IconUnlock = svg(
  <>
    <path d="M8 1.4a3.6 3.6 0 0 0-3.6 3.6v1.6h1.8V5a1.8 1.8 0 0 1 3.55-.42.9.9 0 0 0 1.75-.42A3.6 3.6 0 0 0 8 1.4Z" opacity=".55" />
    <rect x="3.2" y="6.6" width="9.6" height="8" rx="1.2" />
  </>,
)

export const IconSelect = svg(
  <path d="M3.4 1.8a.6.6 0 0 0-.6.72l2.3 11.1a.6.6 0 0 0 1.06.25l2.06-2.66 2.5 3.1a.8.8 0 0 0 1.25-1l-2.44-3.03 3.2-.72a.6.6 0 0 0 .2-1.07L3.77 1.9a.6.6 0 0 0-.37-.1Z" />,
)

export const IconRazor = svg(
  <>
    <path d="M5.1 1.7a.7.7 0 0 0-1.2.72l4 6.9 1.2-.7Z" />
    <path d="M10.9 1.7 6.9 8.62l1.2.7 4-6.9a.7.7 0 0 0-1.2-.72Z" opacity=".55" />
    <circle cx="4.6" cy="12.4" r="2.1" />
    <circle cx="11.4" cy="12.4" r="2.1" opacity=".55" />
  </>,
)

export const IconSpacer = svg(
  <>
    <rect x="7.2" y="2.4" width="1.6" height="11.2" rx=".6" />
    <path d="M5.6 5.6 2.4 8l3.2 2.4Z" />
    <path d="M10.4 5.6 13.6 8l-3.2 2.4Z" />
  </>,
)

export const IconMarker = svg(
  <path d="M4 1.6a.8.8 0 0 0-.8.8v11.2a.8.8 0 0 0 1.6 0V9.6h6.4a.8.8 0 0 0 .62-1.3L10.2 5.6l1.62-2.7A.8.8 0 0 0 11.2 1.6Z" />,
)
