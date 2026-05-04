import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, FileText } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  onFile: (file: File) => void
  loading: boolean
}

export default function UploadZone({ onFile, loading }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handle = (file: File) => {
    if (file.name.endsWith('.pxp') || file.name.endsWith('.xer')) {
      onFile(file)
    }
  }

  return (
    <div
      onClick={() => !loading && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) handle(f)
      }}
      className={clsx(
        'relative cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300',
        'rounded-xl border border-steel-700 bg-steel-900/50 p-4 flex items-center gap-3',
        dragging
          ? 'border-amber-400 bg-amber-400/5 scale-[1.01]'
          : 'border-steel-600 hover:border-steel-400 bg-steel-900/40 hover:bg-steel-800/40',
        loading && 'opacity-60 pointer-events-none'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pxp,.xer"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handle(f)
          e.target.value = ''
        }}
      />
      <div className={clsx(
        'w-10 h-10 rounded-lg flex items-center justify-center transition-all',
        dragging ? 'bg-amber-400/20' : 'bg-steel-800'
      )}>
        {loading ? (
          <div className="w-7 h-7 border-2 border-steel-400 border-t-amber-400 rounded-full animate-spin" />
        ) : (
          <Upload className={clsx('w-7 h-7', dragging ? 'text-amber-400' : 'text-steel-400')} />
        )}
      </div>
      <div className="text-center">
        <p className="font-display font-semibold text-steel-200 text-[10px]">
          {loading ? t('loading') : t('upload_title')}
        </p>
        {/* <p className="text-steel-500 text-sm">{t('upload_hint')}</p> */}
        <div className="mt-1 flex gap-2 justify-center">
          {['.pxp', '.xer'].map((ext) => (
            <span key={ext} className="inline-flex items-center gap-1 px-2 bg-steel-800 rounded text-xs font-mono text-steel-400 border border-steel-700">
              <FileText className="w-3 h-3" />
              {ext}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}