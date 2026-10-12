import { useEffect, useMemo, useRef, useState } from 'react'

export type DateRangeValue = {
  startDate: string
  endDate: string
}

type DateRangePickerProps = {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  placeholder?: string
}

const WEEK_DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]
const MONTH_LONG_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
]

function getTodayKey() {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function toDateKey(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-')
}

function compareDateKeys(left: string, right: string) {
  return left.localeCompare(right)
}

function addMonths(date: Date, amount: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1))
}

function getMonthCells(month: Date) {
  const year = month.getUTCFullYear()
  const monthIndex = month.getUTCMonth()
  const firstDay = new Date(Date.UTC(year, monthIndex, 1))
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0))
  const cells: Array<string | null> = Array(firstDay.getUTCDay()).fill(null)

  for (let day = 1; day <= lastDay.getUTCDate(); day += 1) {
    cells.push(toDateKey(new Date(Date.UTC(year, monthIndex, day))))
  }

  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

function formatDateKey(value: string) {
  if (!value) return ''
  const date = parseDateKey(value)
  return String(date.getUTCDate()).padStart(2, '0') +
    '-' + MONTH_NAMES[date.getUTCMonth()] +
    '-' + date.getUTCFullYear()
}

function formatRangeText(value: DateRangeValue, placeholder: string) {
  if (!value.startDate) return placeholder
  const start = formatDateKey(value.startDate)
  if (!value.endDate) return start + ' – Pilih tanggal akhir'
  if (value.endDate === value.startDate) return start
  return start + ' – ' + formatDateKey(value.endDate)
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = 'Pilih rentang tanggal'
}: DateRangePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const today = getTodayKey()
  const initialMonth = useMemo(() => {
    const date = value.startDate ? parseDateKey(value.startDate) : parseDateKey(today)
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  }, [today, value.startDate])

  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(initialMonth)
  const [pendingStart, setPendingStart] = useState('')
  const [hoverDate, setHoverDate] = useState('')
  const [showMonthYearPicker, setShowMonthYearPicker] = useState(false)

  const selectedYear = viewMonth.getUTCFullYear()
  const selectedMonth = viewMonth.getUTCMonth()
  const yearOptions = useMemo(() => {
    const years = new Set<number>()
    const currentYear = new Date().getFullYear()
    for (let year = currentYear - 10; year <= currentYear + 10; year += 1) {
      years.add(year)
    }
    if (value.startDate) years.add(parseDateKey(value.startDate).getUTCFullYear())
    if (value.endDate) years.add(parseDateKey(value.endDate).getUTCFullYear())
    years.add(selectedYear)
    return [...years].sort((a, b) => a - b)
  }, [selectedYear, value.endDate, value.startDate])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        rootRef.current &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false)
        setPendingStart('')
        setHoverDate('')
        setShowMonthYearPicker(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      setPendingStart('')
      setHoverDate('')
      setShowMonthYearPicker(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleTriggerClick() {
    if (open) {
      setOpen(false)
      setPendingStart('')
      setHoverDate('')
      setShowMonthYearPicker(false)
      return
    }

    setViewMonth(initialMonth)
    setPendingStart('')
    setHoverDate('')
    setShowMonthYearPicker(false)
    setOpen(true)
  }

  function selectDate(dateKey: string) {
    if (!pendingStart) {
      setPendingStart(dateKey)
      setHoverDate(dateKey)
      return
    }

    if (compareDateKeys(dateKey, pendingStart) < 0) {
      setPendingStart(dateKey)
      setHoverDate(dateKey)
      return
    }

    onChange({ startDate: pendingStart, endDate: dateKey })
    setOpen(false)
    setPendingStart('')
    setHoverDate('')
    setShowMonthYearPicker(false)
  }

  const monthCells = getMonthCells(viewMonth)

  return (
    <div
      ref={rootRef}
      className={`relative min-w-0 w-full ${open ? 'z-50' : 'z-0'}`}
    >
      <button
        type="button"
        className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 text-left text-sm font-medium text-slate-100 outline-none transition hover:border-stone-500 hover:bg-slate-800 focus-visible:border-stone-300 focus-visible:ring-1 focus-visible:ring-stone-300/30"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={handleTriggerClick}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-sky-300">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {formatRangeText(value, placeholder)}
        </span>
        <span aria-hidden="true" className="shrink-0 text-[10px] text-slate-400">▾</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-[80] mt-2 w-[min(280px,calc(100vw-24px))] overflow-hidden rounded-xl border border-slate-600 bg-slate-800 text-slate-100 shadow-2xl"
          role="dialog"
          aria-label="Pilih rentang tanggal sewa kendaraan"
        >
          <div className="grid grid-cols-[30px_minmax(0,1fr)_30px] items-center gap-2 border-b border-slate-700 px-2 py-2">
            <button
              type="button"
              aria-label="Bulan sebelumnya"
              className="grid h-7 w-7 place-items-center rounded-md border border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-700"
              onClick={() => { setShowMonthYearPicker(false); setViewMonth((current) => addMonths(current, -1)) }}
            >‹</button>
            <button
              type="button"
              aria-expanded={showMonthYearPicker}
              className="flex min-w-0 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-sky-200 hover:bg-slate-700"
              onClick={() => setShowMonthYearPicker((current) => !current)}
            >
              {MONTH_LONG_NAMES[selectedMonth]} {selectedYear} <span aria-hidden="true">▾</span>
            </button>
            <button
              type="button"
              aria-label="Bulan berikutnya"
              className="grid h-7 w-7 place-items-center rounded-md border border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-700"
              onClick={() => { setShowMonthYearPicker(false); setViewMonth((current) => addMonths(current, 1)) }}
            >›</button>
          </div>

          {showMonthYearPicker && (
            <div className="grid grid-cols-[1.2fr_.8fr] gap-2 border-b border-slate-700 bg-slate-900/70 p-3">
              <label className="grid min-w-0 gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Bulan
                <select
                  value={selectedMonth}
                  onChange={(event) => setViewMonth(new Date(Date.UTC(selectedYear, Number(event.target.value), 1)))}
                  className="h-8 min-w-0 rounded-md border border-slate-600 bg-slate-800 px-2 text-xs font-medium text-white"
                >
                  {MONTH_LONG_NAMES.map((name, index) => <option value={index} key={name}>{name}</option>)}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Tahun
                <select
                  value={selectedYear}
                  onChange={(event) => setViewMonth(new Date(Date.UTC(Number(event.target.value), selectedMonth, 1)))}
                  className="h-8 min-w-0 rounded-md border border-slate-600 bg-slate-800 px-2 text-xs font-medium text-white"
                >
                  {yearOptions.map((year) => <option value={year} key={year}>{year}</option>)}
                </select>
              </label>
            </div>
          )}

          <div className="grid grid-cols-7 gap-1 p-3">
            {WEEK_DAYS.map((day) => (
              <span key={day} className="pb-1 text-center text-[9px] font-black uppercase text-slate-400">{day}</span>
            ))}
            {monthCells.map((dateKey, index) => {
              if (!dateKey) return <span key={`empty-${index}`} className="h-8" />
              const isStart = dateKey === (pendingStart || value.startDate)
              const isEnd = !pendingStart && Boolean(value.endDate) && dateKey === value.endDate
              const rangeStart = pendingStart || value.startDate
              const rangeEnd = pendingStart
                ? hoverDate && compareDateKeys(hoverDate, pendingStart) >= 0
                  ? hoverDate
                  : pendingStart
                : value.endDate
              const inRange =
                Boolean(rangeStart) &&
                Boolean(rangeEnd) &&
                compareDateKeys(dateKey, rangeStart) >= 0 &&
                compareDateKeys(dateKey, rangeEnd) <= 0
              const beforePending = Boolean(pendingStart) && compareDateKeys(dateKey, pendingStart) < 0

              return (
                <button
                  key={dateKey}
                  type="button"
                  disabled={beforePending}
                  onMouseEnter={() => setHoverDate(dateKey)}
                  onFocus={() => setHoverDate(dateKey)}
                  onClick={() => selectDate(dateKey)}
                  className={[
                    'grid h-8 w-full place-items-center rounded-md border text-[11px] font-bold transition',
                    isStart || isEnd
                      ? 'border-sky-400 bg-sky-500 text-slate-950'
                      : inRange
                        ? 'border-sky-500/20 bg-sky-500/15 text-sky-100'
                        : 'border-transparent bg-transparent text-slate-200 hover:border-sky-400 hover:bg-sky-500/10',
                    beforePending ? 'cursor-not-allowed opacity-30' : ''
                  ].join(' ')}
                >
                  {Number(dateKey.slice(-2))}
                </button>
              )
            })}
          </div>

          <div className="flex min-h-9 items-center justify-between gap-2 border-t border-slate-700 bg-slate-900/70 px-3 py-2 text-[10px] text-slate-400">
            <span>{pendingStart ? 'Pilih tanggal akhir' : 'Pilih tanggal awal lalu tanggal akhir'}</span>
            {pendingStart && (
              <button
                type="button"
                className="shrink-0 rounded-md border border-slate-600 px-2 py-1 font-bold text-slate-300 hover:bg-slate-700"
                onClick={() => { setPendingStart(''); setHoverDate('') }}
              >Batal</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
