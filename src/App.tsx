import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getMakerMasterData,
  type MakerMasterData,
  type MakerAccountRule
} from './services/master-data'
import { DateRangePicker } from './DateRangePicker'

type RabEntry = {
  accountId: string
  productTypes: string[]
  amount: string
}

type OtherTransactionType = '' | 'operasional_harian' | 'lain_lain'

type SimpleEntry = {
  id: number
  accountId: string
  amount: string
  accountNumber: string
  ownerName: string
  need: string
  transactionType: OtherTransactionType
}

type DailyPaymentKind =
  | 'Sewa SPPG'
  | 'Sewa Kendaraan'
  | 'Gaji Relawan'
  | 'Insentif PIC Sekolah'
  | 'Insentif PIC Posyandu'

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

type LegacyVehicleRentAmount = {
  startDate: string
  endDate: string
  amount: string
}

type VehicleRentEntry = {
  id: number
  startDate: string
  endDate: string
  mobilAmount: string
  motorAmount: string
  legacyAmounts?: LegacyVehicleRentAmount[]
}

type TransactionGroup = {
  id: number
  date: string
  rab: RabEntry[]
  gas: SimpleEntry[]
  operasional: SimpleEntry[]
  legacy_gaji?: DailyPaymentEntry[]
  pencairan_harian: DailyPaymentEntry[]
  sewa_kendaraan: VehicleRentEntry[]
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

const DAILY_PAYMENT_SEWA_OPTIONS: DailyPaymentKind[] = ['Sewa SPPG']

const DAILY_PAYMENT_GAJI_OPTIONS: DailyPaymentKind[] = [
  'Gaji Relawan',
  'Insentif PIC Sekolah',
  'Insentif PIC Posyandu'
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
    ownerName: 'Yusgar Anggara Dinata',
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

type BankAccountMapping = {
  ownerName: string
  bank: string
  accountNumber: string
}

const OPERATIONAL_HARIAN_BY_KITCHEN: Record<string, BankAccountMapping> = {
  Campakamulya: { ownerName: 'Melan Fitriani', bank: 'BNI', accountNumber: '2035516850' },
  Cihaur: { ownerName: 'Rizki Ginanjar', bank: 'BRI', accountNumber: '010501136046504' },
  Cikondang: { ownerName: 'Annisa Wulan Dari', bank: 'BNI', accountNumber: '2044709294' },
  Cipetir: { ownerName: 'Fairuz Hibatullah', bank: 'SEABANK', accountNumber: '901222967962' },
  Cisepat: { ownerName: 'Lia Ariska', bank: 'BNI', accountNumber: '1688603689' },
  Kertajadi: { ownerName: 'Rachmat Surya', bank: 'BRI', accountNumber: '407701032673505' }
}

const GAJI_ACCOUNT_BY_KITCHEN: Record<
  string,
  Partial<Record<DailyPaymentKind, BankAccountMapping>>
> = {
  Campakamulya: {
    'Gaji Relawan': { ownerName: 'Melan Fitriani', bank: 'BNI', accountNumber: '2035516850' },
    'Insentif PIC Sekolah': { ownerName: 'Melan Fitriani', bank: 'BNI', accountNumber: '2035516850' },
    'Insentif PIC Posyandu': { ownerName: 'Melan Fitriani', bank: 'BNI', accountNumber: '2035516850' }
  },
  Cihaur: {
    'Gaji Relawan': { ownerName: 'Taufik Hidayat', bank: 'BRI', accountNumber: '407701030044506' },
    'Insentif PIC Sekolah': { ownerName: 'Taufik Hidayat', bank: 'BRI', accountNumber: '407701030044506' },
    'Insentif PIC Posyandu': { ownerName: 'Taufik Hidayat', bank: 'BRI', accountNumber: '407701030044506' }
  },
  Cikondang: {
    'Gaji Relawan': { ownerName: 'Annisa Wulan Dari', bank: 'BNI', accountNumber: '2044709294' },
    'Insentif PIC Sekolah': { ownerName: 'Annisa Wulan Dari', bank: 'BNI', accountNumber: '2044709294' },
    'Insentif PIC Posyandu': { ownerName: 'Annisa Wulan Dari', bank: 'BNI', accountNumber: '2044709294' }
  },
  Cipetir: {
    'Gaji Relawan': { ownerName: 'Yusgar Anggara Dinata', bank: 'BRI', accountNumber: '1820018916205' },
    'Insentif PIC Sekolah': { ownerName: 'Yusgar Anggara Dinata', bank: 'BRI', accountNumber: '1820018916205' },
    'Insentif PIC Posyandu': { ownerName: 'Yusgar Anggara Dinata', bank: 'BRI', accountNumber: '1820018916205' }
  },
  Cisepat: {
    'Gaji Relawan': { ownerName: 'Robi Sulaeman', bank: 'BNI', accountNumber: '2025279933' },
    'Insentif PIC Sekolah': { ownerName: 'Robi Sulaeman', bank: 'BNI', accountNumber: '2025279933' },
    'Insentif PIC Posyandu': { ownerName: 'Robi Sulaeman', bank: 'BNI', accountNumber: '2025279933' }
  },
  Kertajadi: {
    'Gaji Relawan': { ownerName: 'Rachmat Surya', bank: 'BRI', accountNumber: '407701032673505' },
    'Insentif PIC Sekolah': { ownerName: 'Rachmat Surya', bank: 'BRI', accountNumber: '407701032673505' },
    'Insentif PIC Posyandu': { ownerName: 'Rachmat Surya', bank: 'BRI', accountNumber: '407701032673505' }
  },
  Sukaraja: {
    'Gaji Relawan': { ownerName: 'Ade Rohmat Hidayat', bank: 'BRI', accountNumber: '010501002303563' },
    'Insentif PIC Sekolah': { ownerName: 'Riri Risa Amelia', bank: 'BRI', accountNumber: '406701011792501' },
    'Insentif PIC Posyandu': { ownerName: 'Riri Risa Amelia', bank: 'BRI', accountNumber: '406701011792501' }
  }
}

function getOperationalAccount(kitchenName: string): BankAccountMapping | null {
  return OPERATIONAL_HARIAN_BY_KITCHEN[kitchenName] ?? null
}

function getDailyPaymentAccount(kitchenName: string, kind: DailyPaymentKind): BankAccountMapping | null {
  return GAJI_ACCOUNT_BY_KITCHEN[kitchenName]?.[kind] ?? null
}

function sameAccount(left: BankAccountMapping, right: BankAccountMapping) {
  return left.bank === right.bank &&
    left.accountNumber === right.accountNumber &&
    left.ownerName === right.ownerName
}

function getDailyPaymentMappingForKinds(kitchenName: string, kinds: DailyPaymentKind[]): BankAccountMapping | null {
  if (kinds.length === 0) return null
  const mappings = kinds.map((kind) => getDailyPaymentAccount(kitchenName, kind))
  if (mappings.some((mapping) => !mapping)) return null
  const first = mappings[0]
  if (!first) return null
  return mappings.every((mapping) => mapping && sameAccount(first, mapping)) ? first : null
}

function getDailyPaymentTargetKey(kitchenName: string, kind: DailyPaymentKind) {
  const mapping = getDailyPaymentAccount(kitchenName, kind)
  return mapping ? mapping.bank + '|' + mapping.accountNumber + '|' + mapping.ownerName : 'manual'
}

function areDailyPaymentKindsCompatible(kitchenName: string, kinds: DailyPaymentKind[]) {
  return new Set(kinds.map((kind) => getDailyPaymentTargetKey(kitchenName, kind))).size <= 1
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
  kind:
    | 'rab'
    | 'operasional_harian'
    | 'pencairan_harian'
    | 'sewa_kendaraan'
    | 'gas'
    | 'lain_lain'
) {
  if (kind === 'rab') return 0
  if (kind === 'operasional_harian') return 1
  if (kind === 'pencairan_harian' || kind === 'sewa_kendaraan') return 2
  if (kind === 'gas') return 3
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
    need: '',
    transactionType: ''
  }
}

function emptyOtherEntry(id = 1): SimpleEntry {
  return { ...emptySimpleEntry(id), transactionType: 'lain_lain' }
}

function emptyDailyPaymentEntry(
  id = 1,
  category: DailyPaymentCategory = 'sewa'
): DailyPaymentEntry {
  return {
    id,
    category,
    kinds: category === 'sewa' ? ['Sewa SPPG'] : [],
    bank: '',
    accountNumber: '',
    ownerName: '',
    amount: ''
  }
}

function emptyVehicleRentEntry(id = 1): VehicleRentEntry {
  return {
    id,
    startDate: '',
    endDate: '',
    mobilAmount: '',
    motorAmount: '',
    legacyAmounts: []
  }
}

function createPayrollEntry(
  id: number,
  kitchenName: string,
  kinds: DailyPaymentKind[],
  amount = ''
): DailyPaymentEntry {
  const mapping = getDailyPaymentMappingForKinds(kitchenName, kinds)
  return {
    id,
    category: 'gaji',
    kinds: sortDailyPaymentKinds(kinds),
    bank: mapping?.bank ?? '',
    accountNumber: mapping?.accountNumber ?? '',
    ownerName: mapping?.ownerName ?? '',
    amount
  }
}

function createPayrollRowsForKitchen(kitchenName: string, startId = 2) {
  if (kitchenName === 'Campakamulya') {
    return [
      createPayrollEntry(startId, kitchenName, [...DAILY_PAYMENT_GAJI_OPTIONS])
    ]
  }

  return DAILY_PAYMENT_GAJI_OPTIONS.map((kind, index) =>
    createPayrollEntry(startId + index, kitchenName, [kind])
  )
}

function getPayrollStructure(
  currentPayments: DailyPaymentEntry[],
  kitchenName: string,
  currentLegacy: DailyPaymentEntry[] = []
): { payments: DailyPaymentEntry[]; legacy: DailyPaymentEntry[] } {
  const sewaRows = currentPayments.filter((entry) => entry.category === 'sewa')
  const gajiRows = currentPayments.filter((entry) => entry.category === 'gaji')
  const nextId =
    Math.max(1, ...currentPayments.map((entry) => entry.id), ...currentLegacy.map((entry) => entry.id)) + 1

  if (kitchenName === 'Campakamulya') {
    const combined = gajiRows.find((entry) =>
      DAILY_PAYMENT_GAJI_OPTIONS.every((kind) => entry.kinds.includes(kind))
    )
    const amountsToCombine = gajiRows.map((entry) => entry.amount)
    const combinedAmount = String(
      amountsToCombine.reduce(
        (total, value) => total + Number((value ?? '').replace(/\\D/g, '')),
        0
      ) || ''
    )
    const target = createPayrollEntry(
      combined?.id ?? nextId,
      kitchenName,
      [...DAILY_PAYMENT_GAJI_OPTIONS],
      combinedAmount
    )
    return {
      payments: [...sewaRows, target],
      legacy: []
    }
  }

  const groupedLegacy = gajiRows.filter(
    (entry) =>
      (entry.kinds ?? []).length !== 1 &&
      isCompleteAmount(entry.amount)
  )
  const legacyMap = new Map<string, DailyPaymentEntry>()
  for (const entry of [...currentLegacy, ...groupedLegacy]) {
    const key = [entry.id, entry.kinds.join('|'), entry.amount].join(':')
    legacyMap.set(key, entry)
  }

  const perKindRows = DAILY_PAYMENT_GAJI_OPTIONS.map((kind, index) => {
    const matchingEntries = gajiRows.filter(
      (entry) => entry.kinds.length === 1 && entry.kinds[0] === kind
    )
    const amountTotal = matchingEntries.reduce(
      (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
      0
    )
    return createPayrollEntry(
      matchingEntries[0]?.id ?? nextId + index,
      kitchenName,
      [kind],
      String(amountTotal || '')
    )
  })

  return {
    payments: [...sewaRows, ...perKindRows],
    legacy: [...legacyMap.values()]
  }
}

function createOperationalEntry(id = 1): SimpleEntry {
  return {
    ...emptySimpleEntry(id),
    transactionType: 'operasional_harian',
    need: 'Ops Harian'
  }
}

function normalizeTransaction(
  transaction: TransactionGroup,
  fallbackDate: string
): TransactionGroup {
  const rawDailyPayments = Array.isArray(transaction.pencairan_harian)
    ? transaction.pencairan_harian.map((entry) => {
        const legacyEntry = entry as DailyPaymentEntry & { kind?: DailyPaymentKind }
        const storedKinds = Array.isArray(entry.kinds)
          ? entry.kinds
          : legacyEntry.kind
            ? [legacyEntry.kind]
            : []
        // Keep drafts made before the label change working as expected.
        const legacyKinds: DailyPaymentKind[] = storedKinds.map((kind) =>
          String(kind) === 'Insentif Kader Posyandu'
            ? 'Insentif PIC Posyandu'
            : kind
        )
        const category: DailyPaymentCategory =
          entry.category ??
          (legacyKinds.some((kind) => DAILY_PAYMENT_GAJI_OPTIONS.includes(kind))
            ? 'gaji'
            : 'sewa')

        return {
          ...entry,
          category,
          kinds: sortDailyPaymentKinds(legacyKinds),
          bank: entry.bank ?? '',
          accountNumber: (entry.accountNumber ?? '').replace(/\\D/g, ''),
          ownerName: sanitizeOwnerName(entry.ownerName ?? '')
        }
      })
    : [emptyDailyPaymentEntry(1, 'sewa')]

  const legacyVehicleFromDaily: LegacyVehicleRentAmount[] = rawDailyPayments
    .filter(
      (entry) =>
        entry.category === 'sewa' &&
        entry.kinds.includes('Sewa Kendaraan') &&
        isCompleteAmount(entry.amount)
    )
    .map((entry) => ({
      startDate: '',
      endDate: '',
      amount: entry.amount
    }))
  const sewaRows = rawDailyPayments.filter(
    (entry) =>
      entry.category === 'sewa' &&
      !entry.kinds.includes('Sewa Kendaraan')
  )
  const sewaTemplate = sewaRows[0] ?? emptyDailyPaymentEntry(1, 'sewa')
  const sewaTotal = sewaRows.reduce(
    (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
    0
  )
  const normalizedSewa: DailyPaymentEntry[] = [{
    ...sewaTemplate,
    category: 'sewa',
    kinds: ['Sewa SPPG'],
    amount: String(sewaTotal || '')
  }]

  const rawVehicleEntries = Array.isArray(transaction.sewa_kendaraan)
    ? (transaction.sewa_kendaraan as unknown as Array<VehicleRentEntry & { amount?: string }>)
    : []
  const firstVehicle = rawVehicleEntries[0]
  const legacyVehicleAmounts: LegacyVehicleRentAmount[] = [
    ...legacyVehicleFromDaily,
    ...rawVehicleEntries.flatMap((entry) => {
    const legacy = [...(entry.legacyAmounts ?? [])]
    const oldAmount = entry.amount
    if (
      typeof oldAmount === 'string' &&
      isCompleteAmount(oldAmount) &&
      !entry.mobilAmount &&
      !entry.motorAmount
    ) {
      legacy.push({
        startDate: entry.startDate ?? '',
        endDate: entry.endDate ?? '',
        amount: oldAmount
      })
    }
    return legacy
    })
  ]
  const normalizedVehicle: VehicleRentEntry[] = [{
    id: firstVehicle?.id ?? 1,
    startDate: firstVehicle?.startDate ?? legacyVehicleAmounts[0]?.startDate ?? '',
    endDate: firstVehicle?.endDate ?? legacyVehicleAmounts[0]?.endDate ?? '',
    mobilAmount: firstVehicle?.mobilAmount ?? '',
    motorAmount: firstVehicle?.motorAmount ?? '',
    legacyAmounts: legacyVehicleAmounts
  }]

  const normalizedGas: SimpleEntry[] = Array.isArray(transaction.gas)
    ? transaction.gas.map((entry) => ({
        ...entry,
        ownerName: sanitizeOwnerName(entry.ownerName ?? ''),
        transactionType: entry.transactionType ?? ''
      }))
    : [{
        ...emptySimpleEntry(1),
        accountId: '',
        accountNumber: '',
        ownerName: '',
        amount: '',
        need: '',
        transactionType: '' as const
      }]

  const normalizedOthers = Array.isArray(transaction.lain_lain)
    ? transaction.lain_lain.map((entry) => ({
        ...entry,
        transactionType: entry.transactionType === 'operasional_harian'
          ? 'operasional_harian' as const
          : 'lain_lain' as const,
        accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
        ownerName: sanitizeOwnerName(entry.ownerName ?? '')
      }))
    : [emptyOtherEntry(1)]

  const legacyOps = normalizedOthers.filter((entry) => entry.transactionType === 'operasional_harian')
  const existingOps = Array.isArray(transaction.operasional) ? transaction.operasional : []
  const operationalSource = existingOps.length > 0 ? existingOps : legacyOps
  const operationalFirst = operationalSource[0] ?? createOperationalEntry()
  const oldOpsTotal = operationalSource.reduce(
    (total, entry) => total + Number((entry.amount ?? '').replace(/\\D/g, '')),
    0
  )
  const operational = [{
    ...createOperationalEntry(operationalFirst.id),
    ...operationalFirst,
    transactionType: 'operasional_harian' as const,
    amount: String(oldOpsTotal || operationalFirst.amount || '')
  }]
  const lain_lain = normalizedOthers.filter((entry) => entry.transactionType !== 'operasional_harian')
  const legacyGaji = Array.isArray(transaction.legacy_gaji)
    ? transaction.legacy_gaji.map((entry) => ({
        ...entry,
        kinds: (entry.kinds ?? []).map((kind) =>
          String(kind) === 'Insentif Kader Posyandu'
            ? 'Insentif PIC Posyandu'
            : kind
        )
      }))
    : []

  return {
    ...transaction,
    date: transaction.date || fallbackDate,
    rab: Array.isArray(transaction.rab) ? transaction.rab : [],
    gas: normalizedGas,
    operasional: operational,
    pencairan_harian: normalizedSewa.concat(
      rawDailyPayments.filter((entry) => entry.category === 'gaji')
    ),
    sewa_kendaraan: normalizedVehicle,
    lain_lain: lain_lain.length > 0 ? lain_lain : [emptySimpleEntry(1)],
    legacy_gaji: legacyGaji
  }
}

function makeTransaction(
  id: number,
  date: string,
  rabRules: Array<{ account_id: string }>,
  gasRules: Array<{
    account_id: string
    accounts: { account_number: string | null } | null
  }>,
  kitchenName = ''
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
        need: '',
        transactionType: ''
      }
    ],
    operasional: [createOperationalEntry(1)],
    pencairan_harian: [
      { ...emptyDailyPaymentEntry(1, 'sewa'), kinds: ['Sewa SPPG'] },
      ...createPayrollRowsForKitchen(kitchenName, 2)
    ],
    sewa_kendaraan: [emptyVehicleRentEntry(1)],
    lain_lain: [emptyOtherEntry(1)],
    legacy_gaji: []
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

  useEffect(() => {
    if (!selectedKitchen || !activeTransaction) return

    const structure = getPayrollStructure(
      activeTransaction.pencairan_harian,
      selectedKitchen.name,
      activeTransaction.legacy_gaji ?? []
    )
    if (
      JSON.stringify(structure.payments) === JSON.stringify(activeTransaction.pencairan_harian) &&
      JSON.stringify(structure.legacy) === JSON.stringify(activeTransaction.legacy_gaji ?? [])
    ) {
      return
    }

    updateTransaction(activeTransaction.id, {
      pencairan_harian: structure.payments,
      legacy_gaji: structure.legacy
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
    section: 'gas' | 'operasional' | 'lain_lain',
    id: number,
    update: Partial<SimpleEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) => {
        if (transaction.id !== transactionId) return transaction
        const entries = transaction[section] ?? []
        return {
          ...transaction,
          [section]: entries.map((entry) =>
            entry.id === id ? { ...entry, ...update } : entry
          )
        }
      })
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

  function updateVehicleRentEntry(
    transactionId: number,
    id: number,
    update: Partial<VehicleRentEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === transactionId
          ? {
              ...transaction,
              sewa_kendaraan: (transaction.sewa_kendaraan ?? []).map((entry) =>
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
      [section]: [...currentEntries, emptyOtherEntry(nextId)]
    })
  }

  function toggleRabProduct(
    transactionId: number,
    accountId: string,
    productType: string
  ) {
    const transaction = transactions.find((item) => item.id === transactionId)
    if (!transaction) return

    // Be resilient to older drafts or incomplete transaction rows. If this
    // account has no RAB entry yet, updateRabEntry will create one on demand.
    const entry = transaction.rab.find((item) => item.accountId === accountId)
    const currentProducts = entry?.productTypes ?? []
    const exists = currentProducts.includes(productType)

    updateRabEntry(transactionId, accountId, {
      productTypes: sortStrings(
        exists
          ? currentProducts.filter((item) => item !== productType)
          : [...currentProducts, productType]
      )
    })
  }

  function getKitchenRulesFor(kitchen: string): MakerAccountRule[] {
    if (!masterData) return []

    const seen = new Set<string>()
    return masterData.account_rules.filter((rule) => {
      if (rule.kitchen_id !== kitchen) return false
      if (!rule.accounts || !rule.supplier) return false

      // One account can legitimately appear under more than one flow type.
      // Deduplicate within Income/Neutral, not across both, or the Income RAB
      // entry can disappear if the Neutral row is encountered first.
      const ruleKey = rule.flow_type + ':' + rule.account_id
      if (seen.has(ruleKey)) return false
      seen.add(ruleKey)
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
    const nextGasRules = rules.filter(
      (rule) => rule.flow_type === 'neutral'
    )
    const nextKitchenName =
      masterData?.kitchens.find((kitchen) => kitchen.id === nextKitchenId)?.name ?? ''
    const nextTransaction = makeTransaction(
      1,
      activeDate,
      nextRabRules.map((rule) => ({ account_id: rule.account_id })),
      nextGasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      })),
      nextKitchenName
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
      })),
      selectedKitchen?.name ?? ''
    )
    setTransactions(nextTransaction.date ? [nextTransaction] : [])
    setActiveTransactionId(1)
    setCopyMessage('')
    setHistoryMessage('Data direset. Data sebelumnya bisa dipulihkan.')
    window.setTimeout(() => setHistoryMessage(''), 1800)
  }

  function getSimpleOutputs(transaction: TransactionGroup): Array<{
    bank: string
    line: string
    kind: 'operasional_harian' | 'lain_lain'
  }> {
    const outputs: Array<{
      bank: string
      line: string
      kind: 'operasional_harian' | 'lain_lain'
    }> = []
    const kitchenName = selectedKitchen?.name ?? ''

    const operationalEntry = transaction.operasional?.[0]
    if (operationalEntry && isCompleteAmount(operationalEntry.amount)) {
      const mapping = getOperationalAccount(kitchenName)
      const bank = getOutputBank(mapping?.bank ?? operationalEntry.accountId)
      const accountNumber = (mapping?.accountNumber ?? operationalEntry.accountNumber).trim()
      const ownerName = (mapping?.ownerName ?? operationalEntry.ownerName).trim()

      if (bank && accountNumber && ownerName) {
        outputs.push({
          bank,
          line:
            'Ops Harian : ' +
            ownerName +
            ' - ' +
            bank +
            ' / ' +
            accountNumber +
            ' · ' +
            formatNumber(operationalEntry.amount),
          kind: 'operasional_harian'
        })
      }
    }

    for (const entry of transaction.lain_lain) {
      if (entry.transactionType !== 'lain_lain' || !isCompleteAmount(entry.amount)) continue

      const bank = getOutputBank(entry.accountId)
      const accountNumber = entry.accountNumber.trim()
      const ownerName = entry.ownerName.trim()
      if (!bank || !accountNumber || !ownerName) continue

      outputs.push({
        bank,
        line:
          'Lain-lain : ' +
          (entry.need.trim() || 'Biaya Ops Harian') +
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
      kind:
        | 'rab'
        | 'pencairan_harian'
        | 'sewa_kendaraan'
        | 'gas'
        | 'operasional_harian'
        | 'lain_lain'
      bank: string
      line: string
      index: number
      modeRank: number
    }

    const items: OutputItem[] = []
    const kitchenName = selectedKitchen?.name ?? ''
    const preferredBank = getPreferredBank(kitchenName)

    for (const entry of transaction.gas) {
      if (!isCompleteAmount(entry.amount)) continue
      const rule =
        gasRules.find((item) => item.account_id === entry.accountId) ??
        gasRules[0]
      if (!rule?.accounts) continue

      const accountName = rule.supplier?.business_name || rule.accounts.name
      const outputLine =
        accountName +
        ' - ' +
        rule.accounts.bank +
        ' / ' +
        (rule.accounts.account_number ?? '-') +
        ' · ' +
        formatNumber(entry.amount)

      items.push({
        kind: 'gas',
        bank: getOutputBank(rule.accounts.bank),
        line: 'GAS : ' + outputLine,
        index: items.length,
        modeRank: 0
      })
    }

    for (const entry of transaction.pencairan_harian) {
      if (!isCompleteAmount(entry.amount)) continue

      if (entry.category === 'sewa') {
        const rental = getSppgRental(kitchenName)
        if (!rental) continue

        items.push({
          kind: 'pencairan_harian',
          bank: getOutputBank(rental.bank),
          line:
            'Sewa SPPG : ' +
            rental.ownerName +
            ' - ' +
            rental.bank +
            ' / ' +
            rental.accountNumber +
            ' · ' +
            formatNumber(entry.amount),
          index: items.length,
          modeRank: 0
        })
        continue
      }

      const kinds = entry.kinds ?? []
      if (kinds.length === 0) continue
      if (!areDailyPaymentKindsCompatible(kitchenName, kinds)) continue

      const mappedAccount = getDailyPaymentMappingForKinds(kitchenName, kinds)
      const bank = getOutputBank(mappedAccount?.bank ?? entry.bank)
      const accountNumber = (mappedAccount?.accountNumber ?? entry.accountNumber).trim()
      const ownerName = (mappedAccount?.ownerName ?? entry.ownerName).trim()
      if (!bank || !accountNumber || !ownerName) continue

      items.push({
        kind: 'pencairan_harian',
        bank,
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
        index: items.length,
        modeRank: 1
      })
    }

    for (const entry of (transaction.sewa_kendaraan ?? []).slice(0, 1)) {
      if (
        !entry.startDate ||
        !entry.endDate ||
        entry.endDate < entry.startDate
      ) {
        continue
      }

      const account = SEWA_KENDARAAN_ACCOUNT
      const period = formatDate(entry.startDate) + ' – ' + formatDate(entry.endDate)
      const vehicleAmounts: Array<{ label: string; amount: string }> = [
        { label: 'Mobil', amount: entry.mobilAmount },
        { label: 'Motor', amount: entry.motorAmount }
      ]

      for (const vehicle of vehicleAmounts) {
        if (!isCompleteAmount(vehicle.amount)) continue
        items.push({
          kind: 'sewa_kendaraan',
          bank: getOutputBank(account.bank),
          line:
            'Sewa Kendaraan ' +
            vehicle.label +
            ' (' +
            period +
            ') : ' +
            account.ownerName +
            ' - ' +
            account.bank +
            ' / ' +
            account.accountNumber +
            ' · ' +
            formatNumber(vehicle.amount),
          index: items.length,
          modeRank: 0
        })
      }
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
      const accountText =
        supplierName +
        ' - ' +
        rule.accounts.bank +
        ' / ' +
        (rule.accounts.account_number ?? '-')
      const amountText = formatNumber(entry.amount) || '0'
      const outputLine = hasProduct
        ? accountText + ' · ' + productText + ' · ' + amountText
        : accountText + ' · ' + amountText

      items.push({
        kind: 'rab',
        bank: getOutputBank(rule.accounts.bank),
        line: 'RAB : ' + outputLine,
        index: items.length,
        modeRank: 0
      })
    }

    for (const output of getSimpleOutputs(transaction)) {
      items.push({
        kind: output.kind,
        bank: output.bank,
        line: output.line,
        index: items.length,
        modeRank: 0
      })
    }

    items.sort((a, b) => {
      const aPreferred = a.bank === preferredBank ? 0 : 1
      const bPreferred = b.bank === preferredBank ? 0 : 1
      if (aPreferred !== bPreferred) return aPreferred - bPreferred

      // First group every transaction by bank; primary bank always leads.
      const bankCompare = a.bank.localeCompare(b.bank, 'id', {
        sensitivity: 'base'
      })
      if (bankCompare !== 0) return bankCompare

      // Inside a bank: RAB, Ops Harian, Sewa/Gaji, GAS, then Lain-Lain.
      const aCategory = getOutputCategoryRank(a.kind)
      const bCategory = getOutputCategoryRank(b.kind)
      if (aCategory !== bCategory) return aCategory - bCategory

      if (a.modeRank !== b.modeRank) return a.modeRank - b.modeRank
      return a.index - b.index
    })

    if (items.length === 0) return []

    return [
      kitchenName + ', ' + formatDate(transaction.date),
      ...items.map((item) => item.line)
    ]
  }

  const output =
    activeTransaction
      ? getTransactionOutput(activeTransaction).join('\n')
      : ''
  const outputLineCount = output ? Math.max(0, output.split('\n').length - 1) : 0

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
      setHistoryMessage('Belum ada data tersimpan di browser.')
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
        ? 'Data sebelum reset berhasil dipulihkan.'
        : 'Data terakhir berhasil dipulihkan.'
    )
    window.setTimeout(() => setHistoryMessage(''), 1800)
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen overflow-x-clip bg-slate-950 p-2 text-white sm:p-3 md:p-4">
      <div className="mx-auto w-full max-w-[1220px]">
        <>
          <header className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-50">Maker Pencairan</h1>
              <p className="mt-1 text-sm leading-5 text-slate-300">
                Isi semua nominal yang dibutuhkan di sini. Setelah itu, klik Copy pada output dan kirim ke Maker lewat WhatsApp.
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
            Kalau rekening tujuan belum tersedia atau ada perubahan rekening, kabari lewat{' '}
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
              <div className="mt-3 grid w-full min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(330px,370px)] xl:items-start">
                {kitchenId && activeTransaction && (
                  <aside className="sticky top-2 z-20 min-w-0 self-start xl:col-start-2 xl:row-start-1 xl:top-3">
                    <section className="rounded-xl border border-emerald-700/60 bg-emerald-950/20 p-3 shadow-lg">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-sm font-semibold">Output</h2>
                            <span
                              className={[
                                'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                                outputLineCount > 0
                                  ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                                  : 'border-slate-700 bg-slate-900 text-slate-300'
                              ].join(' ')}
                            >
                              {outputLineCount > 0
                                ? outputLineCount + ' baris siap disalin'
                                : 'Belum ada nominal masuk output'}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-slate-300">
                            {outputLineCount > 0
                              ? 'Cek lagi rekening dan nominalnya sebelum disalin.'
                              : 'Isi nominal di form. Baris yang sudah memenuhi syarat akan muncul di sini.'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void copyOutput()}
                          disabled={!output}
                          className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {copyMessage || 'Copy'}
                        </button>
                      </div>

                      <pre className="mt-2 max-h-[18vh] min-h-[52px] overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-200 xl:max-h-[calc(100vh-10rem)]">
                        {output || 'Belum ada nominal yang diisi. Isi nominal yang diperlukan, nanti hasilnya muncul di sini.'}
                      </pre>
                    </section>
                  </aside>
                )}
                <div className="min-w-0 xl:col-start-1 xl:row-start-1">
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
                <>
                  <section className="mt-3 w-full min-w-0 rounded-xl border border-stone-500 bg-slate-900 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold text-white">RAB</h2>
                        <p className="mt-1 text-xs leading-5 text-slate-300">
                          Isi nominal untuk rekening yang dipakai. Jenis produk boleh dipilih kalau diperlukan; kalau tidak, kosongkan saja.
                        </p>
                      </div>
                    </div>

                    {(() => {
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
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_108px] items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 sm:grid-cols-[minmax(0,1fr)_145px] sm:gap-3"
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
                        <div className="mt-2 space-y-2">
                          {sortedRabRules.map((rule, index) =>
                            renderRabRow(rule, index)
                          )}
                        </div>
                      )
                    })()}
                  </section>


                  {gasRules.length > 0 && (
                    <section className="mt-3 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900/40 p-3">
                      <h2 className="text-base font-semibold text-white">GAS</h2>

                      <div className="mt-3 grid min-w-0 gap-2.5 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-center">
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

                  <section className="mt-3 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900/40 p-3">
                    <h2 className="text-base font-semibold text-white">Ops Harian</h2>
                    {(() => {
                      const mapping = getOperationalAccount(selectedKitchen?.name ?? '')
                      const entry = activeTransaction.operasional[0] ?? createOperationalEntry()
                      return (
                        <div className="mt-3 grid min-w-0 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_100px_minmax(145px,0.9fr)_145px]">
                          <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                            <span className="truncate">{mapping?.ownerName ?? 'Mapping belum tersedia'}</span>
                          </div>
                          <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                            {mapping?.bank ?? '-'}
                          </div>
                          <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                            <span className="truncate">{mapping?.accountNumber ?? '-'}</span>
                          </div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={formatNumber(entry.amount)}
                            disabled={!mapping}
                            onChange={(event) =>
                              updateSimpleEntry(
                                activeTransaction.id,
                                'operasional',
                                entry.id,
                                { amount: event.target.value.replace(/\D/g, '') }
                              )
                            }
                            placeholder="Nominal"
                            aria-label="Nominal Ops Harian"
                            className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        </div>
                      )
                    })()}
                  </section>


                  <div className="mt-3 w-full min-w-0 space-y-3">
                    <section className="w-full min-w-0 rounded-xl border border-sky-600/60 bg-sky-950/10 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Sewa SPPG</h2>
                      <div className="mt-3 space-y-2.5">
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'sewa')
                          .map((entry) => {
                            const rental = getSppgRental(selectedKitchen?.name ?? '')
                            return (
                              <div
                                key={entry.id}
                                className="grid min-w-0 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_100px_minmax(145px,0.9fr)_145px]"
                              >
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    <span className="truncate">{rental?.ownerName ?? 'Mapping belum tersedia'}</span>
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    {rental?.bank ?? '-'}
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    <span className="truncate">{rental?.accountNumber ?? '-'}</span>
                                  </div>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!rental}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { amount: event.target.value.replace(/\D/g, '') }
                                      )
                                    }
                                    placeholder="Nominal"
                                    aria-label="Nominal Sewa SPPG"
                                    className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30 disabled:cursor-not-allowed disabled:opacity-50"
                                  />
                              </div>
                            )
                          })}
                      </div>
                    </section>

                    <section className="w-full min-w-0 rounded-xl border border-slate-600 bg-slate-900/40 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Sewa Kendaraan</h2>
                      {(() => {
                        const entry = activeTransaction.sewa_kendaraan?.[0] ?? emptyVehicleRentEntry()
                        return (
                          <>
                            <div className="mt-3 grid min-w-0 items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_105px_minmax(145px,0.8fr)_minmax(230px,1fr)]">
                              <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                <span className="truncate">{SEWA_KENDARAAN_ACCOUNT.ownerName}</span>
                              </div>
                              <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                {SEWA_KENDARAAN_ACCOUNT.bank}
                              </div>
                              <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                <span className="truncate">{SEWA_KENDARAAN_ACCOUNT.accountNumber}</span>
                              </div>
                              <DateRangePicker
                                value={{ startDate: entry.startDate, endDate: entry.endDate }}
                                onChange={(range) =>
                                  updateVehicleRentEntry(activeTransaction.id, entry.id, {
                                    startDate: range.startDate,
                                    endDate: range.endDate
                                  })
                                }
                                placeholder="Pilih rentang tanggal"
                              />
                            </div>

                            {entry.legacyAmounts && entry.legacyAmounts.length > 0 && (
                              <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-xs leading-5 text-amber-100">
                                Ada nominal sewa kendaraan dari data lama yang jenisnya belum dipilih:
                                {entry.legacyAmounts.map((legacy, index) => (
                                  <div key={index} className="mt-1 font-semibold">
                                    {legacy.startDate && legacy.endDate
                                      ? formatDate(legacy.startDate) + ' – ' + formatDate(legacy.endDate) + ' · '
                                      : ''}
                                    {formatNumber(legacy.amount)}
                                  </div>
                                ))}
                                Pindahkan nominal ke Mobil atau Motor yang sesuai. Nominal lama belum masuk ke output supaya tidak salah kategori.
                              </div>
                            )}

                            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                              <label className="grid min-w-0 gap-1.5">
                                <span className="text-xs font-semibold text-slate-300">Kendaraan Mobil</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={formatNumber(entry.mobilAmount)}
                                  onChange={(event) =>
                                    updateVehicleRentEntry(activeTransaction.id, entry.id, {
                                      mobilAmount: event.target.value.replace(/\D/g, '')
                                    })
                                  }
                                  placeholder="Nominal Mobil"
                                  aria-label="Nominal Kendaraan Mobil"
                                  className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                                />
                              </label>
                              <label className="grid min-w-0 gap-1.5">
                                <span className="text-xs font-semibold text-slate-300">Kendaraan Motor</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={formatNumber(entry.motorAmount)}
                                  onChange={(event) =>
                                    updateVehicleRentEntry(activeTransaction.id, entry.id, {
                                      motorAmount: event.target.value.replace(/\D/g, '')
                                    })
                                  }
                                  placeholder="Nominal Motor"
                                  aria-label="Nominal Kendaraan Motor"
                                  className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                                />
                              </label>
                            </div>
                          </>
                        )
                      })()}
                    </section>

                    <section className="w-full min-w-0 rounded-xl border border-violet-600/60 bg-violet-950/10 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Gaji dan Insentif</h2>

                      {activeTransaction.legacy_gaji && activeTransaction.legacy_gaji.length > 0 && (
                        <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-xs leading-5 text-amber-100">
                          Ada nominal dari data lama yang masih digabung. Nominal ini belum masuk ke output—cek pembagiannya, lalu pindahkan ke kolom yang sesuai.
                          {activeTransaction.legacy_gaji.map((legacy, index) => (
                            <div key={index} className="mt-1 font-semibold">
                              {legacy.kinds.join(' + ')} · {formatNumber(legacy.amount)}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="mt-3 space-y-2.5">
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'gaji')
                          .map((entry) => {
                            const mapping = getDailyPaymentMappingForKinds(
                              selectedKitchen?.name ?? '',
                              entry.kinds
                            )
                            const combined = entry.kinds.length > 1
                            const label = combined
                              ? 'Gaji Relawan + Insentif PIC Sekolah + Insentif PIC Posyandu'
                              : entry.kinds[0] ?? 'Jenis belum dimapping'

                            return (
                              <div
                                key={entry.id}
                                className={
                                  activeTransaction.pencairan_harian.filter(
                                    (item) => item.category === 'gaji'
                                  ).length > 1
                                    ? 'rounded-lg border border-violet-800/50 bg-slate-950 p-3'
                                    : ''
                                }
                              >
                                <div className="grid min-w-0 items-stretch gap-2 lg:grid-cols-[minmax(210px,1.2fr)_minmax(145px,1fr)_95px_minmax(145px,0.9fr)_145px]">
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    <span className="truncate">{label}</span>
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    <span className="truncate">{mapping?.ownerName ?? 'Mapping belum tersedia'}</span>
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    {mapping?.bank ?? '-'}
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-slate-100">
                                    <span className="truncate">{mapping?.accountNumber ?? '-'}</span>
                                  </div>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!mapping}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { amount: event.target.value.replace(/\D/g, '') }
                                      )
                                    }
                                    placeholder="Nominal"
                                    aria-label={'Nominal ' + label}
                                    className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30 disabled:cursor-not-allowed disabled:opacity-50"
                                  />
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    </section>
                  </div>

                  <section className="mt-3 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-white">Lain-Lain</h2>
                      <button
                        type="button"
                        onClick={() => addSimpleEntry('lain_lain')}
                        className="h-10 shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-4 text-xs font-semibold text-slate-100 transition hover:border-stone-500 hover:bg-slate-700"
                      >
                        + Transaksi
                      </button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {activeTransaction.lain_lain.map((entry) => (
                        <div
                          key={entry.id}
                          className={
                            activeTransaction.lain_lain.length > 1
                              ? 'rounded-lg border border-slate-800 bg-slate-950 p-3'
                              : ''
                          }
                        >
                          <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(110px,0.65fr)_minmax(145px,0.9fr)_minmax(160px,1fr)_minmax(170px,1.2fr)_minmax(135px,0.8fr)] lg:items-end">
                            <div className="min-w-0">
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
                                aria-label="Bank rekening Lain-Lain"
                                className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-100 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                              >
                                <option value="">Pilih Bank</option>
                                {OPERATIONAL_BANKS.map((bank) => (
                                  <option key={bank} value={bank}>{bank}</option>
                                ))}
                              </select>
                            </div>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={entry.accountNumber}
                              onChange={(event) =>
                                updateSimpleEntry(
                                  activeTransaction.id,
                                  'lain_lain',
                                  entry.id,
                                  { accountNumber: event.target.value.replace(/\D/g, '') }
                                )
                              }
                              placeholder="Nomor rekening"
                              aria-label="Nomor rekening Lain-Lain"
                              className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                            />
                            <input
                              type="text"
                              value={entry.ownerName}
                              onChange={(event) =>
                                updateSimpleEntry(
                                  activeTransaction.id,
                                  'lain_lain',
                                  entry.id,
                                  { ownerName: sanitizeOwnerName(event.target.value) }
                                )
                              }
                              placeholder="Nama pemilik rekening"
                              aria-label="Nama pemilik rekening Lain-Lain"
                              className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                            />
                            <input
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
                              placeholder="Deskripsi / keperluan"
                              aria-label="Deskripsi Lain-Lain"
                              className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              value={formatNumber(entry.amount)}
                              onChange={(event) =>
                                updateSimpleEntry(
                                  activeTransaction.id,
                                  'lain_lain',
                                  entry.id,
                                  { amount: event.target.value.replace(/\D/g, '') }
                                )
                              }
                              placeholder="Nominal"
                              aria-label="Nominal Lain-Lain"
                              className="h-10 w-full min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-stone-500 focus:border-stone-300 focus:ring-1 focus:ring-stone-300/30"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>


                </>
              )}
                </div>
              </div>
            </>
          )}
        </>
      </div>
    </main>
  )
}

export default App
