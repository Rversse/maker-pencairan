import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { supabase } from './lib/supabase'
import { loginMaker, logoutMaker } from './services/auth'
import {
  getMakerMasterData,
  type MakerMasterData,
  type MakerAccountRule
} from './services/master-data'

type RabEntry = {
  accountId: string
  productTypes: string[]
  amount: string
}

type SimpleEntry = {
  id: number
  accountId: string
  amount: string
  accountNumber: string
  need: string
}

type TransactionGroup = {
  id: number
  date: string
  rab: RabEntry[]
  gas: SimpleEntry[]
  operasional?: SimpleEntry[]
  lain_lain: SimpleEntry[]
}

type SavedWorkspace = {
  version: 3 | 4
  kitchenId: string
  activeTransactionId: number
  transactions: TransactionGroup[]
  savedAt?: number
}

const STORAGE_KEY = 'maker-pencairan-workspace-v4'
const LEGACY_STORAGE_KEY = 'maker-pencairan-workspace-v3'

const OPERATIONAL_BANKS = [
  'BCA',
  'BJB',
  'BNI',
  'BRI',
  'BSI',
  'MANDIRI',
  'SEABANK'
]

function toIsoDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDate(date: string) {
  if (!date) return ''

  const [year, month, day] = date.split('-')
  if (!year || !month || !day) return ''

  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]

  const monthName = monthNames[Number(month) - 1]
  return monthName ? `${day}-${monthName}-${year}` : ''
}

function formatNumber(value: string) {
  const numeric = Number(value.replace(/\D/g, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  return new Intl.NumberFormat('id-ID').format(numeric)
}

function isCompleteAmount(value: string) {
  return Number(value.replace(/\D/g, '')) > 0
}

function sortStrings(values: string[]) {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, 'id', { sensitivity: 'base' })
  )
}

function sortRabRules<
  T extends { accounts: { name: string; bank: string } | null }
>(rules: T[]) {
  return [...rules].sort((a, b) => {
    const aName = `${a.accounts?.name ?? ''} ${a.accounts?.bank ?? ''}`
    const bName = `${b.accounts?.name ?? ''} ${b.accounts?.bank ?? ''}`
    return aName.localeCompare(bName, 'id', { sensitivity: 'base' })
  })
}

function getOutputBank(value: string) {
  return value.trim().toUpperCase()
}

function getPreferredBank(kitchenName: string) {
  const normalized = kitchenName.trim().toLowerCase()

  if (normalized === 'cihaur' || normalized === 'sukaraja') {
    return 'BRI'
  }

  return 'BNI'
}

function getOutputCategoryRank(kind: 'rab' | 'gas' | 'lain_lain') {
  return kind === 'rab' ? 1 : 0
}

function getOutputModeRank(kind: 'rab' | 'gas' | 'lain_lain') {
  if (kind === 'gas') return 1
  if (kind === 'lain_lain') return 2
  return 3
}

function displaySupplierName(
  supplier:
    | { business_name: string; owner_name: string | null }
    | null
    | undefined
) {
  if (!supplier) return ''
  return supplier.owner_name
    ? `${supplier.business_name} (${supplier.owner_name})`
    : supplier.business_name
}

function createBlankTransactionFromExisting(
  transaction: TransactionGroup
): TransactionGroup {
  return {
    id: transaction.id,
    date: transaction.date,
    rab: transaction.rab.map((entry) => ({
      accountId: entry.accountId,
      productTypes: [],
      amount: ''
    })),
    gas: transaction.gas.map((entry) => ({
      id: entry.id,
      accountId: entry.accountId,
      amount: '',
      accountNumber: entry.accountNumber,
      need: ''
    })),
    lain_lain: [emptySimpleEntry(1)]
  }
}

function isValidSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<SavedWorkspace> & { version?: unknown }
  return (
    (candidate.version === 3 || candidate.version === 4) &&
    typeof candidate.kitchenId === 'string' &&
    typeof candidate.activeTransactionId === 'number' &&
    Array.isArray(candidate.transactions) &&
    candidate.transactions.length > 0
  )
}

function readSavedWorkspace(): SavedWorkspace | null {
  if (typeof window === 'undefined') return null

  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as unknown
    if (!isValidSavedWorkspace(parsed)) return null

    const hasActiveTransaction = parsed.transactions.some(
      (transaction) => transaction.id === parsed.activeTransactionId
    )

    return {
      version: 4,
      kitchenId: parsed.kitchenId,
      activeTransactionId: hasActiveTransaction
        ? parsed.activeTransactionId
        : parsed.transactions[0].id,
      transactions: parsed.transactions,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  if (typeof window === 'undefined') return

  try {
    const payload: SavedWorkspace = {
      version: 4,
      ...workspace,
      savedAt: Date.now()
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // localStorage can fail in private/restricted browser contexts.
    // The app continues to work in memory in that case.
  }
}

function emptySimpleEntry(id = 1): SimpleEntry {
  return {
    id,
    accountId: '',
    amount: '',
    accountNumber: '',
    need: ''
  }
}

function makeTransaction(
  id: number,
  date: string,
  rabRules: Array<{ account_id: string }>,
  gasRules: Array<{
    account_id: string
    accounts: { account_number: string | null } | null
  }>
): TransactionGroup {
  const gasRule = gasRules[0]

  return {
    id,
    date,
    rab: rabRules.map((rule) => ({
      accountId: rule.account_id,
      productTypes: [],
      amount: ''
    })),
    gas: [
      {
        id: 1,
        accountId: gasRule?.account_id ?? '',
        amount: '',
        accountNumber: gasRule?.accounts?.account_number ?? '',
        need: ''
      }
    ],
    lain_lain: [emptySimpleEntry(1)]
  }
}

function App() {
  const saved = useMemo(() => readSavedWorkspace(), [])
  const [session, setSession] = useState<Session | null>(null)
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [masterData, setMasterData] = useState<MakerMasterData | null>(null)
  const [masterLoading, setMasterLoading] = useState(false)
  const [masterError, setMasterError] = useState('')

  const [kitchenId, setKitchenId] = useState(saved?.kitchenId ?? '')
  const [activeTransactionId, setActiveTransactionId] = useState(
    saved?.activeTransactionId ?? saved?.transactions[0]?.id ?? 1
  )
  const [transactions, setTransactions] = useState<TransactionGroup[]>(
    saved?.transactions ?? []
  )
  const [copyMessage, setCopyMessage] = useState('')
  const [historyMessage, setHistoryMessage] = useState('')
  const dateInputRef = useRef<HTMLInputElement>(null)
  const pinInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef({
    kitchenId: saved?.kitchenId ?? '',
    activeTransactionId:
      saved?.activeTransactionId ?? saved?.transactions[0]?.id ?? 1,
    transactions: saved?.transactions ?? []
  })

  useEffect(() => {
    let mounted = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
    })

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (session?.user.email !== 'maker-akuntan@internal.local') return
    void loadMasterData()
  }, [session])

  useEffect(() => {
    workspaceRef.current = {
      kitchenId,
      activeTransactionId,
      transactions
    }

    persistWorkspace(workspaceRef.current)
  }, [activeTransactionId, kitchenId, transactions])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const persistNow = () => {
      persistWorkspace(workspaceRef.current)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistNow()
      }
    }

    const handlePageHide = () => {
      persistNow()
    }

    const handleFreeze = () => {
      persistNow()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('freeze', handleFreeze)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('freeze', handleFreeze)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [])

  async function loadMasterData() {
    setMasterLoading(true)
    setMasterError('')

    try {
      const data = await getMakerMasterData()
      setMasterData(data)
    } catch (err) {
      setMasterError(
        err instanceof Error ? err.message : 'Gagal memuat master data.'
      )
    } finally {
      setMasterLoading(false)
    }
  }

  async function attemptLogin(nextPassword: string) {
    if (nextPassword.length !== 8 || loginLoading) return

    setLoginLoading(true)
    setLoginError('')

    try {
      await loginMaker('akuntan', nextPassword)
      setPassword('')
      await loadMasterData()
    } catch {
      setPassword('')
      setLoginError('PIN salah')
      window.setTimeout(() => pinInputRef.current?.focus(), 0)
    } finally {
      setLoginLoading(false)
    }
  }

  async function handleLogout() {
    await logoutMaker()
    setMasterData(null)
    setCopyMessage('')
    setHistoryMessage('')
    window.setTimeout(() => pinInputRef.current?.focus(), 0)
  }

  function handlePinChange(value: string) {
    const nextPassword = value.replace(/\D/g, '').slice(0, 8)
    setPassword(nextPassword)
    setLoginError('')

    if (nextPassword.length === 8) {
      void attemptLogin(nextPassword)
    }
  }

  const selectedKitchen = masterData?.kitchens.find(
    (kitchen) => kitchen.id === kitchenId
  )

  const rabRules = useMemo(() => {
    if (!masterData || !kitchenId) return []

    const seen = new Set<string>()
    return masterData.account_rules.filter((rule) => {
      if (rule.kitchen_id !== kitchenId) return false
      if (rule.flow_type !== 'income') return false
      if (!rule.accounts || !rule.supplier) return false
      if (seen.has(rule.account_id)) return false
      seen.add(rule.account_id)
      return true
    })
  }, [masterData, kitchenId])

  const sortedRabRules = useMemo(() => sortRabRules(rabRules), [rabRules])

  const gasRules = useMemo(() => {
    if (!masterData || !kitchenId) return []

    const seen = new Set<string>()
    return masterData.account_rules.filter((rule) => {
      if (rule.kitchen_id !== kitchenId) return false
      if (rule.flow_type !== 'neutral') return false
      if (!rule.accounts) return false
      if (seen.has(rule.account_id)) return false
      seen.add(rule.account_id)
      return true
    })
  }, [masterData, kitchenId])

  const activeTransaction =
    transactions.find(
      (transaction) => transaction.id === activeTransactionId
    ) ?? transactions[0]

  const activeDate = activeTransaction?.date ?? toIsoDate(new Date())

  function updateTransaction(
    transactionId: number,
    update: Partial<TransactionGroup>
  ) {
    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === transactionId
          ? { ...transaction, ...update }
          : transaction
      )
    )
  }

  function updateRabEntry(
    transactionId: number,
    accountId: string,
    update: Partial<RabEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) => {
        if (transaction.id !== transactionId) return transaction

        const existing = transaction.rab.find(
          (entry) => entry.accountId === accountId
        )
        const rab = existing
          ? transaction.rab.map((entry) =>
              entry.accountId === accountId ? { ...entry, ...update } : entry
            )
          : [
              ...transaction.rab,
              { accountId, productTypes: [], amount: '', ...update }
            ]

        return { ...transaction, rab }
      })
    )
  }

  function updateSimpleEntry(
    transactionId: number,
    section: 'gas' | 'lain_lain',
    id: number,
    update: Partial<SimpleEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === transactionId
          ? {
              ...transaction,
              [section]: transaction[section].map((entry) =>
                entry.id === id ? { ...entry, ...update } : entry
              )
            }
          : transaction
      )
    )
  }

  function addSimpleEntry(section: 'lain_lain') {
    if (!activeTransaction) return

    const currentEntries = activeTransaction[section]
    const nextId =
      currentEntries.length === 0
        ? 1
        : Math.max(...currentEntries.map((entry) => entry.id)) + 1

    updateTransaction(activeTransaction.id, {
      [section]: [...currentEntries, emptySimpleEntry(nextId)]
    })
  }

  function toggleRabProduct(
    transactionId: number,
    accountId: string,
    productType: string
  ) {
    const transaction = transactions.find((item) => item.id === transactionId)
    const entry = transaction?.rab.find((item) => item.accountId === accountId)
    if (!entry) return

    const exists = entry.productTypes.includes(productType)
    updateRabEntry(transactionId, accountId, {
      productTypes: sortStrings(
        exists
          ? entry.productTypes.filter((item) => item !== productType)
          : [...entry.productTypes, productType]
      )
    })
  }

  function getKitchenRulesFor(kitchen: string): MakerAccountRule[] {
    if (!masterData) return []

    const seen = new Set<string>()
    return masterData.account_rules.filter((rule) => {
      if (rule.kitchen_id !== kitchen) return false
      if (!rule.accounts || !rule.supplier) return false
      if (seen.has(rule.account_id)) return false
      seen.add(rule.account_id)
      return true
    })
  }

  function handleKitchenChange(nextKitchenId: string) {
    setKitchenId(nextKitchenId)
    setCopyMessage('')

    if (!nextKitchenId) {
      setTransactions([])
      setActiveTransactionId(1)
      return
    }

    const rules = getKitchenRulesFor(nextKitchenId)
    const nextRabRules = sortRabRules(
      rules.filter((rule) => rule.flow_type === 'income')
    )
    const nextGasRules = rules.filter((rule) => rule.flow_type === 'neutral')
    const initialDate = toIsoDate(new Date())
    const nextTransaction = makeTransaction(
      1,
      initialDate,
      nextRabRules.map((rule) => ({ account_id: rule.account_id })),
      nextGasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      }))
    )

    setTransactions([nextTransaction])
    setActiveTransactionId(1)
  }

  function openDatePicker() {
    const input = dateInputRef.current
    if (!input) return

    const pickerInput = input as HTMLInputElement & { showPicker?: () => void }
    if (typeof pickerInput.showPicker === 'function') {
      pickerInput.showPicker()
      return
    }

    input.focus()
  }

  function changeActiveDate(nextDate: string) {
    if (!activeTransaction) return
    updateTransaction(activeTransaction.id, { date: nextDate })
    setCopyMessage('')
  }

  function addTransaction() {
    if (!activeTransaction) return

    const nextId =
      transactions.length === 0
        ? 1
        : Math.max(...transactions.map((transaction) => transaction.id)) + 1

    const nextTransaction = {
      ...createBlankTransactionFromExisting(activeTransaction),
      id: nextId
    }

    setTransactions((current) => [...current, nextTransaction])
    setActiveTransactionId(nextId)
    setCopyMessage('')
  }

  function removeTransaction(transactionId: number) {
    if (transactions.length <= 1) return

    const remaining = transactions.filter(
      (transaction) => transaction.id !== transactionId
    )
    setTransactions(remaining)

    if (activeTransactionId === transactionId) {
      setActiveTransactionId(remaining[0].id)
    }
  }

  function resetWorkspace() {
    const initialDate = toIsoDate(new Date())
    const nextTransaction = makeTransaction(
      1,
      initialDate,
      sortedRabRules.map((rule) => ({ account_id: rule.account_id })),
      gasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      }))
    )
    setTransactions(nextTransaction.date ? [nextTransaction] : [])
    setActiveTransactionId(1)
    setCopyMessage('')
    setHistoryMessage('Draft browser direset.')
    window.setTimeout(() => setHistoryMessage(''), 1800)
  }

  function getSimpleOutputs(transaction: TransactionGroup): Array<{
    bank: string
    line: string
    kind: 'lain_lain'
  }> {
    const outputs: Array<{
      bank: string
      line: string
      kind: 'lain_lain'
    }> = []

    for (const entry of transaction.lain_lain) {
      if (!isCompleteAmount(entry.amount)) continue

      const bank = entry.accountId.trim()
      const accountNumber = entry.accountNumber.trim()
      if (!bank || !accountNumber) continue

      const need = entry.need.trim() || 'Biaya Ops Harian'

      outputs.push({
        bank: getOutputBank(bank),
        line: `Lain-lain: (${bank}) ${accountNumber} · ${need} · ${formatNumber(entry.amount)}`,
        kind: 'lain_lain'
      })
    }

    return outputs
  }

  function getTransactionOutput(transaction: TransactionGroup) {
    type OutputItem = {
      kind: 'rab' | 'gas' | 'lain_lain'
      bank: string
      line: string
      index: number
    }

    const items: OutputItem[] = []
    const preferredBank = getPreferredBank(selectedKitchen?.name ?? '')

    for (const entry of transaction.gas) {
      if (!isCompleteAmount(entry.amount)) continue
      const rule =
        gasRules.find((item) => item.account_id === entry.accountId) ??
        gasRules[0]
      if (!rule?.accounts) continue

      const accountName =
        displaySupplierName(rule.supplier) || rule.accounts.name
      const outputLine = `${accountName} - (${rule.accounts.bank}) ${rule.accounts.account_number ?? '-'} · ${formatNumber(entry.amount)}`

      items.push({
        kind: 'gas',
        bank: getOutputBank(rule.accounts.bank),
        line: `GAS : ${outputLine}`,
        index: items.length
      })
    }

    for (const rule of sortedRabRules) {
      const entry = transaction.rab.find(
        (item) => item.accountId === rule.account_id
      )
      if (!entry || !rule.accounts) continue

      const hasAmount = isCompleteAmount(entry.amount)
      const productText = sortStrings(entry.productTypes).join(', ')
      const hasProduct = productText.length > 0

      if (!hasAmount && !hasProduct) continue

      const supplierName = rule.supplier
        ? `${rule.supplier.business_name}${rule.supplier.owner_name ? ` (${rule.supplier.owner_name})` : ''}`
        : rule.accounts.name
      const accountText = `${supplierName} - ${rule.accounts.bank}`
      const amountText = formatNumber(entry.amount) || '0'
      const outputLine = hasProduct
        ? `${accountText} · ${productText} · ${amountText}`
        : `${accountText} · ${amountText}`

      items.push({
        kind: 'rab',
        bank: getOutputBank(rule.accounts.bank),
        line: `RAB : ${outputLine}`,
        index: items.length
      })
    }

    for (const output of getSimpleOutputs(transaction)) {
      items.push({
        kind: output.kind,
        bank: output.bank,
        line: output.line,
        index: items.length
      })
    }

    items.sort((a, b) => {
      const aPreferred = a.bank === preferredBank ? 0 : 1
      const bPreferred = b.bank === preferredBank ? 0 : 1

      if (aPreferred !== bPreferred) return aPreferred - bPreferred

      const aCategory = getOutputCategoryRank(a.kind)
      const bCategory = getOutputCategoryRank(b.kind)

      if (aCategory !== bCategory) return aCategory - bCategory

      const bankCompare = a.bank.localeCompare(b.bank, 'id', {
        sensitivity: 'base'
      })
      if (bankCompare !== 0) return bankCompare

      const modeCompare = getOutputModeRank(a.kind) - getOutputModeRank(b.kind)
      if (modeCompare !== 0) return modeCompare

      return a.index - b.index
    })

    if (items.length === 0) return []

    return [
      `${selectedKitchen?.name ?? 'Dapur'}, ${formatDate(transaction.date)}`,
      ...items.map((item) => item.line)
    ]
  }

  const sortedTransactions = transactions
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date)
      return a.id - b.id
    })
    .map((transaction) => ({
      date: transaction.date,
      block: getTransactionOutput(transaction)
    }))
    .filter((entry) => entry.block.length > 0)

  let output = ''
  let previousOutputDate = ''

  for (const entry of sortedTransactions) {
    const blockText = entry.block.join('\n')

    if (!output) {
      output = blockText
    } else {
      const separator = previousOutputDate === entry.date ? '\n' : '\n\n'
      output += `${separator}${blockText}`
    }

    previousOutputDate = entry.date
  }

  async function copyOutput() {
    if (!output) return

    await navigator.clipboard.writeText(output)
    setCopyMessage('Berhasil disalin.')
    window.setTimeout(() => setCopyMessage(''), 2000)
  }

  function restoreLastDraft() {
    const stored = readSavedWorkspace()
    if (!stored) {
      setHistoryMessage('Belum ada draft tersimpan di browser.')
      window.setTimeout(() => setHistoryMessage(''), 1800)
      return
    }

    setKitchenId(stored.kitchenId)
    setTransactions(stored.transactions)
    setActiveTransactionId(stored.activeTransactionId)
    setHistoryMessage('Draft terakhir dipulihkan.')
    window.setTimeout(() => setHistoryMessage(''), 1800)
  }

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-stone-950 p-6 text-white">
        <div className="w-full max-w-sm rounded-2xl border border-stone-800 bg-stone-900 p-6 shadow-xl">
          <h1 className="text-2xl font-bold">Maker Pencairan</h1>
          <p className="mt-2 text-sm text-stone-400">
            Masukkan PIN untuk masuk.
          </p>

          <label htmlFor="pin" className="mt-6 block text-sm text-stone-300">
            PIN
          </label>
          <input
            ref={pinInputRef}
            id="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            autoFocus
            maxLength={8}
            value={password}
            onChange={(event) => handlePinChange(event.target.value)}
            placeholder="8 digit PIN"
            disabled={loginLoading}
            className="mt-2 h-11 w-full rounded-lg border border-stone-700 bg-stone-950 px-3 text-center tracking-[0.3em] text-white outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30"
          />

          {loginLoading && (
            <p className="mt-3 text-xs text-stone-400">Memeriksa PIN...</p>
          )}
          {loginError && (
            <p className="mt-3 text-sm font-medium text-red-400">
              {loginError}
            </p>
          )}
        </div>
      </main>
    )
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen bg-stone-950 p-3 text-white md:p-4">
      <div className="mx-auto max-w-7xl">
        <>
          <header className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Maker Pencairan</h1>
              <p className="mt-1 text-sm leading-5 text-stone-300">
                Pencairan multi-tanggal dalam satu draft.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={restoreLastDraft}
                className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 text-xs font-medium text-stone-200 hover:bg-stone-800"
              >
                Pulihkan
              </button>
              <button
                type="button"
                onClick={resetWorkspace}
                className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 text-xs font-medium text-stone-200 hover:bg-stone-800"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-lg bg-stone-800 px-4 py-2 text-sm hover:bg-stone-700"
              >
                Keluar
              </button>
            </div>
          </header>

          {masterLoading && (
            <div className="mt-4 rounded-xl border border-stone-800 bg-stone-900 p-4 text-sm text-stone-400">
              Memuat master data...
            </div>
          )}

          {masterError && (
            <div className="mt-4 rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
              <p>{masterError}</p>
              <button
                type="button"
                onClick={() => void loadMasterData()}
                className="mt-3 rounded-lg bg-stone-800 px-3 py-2 text-sm text-white hover:bg-stone-700"
              >
                Coba Lagi
              </button>
            </div>
          )}

          {masterData && !masterLoading && !masterError && (
            <>
              <div className="sticky top-0 z-30 -mx-3 mt-4 bg-stone-950/90 px-3 pb-3 pt-1 backdrop-blur md:-mx-4 md:px-4">
                <section className="rounded-xl border border-stone-600 bg-stone-900 p-4 shadow-lg">
                  <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.15fr)_minmax(220px,1.15fr)_minmax(180px,220px)] lg:items-end">
                    <div>
                      <label
                        htmlFor="date"
                        className="mb-1 block text-sm font-medium leading-5 text-stone-300"
                      >
                        Tanggal transaksi aktif
                      </label>
                      <div className="relative flex h-10 cursor-pointer items-center rounded-lg border border-stone-700 bg-stone-950 px-3 transition hover:border-stone-600 focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500/40">
                        <span className="text-xs font-semibold text-stone-500">
                          TANGGAL
                        </span>
                        <span className="ml-3 text-sm font-semibold text-white">
                          {formatDate(activeDate)}
                        </span>
                        <input
                          ref={dateInputRef}
                          id="date"
                          type="date"
                          value={activeDate}
                          onChange={(event) =>
                            changeActiveDate(event.target.value)
                          }
                          onClick={(event) => {
                            event.stopPropagation()
                            openDatePicker()
                          }}
                          aria-label="Pilih tanggal transaksi"
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="kitchen"
                        className="mb-1 block text-sm font-medium leading-5 text-stone-300"
                      >
                        Dapur
                      </label>
                      <select
                        id="kitchen"
                        value={kitchenId}
                        onChange={(event) =>
                          handleKitchenChange(event.target.value)
                        }
                        className="h-10 w-full rounded-lg border border-stone-700 bg-stone-950 px-3 text-sm font-semibold text-white outline-none transition hover:border-stone-600 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40"
                      >
                        <option value="">Pilih dapur</option>
                        {masterData.kitchens.map((kitchen) => (
                          <option key={kitchen.id} value={kitchen.id}>
                            {kitchen.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      onClick={addTransaction}
                      disabled={!activeTransaction}
                      className="h-10 w-full max-w-55 justify-self-center whitespace-nowrap rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/70 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      + Transaksi Baru
                    </button>
                  </div>

                  {historyMessage && (
                    <div className="mt-2 text-[11px] text-emerald-300">
                      {historyMessage}
                    </div>
                  )}
                </section>

                {kitchenId && activeTransaction && (
                  <section className="mt-2 rounded-xl border border-emerald-700/60 bg-emerald-950/20 p-3 shadow-lg">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-semibold">Siap Copy</h2>
                        <p className="mt-1 text-xs leading-5 text-stone-300">
                          Draft otomatis tersimpan di browser.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyOutput()}
                        disabled={!output}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {copyMessage || 'Copy'}
                      </button>
                    </div>

                    <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded-lg border border-stone-800 bg-stone-950 p-3 text-xs leading-5 text-stone-200">
                      {output || 'Belum ada transaksi yang nominalnya terisi.'}
                    </pre>
                  </section>
                )}
              </div>

              {kitchenId && activeTransaction && (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 pt-1">
                    {transactions
                      .slice()
                      .sort((a, b) =>
                        a.date !== b.date
                          ? a.date.localeCompare(b.date)
                          : a.id - b.id
                      )
                      .map((transaction, index) => (
                        <button
                          key={transaction.id}
                          type="button"
                          onClick={() => setActiveTransactionId(transaction.id)}
                          className={[
                            'rounded-lg border px-3 py-2 text-xs font-medium transition',
                            activeTransactionId === transaction.id
                              ? 'border-emerald-500 bg-emerald-600 text-white'
                              : 'border-stone-700 bg-stone-900 text-stone-300 hover:bg-stone-800'
                          ].join(' ')}
                        >
                          T{index + 1} · {formatDate(transaction.date)}
                        </button>
                      ))}
                    {transactions.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeTransaction(activeTransactionId)}
                        className="rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-950/40"
                      >
                        Hapus Transaksi Aktif
                      </button>
                    )}
                  </div>

                  <section className="rounded-xl border border-stone-500 bg-stone-900 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="shrink-0 rounded-md border border-stone-400/40 bg-stone-400/10 px-2 py-1 text-[10px] font-bold tracking-wide text-stone-200">
                          RAB
                        </span>
                        <span className="text-xs leading-5 text-stone-300">
                          Rekening RAB hanya keluar ke output jika nominal
                          diisi. GAS berada di card terpisah di bawah.
                        </span>
                      </div>
                      <div className="shrink-0 text-right text-xs text-stone-300">
                        {formatDate(activeTransaction.date)}
                      </div>
                    </div>

                    {(() => {
                      const splitIndex = Math.ceil(sortedRabRules.length / 2)
                      const rabLeftRules = sortedRabRules.slice(0, splitIndex)
                      const rabRightRules = sortedRabRules.slice(splitIndex)

                      const renderRabCard = (
                        rule: MakerAccountRule,
                        index: number
                      ) => {
                        const entry = activeRabMap.get(rule.account_id) ?? {
                          accountId: rule.account_id,
                          productTypes: [],
                          amount: ''
                        }
                        const products = sortStrings(
                          rule.supplier?.product_types ?? []
                        )

                        return (
                          <div
                            key={rule.account_id}
                            className="rounded-lg border border-stone-500/70 bg-stone-950 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-stone-100">
                                  {index + 1}.{' '}
                                  {rule.supplier?.business_name ??
                                    rule.accounts?.name ??
                                    'Tanpa nama'}{' '}
                                  - {rule.accounts?.bank ?? '-'} (
                                  {rule.accounts?.account_number ?? '-'})
                                </div>
                              </div>
                              {isCompleteAmount(entry.amount) && (
                                <span className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-300">
                                  AKTIF
                                </span>
                              )}
                            </div>

                            <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_160px]">
                              <div>
                                {products.length > 0 ? (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {products.map((product) => {
                                      const selected =
                                        entry.productTypes.includes(product)
                                      return (
                                        <button
                                          key={product}
                                          type="button"
                                          onClick={() =>
                                            toggleRabProduct(
                                              activeTransaction.id,
                                              rule.account_id,
                                              product
                                            )
                                          }
                                          className={[
                                            'inline-flex h-10 items-center rounded-md border px-3 text-sm font-medium transition',
                                            selected
                                              ? 'border-emerald-500 bg-emerald-600 text-white'
                                              : 'border-stone-700 bg-stone-900 text-stone-300 hover:bg-stone-800'
                                          ].join(' ')}
                                        >
                                          {selected ? '✓ ' : ''}
                                          {product}
                                        </button>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <div className="text-[11px] text-stone-600">
                                    Tidak ada data produk.
                                  </div>
                                )}
                              </div>

                              <div>
                                <input
                                  id={`rab-${activeTransaction.id}-${rule.account_id}`}
                                  type="text"
                                  inputMode="numeric"
                                  value={formatNumber(entry.amount)}
                                  onChange={(event) =>
                                    updateRabEntry(
                                      activeTransaction.id,
                                      rule.account_id,
                                      {
                                        amount: event.target.value.replace(
                                          /\D/g,
                                          ''
                                        )
                                      }
                                    )
                                  }
                                  placeholder="Nominal"
                                  className="h-10 w-full rounded-md border border-stone-700 bg-stone-900 px-3 text-sm font-semibold text-stone-100 placeholder:text-stone-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                                />
                              </div>
                            </div>
                          </div>
                        )
                      }

                      return (
                        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 lg:items-start">
                          <div className="grid min-w-0 gap-2.5">
                            {rabLeftRules.map((rule, index) =>
                              renderRabCard(rule, index)
                            )}
                          </div>

                          <div className="grid min-w-0 gap-2.5">
                            {rabRightRules.map((rule, offset) =>
                              renderRabCard(rule, splitIndex + offset)
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </section>

                  {gasRules.length > 0 && (
                    <div className="w-full rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold tracking-wide text-emerald-200">
                            GAS
                          </span>
                          <span className="text-xs leading-5 text-emerald-100/90">
                            Input nominal saja.
                          </span>
                        </div>
                      </div>

                      <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.6fr)_minmax(180px,1fr)_160px] lg:items-center">
                        {activeTransaction.gas.map((entry) => {
                          const rule =
                            gasRules.find(
                              (item) => item.account_id === entry.accountId
                            ) ?? gasRules[0]

                          return (
                            <div key={entry.id} className="contents">
                              <div className="flex h-10 min-w-0 items-center rounded-md border border-emerald-500/30 bg-stone-900 px-3 text-sm font-semibold text-stone-100">
                                <span className="block min-w-0 truncate">
                                  {displaySupplierName(rule?.supplier) ||
                                    rule?.accounts?.name}
                                </span>
                              </div>

                              <div className="flex h-10 items-center rounded-md border border-emerald-500/30 bg-stone-900 px-3 text-sm font-semibold text-emerald-100">
                                GAS
                              </div>

                              <div>
                                <input
                                  id={`gas-${activeTransaction.id}-${entry.id}`}
                                  type="text"
                                  inputMode="numeric"
                                  value={formatNumber(entry.amount)}
                                  onChange={(event) =>
                                    updateSimpleEntry(
                                      activeTransaction.id,
                                      'gas',
                                      entry.id,
                                      {
                                        amount: event.target.value.replace(
                                          /\D/g,
                                          ''
                                        )
                                      }
                                    )
                                  }
                                  placeholder="Nominal"
                                  aria-label="Nominal GAS"
                                  className="h-10 w-full rounded-md border border-emerald-500/30 bg-stone-900 px-3 text-sm font-semibold text-stone-100 placeholder:text-stone-500 outline-none transition hover:border-emerald-400 focus:border-emerald-300 focus:ring-1 focus:ring-emerald-300/30"
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {gasRules.length === 0 && (
                    <div className="w-full rounded-lg border border-dashed border-stone-700 p-3 text-sm text-stone-500">
                      Dapur ini tidak memiliki mapping GAS.
                    </div>
                  )}

                  <section className="w-full rounded-xl border border-rose-600/60 bg-rose-950/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold">
                          Form Lain-Lain
                        </h2>
                        <p className="mt-1 text-xs leading-5 text-stone-300">
                          Pilih bank, isi nomor rekening, keperluan, dan
                          nominal.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => addSimpleEntry('lain_lain')}
                        className="h-10 rounded-lg border border-stone-700 bg-stone-800 px-4 text-xs font-semibold transition hover:bg-stone-700"
                      >
                        + Transaksi
                      </button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {activeTransaction.lain_lain.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-rose-800/50 bg-stone-950 p-3"
                        >
                          <div className="grid gap-2 lg:grid-cols-[180px_220px_minmax(0,1fr)_160px] lg:items-end">
                            <div>
                              <select
                                value={entry.accountId}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    { accountId: event.target.value }
                                  )
                                }
                                className="h-10 w-full rounded-md border border-stone-700 bg-stone-900 px-3 text-sm font-medium text-stone-100 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              >
                                <option value="">Pilih bank</option>
                                {OPERATIONAL_BANKS.map((bank) => (
                                  <option key={bank} value={bank}>
                                    {bank}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <input
                                id={`acc-${activeTransaction.id}-lain-${entry.id}`}
                                type="text"
                                inputMode="numeric"
                                value={entry.accountNumber}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    {
                                      accountNumber: event.target.value.replace(
                                        /\D/g,
                                        ''
                                      )
                                    }
                                  )
                                }
                                placeholder="Nomor rekening"
                                className="h-10 w-full rounded-md border border-stone-700 bg-stone-900 px-3 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>

                            <div>
                              <input
                                id={`need-${activeTransaction.id}-lain-${entry.id}`}
                                type="text"
                                value={entry.need}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    { need: event.target.value }
                                  )
                                }
                                placeholder="Keperluan / Kosong untuk Ops Harian"
                                className="h-10 w-full rounded-md border border-stone-700 bg-stone-900 px-3 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>

                            <div>
                              <input
                                id={`amount-${activeTransaction.id}-lain-${entry.id}`}
                                type="text"
                                inputMode="numeric"
                                value={formatNumber(entry.amount)}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    {
                                      amount: event.target.value.replace(
                                        /\D/g,
                                        ''
                                      )
                                    }
                                  )
                                }
                                placeholder="Nominal"
                                className="h-10 w-full rounded-md border border-stone-700 bg-stone-900 px-3 text-sm font-semibold text-stone-100 placeholder:text-stone-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </>
      </div>
    </main>
  )
}

export default App
