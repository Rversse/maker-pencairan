import { useEffect, useMemo, useRef, useState } from 'react'
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
  ownerName: string
  need: string
}

type DailyPaymentKind =
  | 'Sewa SPPG'
  | 'Sewa Kendaraan'
  | 'Gaji Relawan'
  | 'Insentif PIC Sekolah'
  | 'Insentif Kader Posyandu'

type DailyPaymentCategory = 'sewa' | 'gaji'

type DailyPaymentEntry = {
  id: number
  category: DailyPaymentCategory
  kinds: DailyPaymentKind[]
  bank: string
  accountNumber: string
  ownerName: string
  amount: string
}

type TransactionGroup = {
  id: number
  date: string
  rab: RabEntry[]
  gas: SimpleEntry[]
  operasional?: SimpleEntry[]
  pencairan_harian: DailyPaymentEntry[]
  lain_lain: SimpleEntry[]
}

type SavedWorkspace = {
  version: 3 | 4 | 5 | 6
  kitchenId: string
  activeTransactionId: number
  transactions: TransactionGroup[]
  savedAt?: number
}

const STORAGE_KEY = 'maker-pencairan-workspace-v6'
const RECOVERY_STORAGE_KEY = 'maker-pencairan-workspace-recovery-v1'
const PREVIOUS_STORAGE_KEYS = [
  'maker-pencairan-workspace-v5',
  'maker-pencairan-workspace-v4',
  'maker-pencairan-workspace-v3'
]

const OPERATIONAL_BANKS = [
  'BCA',
  'BJB',
  'BNI',
  'BRI',
  'BSI',
  'MANDIRI',
  'SEABANK'
]

const DAILY_PAYMENT_SEWA_OPTIONS: DailyPaymentKind[] = [
  'Sewa SPPG',
  'Sewa Kendaraan'
]

const DAILY_PAYMENT_GAJI_OPTIONS: DailyPaymentKind[] = [
  'Gaji Relawan',
  'Insentif PIC Sekolah',
  'Insentif Kader Posyandu'
]

const DAILY_PAYMENT_OPTIONS: DailyPaymentKind[] = [
  ...DAILY_PAYMENT_SEWA_OPTIONS,
  ...DAILY_PAYMENT_GAJI_OPTIONS
]

const SEWA_KENDARAAN_ACCOUNT = {
  bank: 'MANDIRI',
  ownerName: 'Berkah Mandiri Putra',
  accountNumber: '1820015963523'
}

const SPPG_RENTAL_BY_KITCHEN: Record<
  string,
  { bank: string; ownerName: string; accountNumber: string }
> = {
  Campakamulya: {
    bank: 'BNI',
    ownerName: 'Enceng Kodir',
    accountNumber: '2028813591'
  },
  Cihaur: {
    bank: 'BRI',
    ownerName: 'Taufik Hidayat',
    accountNumber: '407701030044506'
  },
  Cisepat: {
    bank: 'BNI',
    ownerName: 'Robi Sulaeman',
    accountNumber: '2025279933'
  },
  Cipetir: {
    bank: 'BNI',
    ownerName: 'Yusgar Anggara',
    accountNumber: '885788718'
  },
  Kertajadi: {
    bank: 'BNI',
    ownerName: 'Rizki Ginanjar',
    accountNumber: '2033626616'
  },
  Cikondang: {
    bank: 'BNI',
    ownerName: 'Aryana',
    accountNumber: '1976811401'
  },
  Sukaraja: {
    bank: 'BRI',
    ownerName: 'Ade Rohmat Hidayat',
    accountNumber: '010501002303563'
  }
}

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

function sanitizeOwnerName(value: string) {
  return value.replace(/[^\p{L}\s]/gu, '')
}

function sortDailyPaymentKinds(values: DailyPaymentKind[]) {
  const order = new Map(
    DAILY_PAYMENT_OPTIONS.map((kind, index) => [kind, index])
  )

  return [...new Set(values)].sort(
    (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99)
  )
}

function getSppgRental(kitchenName: string) {
  return SPPG_RENTAL_BY_KITCHEN[kitchenName] ?? null
}

function getPreferredBank(kitchenName: string) {
  const normalized = kitchenName.trim().toLowerCase()

  if (normalized === 'cihaur' || normalized === 'sukaraja') {
    return 'BRI'
  }

  return 'BNI'
}

function getOutputCategoryRank(
  kind: 'rab' | 'pencairan_harian' | 'gas' | 'lain_lain'
) {
  return kind === 'rab' ? 1 : 0
}

function getOutputModeRank(
  kind: 'rab' | 'pencairan_harian' | 'gas' | 'lain_lain'
) {
  if (kind === 'pencairan_harian') return 1
  if (kind === 'gas') return 2
  if (kind === 'lain_lain') return 3
  return 4
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

function isValidSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<SavedWorkspace> & { version?: unknown }
  return (
    (candidate.version === 3 ||
      candidate.version === 4 ||
      candidate.version === 5 ||
      candidate.version === 6) &&
    typeof candidate.kitchenId === 'string' &&
    typeof candidate.activeTransactionId === 'number' &&
    Array.isArray(candidate.transactions) &&
    candidate.transactions.length > 0
  )
}

function readWorkspaceFromStorageKey(key: string): SavedWorkspace | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null

    const parsed = JSON.parse(raw) as unknown
    if (!isValidSavedWorkspace(parsed)) return null

    const hasActiveTransaction = parsed.transactions.some(
      (transaction) => transaction.id === parsed.activeTransactionId
    )

    return {
      version: 6,
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

function readSavedWorkspace(): SavedWorkspace | null {
  return (
    readWorkspaceFromStorageKey(STORAGE_KEY) ??
    PREVIOUS_STORAGE_KEYS.reduce<SavedWorkspace | null>(
      (found, key) => found ?? readWorkspaceFromStorageKey(key),
      null
    )
  )
}

function persistWorkspaceToKey(
  workspace: Omit<SavedWorkspace, 'version'>,
  key: string
) {
  if (typeof window === 'undefined') return

  try {
    const payload: SavedWorkspace = {
      version: 6,
      ...workspace,
      savedAt: Date.now()
    }

    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // localStorage can fail in private/restricted browser contexts.
    // The app continues to work in memory in that case.
  }
}

function persistWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  persistWorkspaceToKey(workspace, STORAGE_KEY)
}

function persistRecoveryWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  persistWorkspaceToKey(workspace, RECOVERY_STORAGE_KEY)
}

function emptySimpleEntry(id = 1): SimpleEntry {
  return {
    id,
    accountId: '',
    amount: '',
    accountNumber: '',
    ownerName: '',
    need: ''
  }
}

function emptyDailyPaymentEntry(
  id = 1,
  category: DailyPaymentCategory = 'sewa'
): DailyPaymentEntry {
  return {
    id,
    category,
    kinds: [],
    bank: '',
    accountNumber: '',
    ownerName: '',
    amount: ''
  }
}

function ensureDailyPaymentCategories(
  entries: DailyPaymentEntry[]
): DailyPaymentEntry[] {
  const next = [...entries]
  let nextId =
    next.length === 0
      ? 1
      : Math.max(...next.map((entry) => entry.id)) + 1

  if (!next.some((entry) => entry.category === 'sewa')) {
    next.push(emptyDailyPaymentEntry(nextId++, 'sewa'))
  }

  if (!next.some((entry) => entry.category === 'gaji')) {
    next.push(emptyDailyPaymentEntry(nextId, 'gaji'))
  }

  return next
}

function normalizeTransaction(
  transaction: TransactionGroup,
  fallbackDate: string
): TransactionGroup {
  return {
    ...transaction,
    date: transaction.date || fallbackDate,
    rab: Array.isArray(transaction.rab) ? transaction.rab : [],
    gas: Array.isArray(transaction.gas)
      ? transaction.gas.map((entry) => ({
          ...entry,
          ownerName: sanitizeOwnerName(entry.ownerName ?? '')
        }))
      : [],
    pencairan_harian: ensureDailyPaymentCategories(
      Array.isArray(transaction.pencairan_harian)
        ? transaction.pencairan_harian.map((entry) => {
            const legacyEntry = entry as DailyPaymentEntry & {
              kind?: DailyPaymentKind
            }
            const legacyKinds = Array.isArray(entry.kinds)
              ? entry.kinds
              : legacyEntry.kind
                ? [legacyEntry.kind]
                : []
            const category: DailyPaymentCategory =
              entry.category ??
              (legacyKinds.some((kind) =>
                DAILY_PAYMENT_GAJI_OPTIONS.includes(kind)
              )
                ? 'gaji'
                : 'sewa')

            return {
              ...entry,
              category,
              kinds: sortDailyPaymentKinds(legacyKinds),
              bank: entry.bank ?? '',
              accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
              ownerName: sanitizeOwnerName(entry.ownerName ?? '')
            }
          })
        : [emptyDailyPaymentEntry(1, 'sewa')]
    ),
    lain_lain: Array.isArray(transaction.lain_lain)
      ? transaction.lain_lain.map((entry) => ({
          ...entry,
          accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
          ownerName: sanitizeOwnerName(entry.ownerName ?? '')
        }))
      : [emptySimpleEntry(1)]
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
        ownerName: '',
        need: ''
      }
    ],
    pencairan_harian: [
      emptyDailyPaymentEntry(1, 'sewa'),
      emptyDailyPaymentEntry(2, 'gaji')
    ],
    lain_lain: [emptySimpleEntry(1)]
  }
}

function App() {
  const saved = useMemo(() => readSavedWorkspace(), [])
  const today = useMemo(() => toIsoDate(new Date()), [])
  const savedTransaction = useMemo(() => {
    if (!saved?.transactions?.length) return null
    return (
      saved.transactions.find(
        (transaction) => transaction.id === saved.activeTransactionId
      ) ?? saved.transactions[0]
    )
  }, [saved])
  const initialTransaction = useMemo(
    () =>
      savedTransaction
        ? normalizeTransaction(savedTransaction, today)
        : null,
    [savedTransaction, today]
  )
  const [masterData, setMasterData] = useState<MakerMasterData | null>(null)
  const [masterLoading, setMasterLoading] = useState(false)
  const [masterError, setMasterError] = useState('')

  const [kitchenId, setKitchenId] = useState(saved?.kitchenId ?? '')
  const [activeTransactionId, setActiveTransactionId] = useState(1)
  const [transactions, setTransactions] = useState<TransactionGroup[]>(
    initialTransaction ? [initialTransaction] : []
  )
  const [copyMessage, setCopyMessage] = useState('')
  const [historyMessage, setHistoryMessage] = useState('')
  const dateInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef({
    kitchenId: saved?.kitchenId ?? '',
    activeTransactionId: 1,
    transactions: initialTransaction ? [initialTransaction] : []
  })

  useEffect(() => {
    if (masterData) return
    void loadMasterData()
  }, [masterData])

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
      window.removeEventListener('pagehide', handleFreeze)
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

    const rabAccountIds = new Set(rabRules.map((rule) => rule.account_id))
    const seen = new Set<string>()

    return masterData.account_rules.filter((rule) => {
      if (rule.kitchen_id !== kitchenId) return false
      if (rule.flow_type !== 'neutral') return false
      if (!rule.accounts) return false
      if (rabAccountIds.has(rule.account_id)) return false
      if (seen.has(rule.account_id)) return false
      seen.add(rule.account_id)
      return true
    })
  }, [masterData, kitchenId, rabRules])

  const activeTransaction =
    transactions.find(
      (transaction) => transaction.id === activeTransactionId
    ) ?? transactions[0]

  useEffect(() => {
    if (!selectedKitchen || !activeTransaction) return

    const entry = activeTransaction.pencairan_harian.find((item) =>
      item.kinds.includes('Sewa SPPG')
    )
    if (!entry) return

    const rental = getSppgRental(selectedKitchen.name)
    if (!rental) return

    if (
      entry.bank === rental.bank &&
      entry.accountNumber === rental.accountNumber &&
      entry.ownerName === rental.ownerName
    ) {
      return
    }

    updateTransaction(activeTransaction.id, {
      pencairan_harian: activeTransaction.pencairan_harian.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              bank: rental.bank,
              accountNumber: rental.accountNumber,
              ownerName: rental.ownerName
            }
          : item
      )
    })
  }, [activeTransaction, selectedKitchen])

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

  function updateDailyPaymentEntry(
    transactionId: number,
    id: number,
    update: Partial<DailyPaymentEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === transactionId
          ? {
              ...transaction,
              pencairan_harian: transaction.pencairan_harian.map((entry) =>
                entry.id === id ? { ...entry, ...update } : entry
              )
            }
          : transaction
      )
    )
  }

  function toggleDailyPaymentKind(
    transactionId: number,
    id: number,
    option: DailyPaymentKind
  ) {
    const transaction = transactions.find((item) => item.id === transactionId)
    const entry = transaction?.pencairan_harian.find((item) => item.id === id)
    if (!entry) return

    const currentKinds = entry.kinds ?? []
    const isSelected = currentKinds.includes(option)
    const isRental = option === 'Sewa SPPG' || option === 'Sewa Kendaraan'
    const optionCategory: DailyPaymentCategory = isRental ? 'sewa' : 'gaji'

    if (entry.category !== optionCategory) return

    if (isRental) {
      if (isSelected) {
        updateDailyPaymentEntry(transactionId, id, {
          kinds: [],
          bank: '',
          accountNumber: '',
          ownerName: ''
        })
        return
      }

      const rental =
        option === 'Sewa SPPG'
          ? getSppgRental(selectedKitchen?.name ?? '')
          : SEWA_KENDARAAN_ACCOUNT

      updateDailyPaymentEntry(transactionId, id, {
        kinds: [option],
        bank: rental?.bank ?? '',
        accountNumber: rental?.accountNumber ?? '',
        ownerName: rental?.ownerName ?? ''
      })
      return
    }

    const nextKinds = isSelected
      ? currentKinds.filter((kind) => kind !== option)
      : [...currentKinds, option]

    updateDailyPaymentEntry(transactionId, id, {
      kinds: sortDailyPaymentKinds(nextKinds)
    })
  }

  function addDailyPaymentEntry(category: DailyPaymentCategory) {
    if (!activeTransaction) return

    const currentEntries = activeTransaction.pencairan_harian
    const nextId =
      currentEntries.length === 0
        ? 1
        : Math.max(...currentEntries.map((entry) => entry.id)) + 1

    updateTransaction(activeTransaction.id, {
      pencairan_harian: [
        ...currentEntries,
        emptyDailyPaymentEntry(nextId, category)
      ]
    })
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
    const rabAccountIds = new Set(nextRabRules.map((rule) => rule.account_id))
    const nextGasRules = rules.filter(
      (rule) =>
        rule.flow_type === 'neutral' && !rabAccountIds.has(rule.account_id)
    )
    const nextTransaction = makeTransaction(
      1,
      activeDate,
      nextRabRules.map((rule) => ({ account_id: rule.account_id })),
      nextGasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      }))
    )

    setTransactions([nextTransaction])
    setActiveTransactionId(1)
  }



  const activeDate = activeTransaction?.date ?? today

  function openDatePicker() {
    const input = dateInputRef.current
    if (!input) return

    const pickerInput = input as HTMLInputElement & {
      showPicker?: () => void
    }

    if (typeof pickerInput.showPicker === 'function') {
      pickerInput.showPicker()
      return
    }

    input.focus()
  }

  function changeActiveDate(nextDate: string) {
    if (!activeTransaction || !nextDate) return
    updateTransaction(activeTransaction.id, { date: nextDate })
    setCopyMessage('')
  }

  function resetWorkspace() {
    persistRecoveryWorkspace({
      kitchenId,
      activeTransactionId,
      transactions
    })

    const nextTransaction = makeTransaction(
      1,
      activeDate,
      sortedRabRules.map((rule) => ({ account_id: rule.account_id })),
      gasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      }))
    )
    setTransactions(nextTransaction.date ? [nextTransaction] : [])
    setActiveTransactionId(1)
    setCopyMessage('')
    setHistoryMessage('Draft browser direset. Snapshot pemulihan disimpan.')
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
      const ownerName = entry.ownerName.trim()
      if (!bank || !accountNumber || !ownerName) continue

      const need = entry.need.trim() || 'Biaya Ops Harian'

      outputs.push({
        bank: getOutputBank(bank),
        line:
          'Lain-lain : ' +
          need +
          ' - ' +
          ownerName +
          ' - ' +
          bank +
          ' / ' +
          accountNumber +
          ' · ' +
          formatNumber(entry.amount),
        kind: 'lain_lain'
      })
    }

    return outputs
  }

  function getTransactionOutput(transaction: TransactionGroup) {
    type OutputItem = {
      kind: 'rab' | 'pencairan_harian' | 'gas' | 'lain_lain'
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

      const accountName = rule.supplier?.business_name || rule.accounts.name
      const outputLine = `${accountName} - ${rule.accounts.bank} / ${rule.accounts.account_number ?? '-'} · ${formatNumber(entry.amount)}`

      items.push({
        kind: 'gas',
        bank: getOutputBank(rule.accounts.bank),
        line: `GAS : ${outputLine}`,
        index: items.length
      })
    }

    for (const entry of transaction.pencairan_harian) {
      if (!isCompleteAmount(entry.amount)) continue

      const bank = entry.bank.trim()
      const accountNumber = entry.accountNumber.trim()
      const ownerName = entry.ownerName.trim()
      const kinds = entry.kinds ?? []
      if (!bank || !accountNumber || !ownerName || kinds.length === 0) continue

      items.push({
        kind: 'pencairan_harian',
        bank: getOutputBank(bank),
        line:
          kinds.join(', ') +
          ' : ' +
          ownerName +
          ' - ' +
          bank +
          ' / ' +
          accountNumber +
          ' · ' +
          formatNumber(entry.amount),
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

      const supplierName = rule.supplier?.business_name ?? rule.accounts.name
      const accountText = `${supplierName} - ${rule.accounts.bank} / ${rule.accounts.account_number ?? '-'}`
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

  const output =
    activeTransaction
      ? getTransactionOutput(activeTransaction).join('\n')
      : ''

  async function copyOutput() {
    if (!output) return

    await navigator.clipboard.writeText(output)
    setCopyMessage('Berhasil disalin.')
    window.setTimeout(() => setCopyMessage(''), 2000)
  }

  function restoreLastDraft() {
    const recovery = readWorkspaceFromStorageKey(RECOVERY_STORAGE_KEY)
    const stored = recovery ?? readSavedWorkspace()

    if (!stored) {
      setHistoryMessage('Belum ada draft tersimpan di browser.')
      window.setTimeout(() => setHistoryMessage(''), 1800)
      return
    }

    const storedTransaction =
      stored.transactions.find(
        (transaction) => transaction.id === stored.activeTransactionId
      ) ?? stored.transactions[0]

    if (!storedTransaction) {
      setHistoryMessage('Belum ada transaksi tersimpan di browser.')
      window.setTimeout(() => setHistoryMessage(''), 1800)
      return
    }

    const transaction = normalizeTransaction(storedTransaction, today)

    setKitchenId(stored.kitchenId)
    setTransactions([transaction])
    setActiveTransactionId(1)
    persistWorkspace({
      kitchenId: stored.kitchenId,
      activeTransactionId: 1,
      transactions: [transaction]
    })

    if (recovery) {
      window.localStorage.removeItem(RECOVERY_STORAGE_KEY)
    }

    setHistoryMessage(
      recovery
        ? 'Draft sebelum Reset dipulihkan untuk hari ini.'
        : 'Draft terakhir dipulihkan untuk hari ini.'
    )
    window.setTimeout(() => setHistoryMessage(''), 1800)
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-950 p-2 text-white sm:p-3 md:p-4">
      <div className="mx-auto w-full max-w-[1280px]">
        <>
          <header className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-50">Maker Pencairan</h1>
              <p className="mt-1 text-sm leading-5 text-slate-300">
                Pencairan harian dengan tanggal fleksibel.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={restoreLastDraft}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
              >
                Pulihkan
              </button>
              <button
                type="button"
                onClick={resetWorkspace}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
              >
                Reset
              </button>
            </div>
          </header>

          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-100">
            Jika rekening tujuan yang dibutuhkan tidak tersedia, silakan hubungi lewat{' '}
            <a
              href="https://wa.me/6285794323042"
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-white"
            >
              WhatsApp
            </a>.
          </div>

          {masterLoading && (
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
              Memuat master data...
            </div>
          )}

          {masterError && (
            <div className="mt-4 rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
              <p>{masterError}</p>
              <button
                type="button"
                onClick={() => void loadMasterData()}
                className="mt-3 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white hover:bg-stone-700"
              >
                Coba Lagi
              </button>
            </div>
          )}

          {masterData && !masterLoading && !masterError && (
            <>
              <div className="sticky top-0 z-30 -mx-3 mt-4 bg-slate-950/90 px-3 pb-3 pt-1 backdrop-blur md:-mx-4 md:px-4">
                <section className="rounded-xl border border-stone-600 bg-slate-900 p-4 shadow-lg">
                  <div className="grid gap-3 lg:grid-cols-[180px_minmax(220px,1fr)] lg:items-end">
                    <div>
                      <label
                        htmlFor="date"
                        className="mb-1 block text-sm font-medium leading-5 text-slate-300"
                      >
                        Tanggal
                      </label>
                      <div className="relative flex h-10 cursor-pointer items-center rounded-lg border border-slate-700 bg-slate-950 px-3 transition hover:border-stone-600 focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500/40">
                        <span className="text-xs font-semibold text-slate-500">
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
                          onChange={(event) => changeActiveDate(event.target.value)}
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
                        className="mb-1 block text-sm font-medium leading-5 text-slate-300"
                      >
                        Dapur
                      </label>
                      <select
                        id="kitchen"
                        value={kitchenId}
                        onChange={(event) =>
                          handleKitchenChange(event.target.value)
                        }
                        className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-semibold text-white outline-none transition hover:border-stone-600 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40"
                      >
                        <option value="">Pilih dapur</option>
                        {masterData.kitchens.map((kitchen) => (
                          <option key={kitchen.id} value={kitchen.id}>
                            {kitchen.name}
                          </option>
                        ))}
                      </select>
                    </div>
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
                        <h2 className="text-sm font-semibold">Output</h2>
                        <p className="mt-1 text-xs leading-5 text-slate-300">
                          Draft otomatis tersimpan di browser. Reset menyimpan
                          snapshot pemulihan. Copy untuk menyalin dan dikirim ke
                          Whatsapp.
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

                    <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
                      {output || 'Belum ada transaksi yang nominalnya terisi.'}
                    </pre>
                  </section>
                )}
              </div>

              {kitchenId && activeTransaction && (
                <>
                  <section className="rounded-xl border border-stone-500 bg-slate-900 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold text-white">RAB</h2>
                        <p className="mt-1 text-xs leading-5 text-slate-300">
                          Rekening RAB hanya keluar ke output jika nominal diisi.
                          Produk yang ditampilkan bisa diklik untuk memilih atau membatalkan pilihan.
                          Produk yang tidak tersedia untuk rekening tersebut tidak ditampilkan.
                        </p>
                      </div>
                    </div>

                    {(() => {
                      const splitIndex = Math.ceil(sortedRabRules.length / 2)
                      const rabLeftRules = sortedRabRules.slice(0, splitIndex)
                      const rabRightRules = sortedRabRules.slice(splitIndex)

                      const renderRabRow = (
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
                            className="grid min-w-0 gap-2 border-b border-slate-800 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-center"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-white">
                                {index + 1}.{' '}
                                {rule.supplier?.business_name ??
                                  rule.accounts?.name ??
                                  'Tanpa nama'}{' '}
                                - {rule.accounts?.bank ?? '-'} (
                                {rule.accounts?.account_number ?? '-'})
                              </div>

                              {products.length > 0 ? (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
                                          'inline-flex h-9 items-center rounded-md border px-2.5 text-xs font-medium transition',
                                          selected
                                            ? 'border-emerald-500 bg-emerald-600 text-white'
                                            : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                                        ].join(' ')}
                                      >
                                        {selected ? '✓ ' : ''}
                                        {product}
                                      </button>
                                    )
                                  })}
                                </div>
                              ) : (
                                <div className="mt-1 text-[11px] text-slate-500">
                                  Tidak ada produk yang bisa dipilih untuk rekening ini.
                                </div>
                              )}
                            </div>

                            <input
                              id={'rab-' + activeTransaction.id + '-' + rule.account_id}
                              type="text"
                              inputMode="numeric"
                              value={formatNumber(entry.amount)}
                              onChange={(event) =>
                                updateRabEntry(
                                  activeTransaction.id,
                                  rule.account_id,
                                  {
                                    amount: event.target.value.replace(/\D/g, '')
                                  }
                                )
                              }
                              placeholder="Nominal"
                              className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                            />
                          </div>
                        )
                      }

                      return (
                        <div className="mt-2 grid grid-cols-1 gap-x-8 lg:grid-cols-2">
                          <div className="min-w-0">
                            {rabLeftRules.map((rule, index) =>
                              renderRabRow(rule, index)
                            )}
                          </div>
                          <div className="min-w-0">
                            {rabRightRules.map((rule, offset) =>
                              renderRabRow(rule, splitIndex + offset)
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </section>


                  {gasRules.length > 0 && (
                    <section className="mt-2 w-full rounded-xl border border-emerald-600/50 bg-emerald-950/10 p-3">
                      <div>
                        <h2 className="text-base font-semibold text-white">GAS</h2>
                        <p className="mt-1 text-xs leading-5 text-slate-300">
                          Isi nominal GAS. Rekening tujuan mengikuti mapping GAS dapur.
                        </p>
                      </div>

                      <div className="mt-2 grid min-w-0 gap-2.5 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-center">
                        {activeTransaction.gas.map((entry) => {
                          const rule =
                            gasRules.find(
                              (item) => item.account_id === entry.accountId
                            ) ?? gasRules[0]

                          return (
                            <div key={entry.id} className="contents">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-white">
                                  {displaySupplierName(rule?.supplier) ||
                                    rule?.accounts?.name ||
                                    'Tanpa nama'}{' '}
                                  - {rule?.accounts?.bank ?? '-'} (
                                  {rule?.accounts?.account_number ?? '-'})
                                </div>
                              </div>

                              <input
                                id={'gas-' + activeTransaction.id + '-' + entry.id}
                                type="text"
                                inputMode="numeric"
                                value={formatNumber(entry.amount)}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'gas',
                                    entry.id,
                                    {
                                      amount: event.target.value.replace(/\D/g, '')
                                    }
                                  )
                                }
                                placeholder="Nominal"
                                aria-label="Nominal GAS"
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                              />
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                  {gasRules.length === 0 && (
                    <div className="mt-2 w-full rounded-lg border border-dashed border-slate-700 p-3 text-sm text-slate-500">
                      Dapur ini tidak memiliki mapping GAS.
                    </div>
                  )}


                  <section className="mt-2 w-full rounded-xl border border-rose-600/60 bg-rose-950/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold">Form Lain-Lain</h2>
                        <p className="mt-1 text-xs leading-5 text-slate-300">
                          Pilih bank, isi nomor rekening, nama pemilik rekening,
                          keperluan, dan nominal.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => addSimpleEntry('lain_lain')}
                        className="h-10 rounded-lg border border-slate-700 bg-slate-800 px-4 text-xs font-semibold transition hover:bg-stone-700"
                      >
                        + Transaksi
                      </button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {activeTransaction.lain_lain.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-rose-800/50 bg-slate-950 p-3"
                        >
                          <div className="grid gap-2 lg:grid-cols-[120px_150px_190px_minmax(0,1fr)_160px] lg:items-end">
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
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-100 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              >
                                <option value="">Pilih Bank</option>
                                {OPERATIONAL_BANKS.map((bank) => (
                                  <option key={bank} value={bank}>
                                    {bank}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <input
                                id={'acc-' + activeTransaction.id + '-lain-' + entry.id}
                                type="text"
                                inputMode="numeric"
                                value={entry.accountNumber}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    {
                                      accountNumber: event.target.value.replace(/\D/g, '')
                                    }
                                  )
                                }
                                placeholder="Nomor rekening"
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>

                            <div>
                              <input
                                id={'owner-' + activeTransaction.id + '-lain-' + entry.id}
                                type="text"
                                value={entry.ownerName}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    {
                                      ownerName: sanitizeOwnerName(
                                        event.target.value
                                      )
                                    }
                                  )
                                }
                                placeholder="Nama pemilik rekening"
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>

                            <div>
                              <input
                                id={'need-' + activeTransaction.id + '-lain-' + entry.id}
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
                                placeholder="Isi dengan keperluan / kosongkan untuk otomatis diisi Ops Harian"
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-600 focus:border-rose-400 focus:ring-1 focus:ring-rose-400/30"
                              />
                            </div>

                            <div>
                              <input
                                id={'amount-' + activeTransaction.id + '-lain-' + entry.id}
                                type="text"
                                inputMode="numeric"
                                value={formatNumber(entry.amount)}
                                onChange={(event) =>
                                  updateSimpleEntry(
                                    activeTransaction.id,
                                    'lain_lain',
                                    entry.id,
                                    {
                                      amount: event.target.value.replace(/\D/g, '')
                                    }
                                  )
                                }
                                placeholder="Nominal"
                                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>


                  <div className="mt-2 space-y-2.5">
                    <section className="w-full rounded-xl border border-sky-600/60 bg-sky-950/10 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold text-white">
                            Pencairan Sewa
                          </h2>
                          <p className="mt-1 text-xs leading-5 text-slate-300">
                            Pilih Sewa SPPG atau Sewa Kendaraan. Rekening sewa akan
                            terisi otomatis sesuai jenis dan mapping. Klik jenis untuk
                            memilih atau membatalkan pilihan.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => addDailyPaymentEntry('sewa')}
                          className="h-10 rounded-lg border border-slate-700 bg-slate-800 px-4 text-xs font-semibold transition hover:bg-slate-700"
                        >
                          + Transaksi
                        </button>
                      </div>

                      <div className="mt-3 space-y-2.5">
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'sewa')
                          .map((entry) => {
                            const isFixedRental = entry.kinds.some(
                              (kind) =>
                                kind === 'Sewa SPPG' || kind === 'Sewa Kendaraan'
                            )

                            return (
                              <div
                                key={entry.id}
                                className="rounded-lg border border-sky-800/50 bg-slate-950 p-3"
                              >
                                <div className="grid items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_130px_155px_190px_160px]">
                                  <div className="min-w-0">
                                    <div className="flex h-full flex-wrap content-center gap-1.5">
                                      {DAILY_PAYMENT_SEWA_OPTIONS.map((option) => {
                                        const selected = entry.kinds.includes(option)

                                        return (
                                          <button
                                            key={option}
                                            type="button"
                                            onClick={() =>
                                              toggleDailyPaymentKind(
                                                activeTransaction.id,
                                                entry.id,
                                                option
                                              )
                                            }
                                            className={[
                                              'inline-flex h-10 items-center rounded-md border px-3 text-sm font-medium transition',
                                              selected
                                                ? 'border-sky-400 bg-sky-600 text-white'
                                                : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-500/60 hover:bg-slate-800'
                                            ].join(' ')}
                                          >
                                            {option}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>

                                  <div className="flex h-full items-center">
                                    {isFixedRental ? (
                                      <div
                                        aria-readonly="true"
                                        className="flex h-10 w-full items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100 shadow-inner"
                                      >
                                        {entry.bank || 'Pilih Bank'}
                                      </div>
                                    ) : (
                                      <div className="flex h-10 w-full items-center rounded-md border border-slate-800 bg-slate-950 px-3 text-sm text-slate-500">
                                        Pilih jenis
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex h-full items-center">
                                    {isFixedRental ? (
                                      <div
                                        aria-readonly="true"
                                        className="flex h-10 w-full items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100 shadow-inner"
                                      >
                                        {entry.accountNumber || 'No. rekening'}
                                      </div>
                                    ) : (
                                      <div className="flex h-10 w-full items-center rounded-md border border-slate-800 bg-slate-950 px-3 text-sm text-slate-500">
                                        Pilih jenis
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex h-full items-center">
                                    {isFixedRental ? (
                                      <div
                                        aria-readonly="true"
                                        className="flex h-10 w-full items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100 shadow-inner"
                                      >
                                        {entry.ownerName || 'Nama pemilik rekening'}
                                      </div>
                                    ) : (
                                      <div className="flex h-10 w-full items-center rounded-md border border-slate-800 bg-slate-950 px-3 text-sm text-slate-500">
                                        Pilih jenis
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex h-full items-center">
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      value={formatNumber(entry.amount)}
                                      onChange={(event) =>
                                        updateDailyPaymentEntry(
                                          activeTransaction.id,
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
                                      className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-sky-400 focus:ring-1 focus:ring-sky-400/30"
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    </section>

                    <section className="w-full rounded-xl border border-violet-600/60 bg-violet-950/10 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold text-white">
                            Pencairan Gaji
                          </h2>
                          <p className="mt-1 text-xs leading-5 text-slate-300">
                            Gaji Relawan, Insentif PIC Sekolah, dan Insentif Kader
                            Posyandu dapat dipilih satu, dua, atau sekaligus tiga.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => addDailyPaymentEntry('gaji')}
                          className="h-10 rounded-lg border border-slate-700 bg-slate-800 px-4 text-xs font-semibold transition hover:bg-slate-700"
                        >
                          + Transaksi
                        </button>
                      </div>

                      <div className="mt-3 space-y-2.5">
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'gaji')
                          .map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-lg border border-violet-800/50 bg-slate-950 p-3"
                            >
                              <div className="grid items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_130px_155px_190px_160px]">
                                <div className="min-w-0">
                                  <div className="flex h-full flex-wrap content-center gap-1.5">
                                    {DAILY_PAYMENT_GAJI_OPTIONS.map((option) => {
                                      const selected = entry.kinds.includes(option)

                                      return (
                                        <button
                                          key={option}
                                          type="button"
                                          onClick={() =>
                                            toggleDailyPaymentKind(
                                              activeTransaction.id,
                                              entry.id,
                                              option
                                            )
                                          }
                                          className={[
                                            'inline-flex h-10 items-center rounded-md border px-3 text-sm font-medium transition',
                                            selected
                                              ? 'border-violet-400 bg-violet-600 text-white'
                                              : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-violet-500/60 hover:bg-slate-800'
                                          ].join(' ')}
                                        >
                                          {option}
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>

                                <div className="flex h-full items-center">
                                  <select
                                    value={entry.bank}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { bank: event.target.value }
                                      )
                                    }
                                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-100 outline-none transition hover:border-stone-600 focus:border-violet-400 focus:ring-1 focus:ring-violet-400/30"
                                  >
                                    <option value="">Pilih Bank</option>
                                    {OPERATIONAL_BANKS.map((bank) => (
                                      <option key={bank} value={bank}>
                                        {bank}
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                <div className="flex h-full items-center">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={entry.accountNumber}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        {
                                          accountNumber: event.target.value.replace(
                                            /\D/g,
                                            ''
                                          )
                                        }
                                      )
                                    }
                                    placeholder="No. rekening"
                                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-600 focus:border-violet-400 focus:ring-1 focus:ring-violet-400/30"
                                  />
                                </div>

                                <div className="flex h-full items-center">
                                  <input
                                    type="text"
                                    value={entry.ownerName}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        {
                                          ownerName: sanitizeOwnerName(
                                            event.target.value
                                          )
                                        }
                                      )
                                    }
                                    placeholder="Nama pemilik rekening"
                                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-600 focus:border-violet-400 focus:ring-1 focus:ring-violet-400/30"
                                  />
                                </div>

                                <div className="flex h-full items-center">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
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
                                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-violet-400 focus:ring-1 focus:ring-violet-400/30"
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    </section>
                  </div>


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
