import { useCallback, useEffect, useState } from 'react'

interface Props {
  onFiles: (paths: string[]) => void
}

/**
 * Whole-window drop target for files coming from the OS.
 *
 * The counter is needed because dragenter/dragleave fire for every child the
 * pointer crosses; a plain boolean flickers the overlay on and off as the
 * cursor moves over panels.
 */
export function DropZone(props: Props) {
  const [depth, setDepth] = useState(0)

  const isFileDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const onFiles = props.onFiles

  const handleDrop = useCallback(
    (event: DragEvent) => {
      setDepth(0)
      if (!isFileDrag(event)) return
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      // `File.path` is gone since Electron 32; the preload resolves real paths.
      const paths = files.map((file) => window.palmier.files.pathFor(file)).filter(Boolean)
      if (paths.length > 0) onFiles(paths)
    },
    [onFiles],
  )

  useEffect(() => {
    const onEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      setDepth((d) => d + 1)
    }
    const onLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      setDepth((d) => Math.max(0, d - 1))
    }
    const onOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      // Without this the OS shows "copy" then the browser opens the file itself.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [handleDrop])

  if (depth === 0) return null

  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <svg viewBox="0 0 16 16" className="drop-icon" aria-hidden="true">
          <path
            d="M8 1.6a.9.9 0 0 0-.9.9v6.1L4.9 6.4a.9.9 0 1 0-1.27 1.27l3.73 3.73a.9.9 0 0 0 1.28 0l3.73-3.73A.9.9 0 0 0 10.1 6.4L8.9 8.6V2.5a.9.9 0 0 0-.9-.9Z"
            fill="currentColor"
          />
          <path
            d="M2.4 10.8a.9.9 0 0 1 .9.9v1.6h9.4v-1.6a.9.9 0 1 1 1.8 0v2a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3v-2a.9.9 0 0 1 .9-.9Z"
            fill="currentColor"
          />
        </svg>
        <p className="drop-title">Drop to import</p>
        <p className="drop-detail">Video, audio and images land in the project bin.</p>
      </div>
    </div>
  )
}
