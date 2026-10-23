import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import appBrandIcon from '../fav.svg'
import {
  getMakerMasterData,
  type MakerMasterData,
  type MakerAccountRule
} from './services/master-data'
import { supabase } from './lib/supabase'
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
  bank?: string
  customAccount?: boolean
  need: string
  gasQuantity?: string
  gasSize?: '' | '12kg' | '50kg'
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
  opsRealAmount: string
}

type SavedWorkspace = {
  version: 3 | 4 | 5 | 6 | 7
  kitchenId: string
  activeTransactionId: number
  transactions: TransactionGroup[]
  savedAt?: number
}

const STORAGE_KEY = 'maker-pencairan-workspace-v7'
const RECOVERY_STORAGE_KEY = 'maker-pencairan-workspace-recovery-v1'
const KITCHEN_WORKSPACE_STORAGE_PREFIX = 'maker-pencairan-kitchen-workspace-v1:'
const KITCHEN_RECOVERY_STORAGE_PREFIX = 'maker-pencairan-kitchen-recovery-v1:'
const PREVIOUS_STORAGE_KEYS = [
  'maker-pencairan-workspace-v6',
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

// Bank options shared by custom Ops Harian and Koperasi Arutala payouts.
const CUSTOM_BANK_OPTIONS = [...OPERATIONAL_BANKS, 'VA BNI', 'VA BRI']

const DAILY_PAYMENT_SEWA_OPTIONS: DailyPaymentKind[] = ['Sewa SPPG']

const DAILY_PAYMENT_GAJI_OPTIONS: DailyPaymentKind[] = [
  'Gaji Relawan',
  'Insentif PIC Sekolah',
  'Insentif PIC Posyandu'
]

const DAILY_PAYMENT_PIC_OPTIONS: DailyPaymentKind[] = [
  'Insentif PIC Sekolah',
  'Insentif PIC Posyandu'
]

const DAILY_PAYMENT_OPTIONS: DailyPaymentKind[] = [
  ...DAILY_PAYMENT_SEWA_OPTIONS,
  ...DAILY_PAYMENT_GAJI_OPTIONS
]

type BankAccountMapping = {
  ownerName: string
  bank: string
  accountNumber: string
}

const DAILY_PAYMENT_RULE_TYPE: Record<DailyPaymentKind, string> = {
  'Sewa SPPG': 'sppg_rent',
  'Gaji Relawan': 'gaji_relawan',
  'Insentif PIC Sekolah': 'pic_incentive_school',
  'Insentif PIC Posyandu': 'pic_incentive_posyandu',
  'Sewa Kendaraan': 'vehicle_rent'
}

function getOperationalMapping(
  kitchenName: string,
  masterData: MakerMasterData | null,
  ruleType: string
): BankAccountMapping | null {
  if (!masterData || !kitchenName) return null
  const normalizedName = kitchenName.trim().toLocaleLowerCase('id-ID')
  const kitchen = masterData.kitchens.find(
    (item) => item.name.trim().toLocaleLowerCase('id-ID') === normalizedName
  )
  if (!kitchen) return null

  const rule = masterData.operational_rules.find(
    (item) => item.kitchen_id === kitchen.id && item.rule_type === ruleType && item.is_active
  )
  return rule
    ? {
        ownerName: rule.owner_name,
        bank: rule.bank,
        accountNumber: rule.account_number
      }
    : null
}

function getOperationalAccount(
  kitchenName: string,
  masterData: MakerMasterData | null
): BankAccountMapping | null {
  return getOperationalMapping(kitchenName, masterData, 'ops_harian')
}

function getDailyPaymentAccount(
  kitchenName: string,
  kind: DailyPaymentKind,
  masterData: MakerMasterData | null
): BankAccountMapping | null {
  return getOperationalMapping(kitchenName, masterData, DAILY_PAYMENT_RULE_TYPE[kind])
}

function sameAccount(left: BankAccountMapping, right: BankAccountMapping) {
  return left.bank === right.bank &&
    left.accountNumber === right.accountNumber &&
    left.ownerName === right.ownerName
}

function getDailyPaymentMappingForKinds(
  kitchenName: string,
  kinds: DailyPaymentKind[],
  masterData: MakerMasterData | null
): BankAccountMapping | null {
  if (kinds.length === 0) return null
  const mappings = kinds.map((kind) => getDailyPaymentAccount(kitchenName, kind, masterData))
  if (mappings.some((mapping) => !mapping)) return null
  const first = mappings[0]
  if (!first) return null
  return mappings.every((mapping) => mapping && sameAccount(first, mapping)) ? first : null
}

function getDailyPaymentTargetKey(
  kitchenName: string,
  kind: DailyPaymentKind,
  masterData: MakerMasterData | null
) {
  const mapping = getDailyPaymentAccount(kitchenName, kind, masterData)
  return mapping ? mapping.bank + '|' + mapping.accountNumber + '|' + mapping.ownerName : 'manual'
}

function areDailyPaymentKindsCompatible(
  kitchenName: string,
  kinds: DailyPaymentKind[],
  masterData: MakerMasterData | null
) {
  return new Set(kinds.map((kind) => getDailyPaymentTargetKey(kitchenName, kind, masterData))).size <= 1
}

function getSppgRental(
  kitchenName: string,
  masterData: MakerMasterData | null
): BankAccountMapping | null {
  return getOperationalMapping(kitchenName, masterData, 'sppg_rent')
}

function getVehicleRentAccount(
  kitchenName: string,
  masterData: MakerMasterData | null
): BankAccountMapping | null {
  return getOperationalMapping(kitchenName, masterData, 'vehicle_rent')
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
    'Mei',
    'Jun',
    'Jul',
    'Agu',
    'Sep',
    'Okt',
    'Nov',
    'Des'
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

function capitalizeEachWord(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('id-ID')
    .replace(/(^|[\s-])(\p{L})/gu, (_match, separator: string, letter: string) =>
      separator + letter.toLocaleUpperCase('id-ID')
    )
}

function formatRabSupplierName(value: string) {
  return capitalizeEachWord(value).replace(
    /(^|[^\p{L}\p{N}])(cv|pt|umkm|kpws|rr|rpu|ud)(?=$|[^\p{L}\p{N}])/giu,
    (_match, separator: string, acronym: string) => separator + acronym.toLocaleUpperCase('id-ID')
  )
}

function formatSupplierAccountName(businessName: string, ownerName?: string | null) {
  const formattedBusinessName = formatRabSupplierName(businessName)
  const formattedOwnerName = capitalizeEachWord(ownerName ?? '')
  return formattedOwnerName
    ? formattedBusinessName + ' (' + formattedOwnerName + ')'
    : formattedBusinessName
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

function isValidSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<SavedWorkspace> & { version?: unknown }
  return (
    (candidate.version === 3 ||
      candidate.version === 4 ||
      candidate.version === 5 ||
      candidate.version === 6 ||
      candidate.version === 7) &&
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
      version: 7,
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
      version: 7,
      ...workspace,
      savedAt: Date.now()
    }

    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // localStorage can fail in private/restricted browser contexts.
    // The app continues to work in memory in that case.
  }
}

function kitchenWorkspaceStorageKey(kitchenId: string) {
  return KITCHEN_WORKSPACE_STORAGE_PREFIX + kitchenId
}

function kitchenRecoveryStorageKey(kitchenId: string) {
  return KITCHEN_RECOVERY_STORAGE_PREFIX + kitchenId
}

function persistWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  if (!workspace.kitchenId) return
  persistWorkspaceToKey(workspace, STORAGE_KEY)
  persistWorkspaceToKey(workspace, kitchenWorkspaceStorageKey(workspace.kitchenId))
}

function persistRecoveryWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  const key = workspace.kitchenId
    ? kitchenRecoveryStorageKey(workspace.kitchenId)
    : RECOVERY_STORAGE_KEY
  persistWorkspaceToKey(workspace, key)
}

function emptySimpleEntry(id = 1): SimpleEntry {
  return {
    id,
    accountId: '',
    amount: '',
    accountNumber: '',
    ownerName: '',
    need: '',
    gasQuantity: '',
    gasSize: '',
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
  masterData: MakerMasterData | null,
  kinds: DailyPaymentKind[],
  amount = ''
): DailyPaymentEntry {
  const mapping = getDailyPaymentMappingForKinds(kitchenName, kinds, masterData)
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

function createPayrollRowsForKitchen(
  kitchenName: string,
  masterData: MakerMasterData | null,
  startId = 2
) {
  if (kitchenName === 'Campakamulya') {
    return [
      createPayrollEntry(startId, kitchenName, masterData, [...DAILY_PAYMENT_GAJI_OPTIONS])
    ]
  }

  if (kitchenName === 'Cimanggu') {
    return [
      createPayrollEntry(startId, kitchenName, masterData, ['Gaji Relawan']),
      createPayrollEntry(startId + 1, kitchenName, masterData, [...DAILY_PAYMENT_PIC_OPTIONS])
    ]
  }

  return DAILY_PAYMENT_GAJI_OPTIONS.map((kind, index) =>
    createPayrollEntry(startId + index, kitchenName, masterData, [kind])
  )
}

function getPayrollStructure(
  currentPayments: DailyPaymentEntry[],
  kitchenName: string,
  masterData: MakerMasterData | null,
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
        (total, value) => total + Number((value ?? '').replace(/\D/g, '')),
        0
      ) || ''
    )
    const target = createPayrollEntry(
      combined?.id ?? nextId,
      kitchenName,
      masterData,
      [...DAILY_PAYMENT_GAJI_OPTIONS],
      combinedAmount
    )
    return {
      payments: [...sewaRows, target],
      legacy: []
    }
  }

  if (kitchenName === 'Cimanggu') {
    const gajiRelawanRows = gajiRows.filter(
      (entry) => entry.kinds.length === 1 && entry.kinds[0] === 'Gaji Relawan'
    )
    const picRows = gajiRows.filter(
      (entry) =>
        entry.kinds.length > 0 &&
        entry.kinds.every((kind) => DAILY_PAYMENT_PIC_OPTIONS.includes(kind))
    )
    const groupedLegacy = gajiRows.filter(
      (entry) =>
        !(
          entry.kinds.length === 1 &&
          entry.kinds[0] === 'Gaji Relawan'
        ) &&
        !(
          entry.kinds.length > 0 &&
          entry.kinds.every((kind) => DAILY_PAYMENT_PIC_OPTIONS.includes(kind))
        ) &&
        isCompleteAmount(entry.amount)
    )
    const legacyMap = new Map<string, DailyPaymentEntry>()
    for (const entry of [...currentLegacy, ...groupedLegacy]) {
      const key = [entry.id, entry.kinds.join('|'), entry.amount].join(':')
      legacyMap.set(key, entry)
    }

    const gajiAmount = gajiRelawanRows.reduce(
      (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
      0
    )
    const picAmount = picRows.reduce(
      (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
      0
    )
    const gajiEntry = createPayrollEntry(
      gajiRelawanRows[0]?.id ?? nextId,
      kitchenName,
      masterData,
      ['Gaji Relawan'],
      String(gajiAmount || '')
    )
    const picEntry = createPayrollEntry(
      picRows[0]?.id ?? nextId + 1,
      kitchenName,
      masterData,
      [...DAILY_PAYMENT_PIC_OPTIONS],
      String(picAmount || '')
    )

    return {
      payments: [...sewaRows, gajiEntry, picEntry],
      legacy: [...legacyMap.values()]
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
      masterData,
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
    bank: '',
    customAccount: false,
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
          accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
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
    ? transaction.gas.map((entry, index) => {
        const normalizedEntry: SimpleEntry = {
          ...entry,
          gasQuantity: typeof entry.gasQuantity === 'string' ? entry.gasQuantity.replace(/\D/g, '') : '',
          gasSize: entry.gasSize === '12kg' || entry.gasSize === '50kg' ? entry.gasSize : '',
          ownerName: sanitizeOwnerName(entry.ownerName ?? ''),
          bank: entry.bank ?? '',
          customAccount: index > 0,
          transactionType: entry.transactionType ?? ''
        }
        return {
          ...normalizedEntry,
          need: index === 0 ? 'Gas' : (entry.need ?? ''),
          gasQuantity: index === 0 ? normalizedEntry.gasQuantity : '',
          gasSize: index === 0 ? normalizedEntry.gasSize : ''
        }
      })
    : [{
        ...emptySimpleEntry(1),
        accountId: '',
        accountNumber: '',
        ownerName: '',
        amount: '',
        need: 'Gas',
        gasQuantity: '',
        gasSize: '',
        customAccount: false,
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
  const normalizeOpsEntry = (entry: SimpleEntry, index: number): SimpleEntry => ({
    ...createOperationalEntry(entry.id),
    ...entry,
    accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
    ownerName: entry.ownerName ?? '',
    bank: entry.bank ?? '',
    customAccount: index > 0,
    need: index === 0 ? 'Ops Harian' : (entry.need ?? ''),
    transactionType: 'operasional_harian'
  })
  const oldOpsTotal = legacyOps.reduce(
    (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
    0
  )
  const baseOperational: SimpleEntry[] = existingOps.length > 0
    ? existingOps.map((entry, index) => normalizeOpsEntry(entry, index))
    : legacyOps.length > 0
      ? [{
          ...createOperationalEntry(legacyOps[0].id),
          amount: String(oldOpsTotal || legacyOps[0].amount || '')
        }]
      : [createOperationalEntry()]
  const lastOpsId = Math.max(0, ...baseOperational.map((entry) => entry.id))
  const migratedLainLain: SimpleEntry[] = normalizedOthers
    .filter((entry) =>
      entry.transactionType !== 'operasional_harian' &&
      isCompleteAmount(entry.amount) &&
      Boolean(entry.ownerName.trim() && entry.accountNumber.trim() && entry.accountId.trim())
    )
    .map((entry, index) => ({
      ...createOperationalEntry(lastOpsId + index + 1),
      ownerName: entry.ownerName,
      bank: getOutputBank(entry.accountId),
      accountNumber: entry.accountNumber,
      amount: entry.amount,
      need: entry.need.trim() || 'Biaya Ops Harian',
      customAccount: true
    }))
  const operational = baseOperational.concat(migratedLainLain)
  const lain_lain = [emptySimpleEntry(1)]
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
    opsRealAmount: typeof transaction.opsRealAmount === 'string' ? transaction.opsRealAmount : '',
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
  kitchenName = '',
  masterData: MakerMasterData | null = null
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
        need: 'Gas',
        gasQuantity: '',
        gasSize: '',
        customAccount: false,
        transactionType: ''
      }
    ],
    operasional: [createOperationalEntry(1)],
    pencairan_harian: [
      { ...emptyDailyPaymentEntry(1, 'sewa'), kinds: ['Sewa SPPG'] },
      ...createPayrollRowsForKitchen(kitchenName, masterData, 2)
    ],
    sewa_kendaraan: [emptyVehicleRentEntry(1)],
    lain_lain: [emptyOtherEntry(1)],
    opsRealAmount: '',
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
    () => (
      savedTransaction
        ? normalizeTransaction({ ...savedTransaction, date: today }, today)
        : null
    ),
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
  const [customRabOpen, setCustomRabOpen] = useState<Record<string, boolean>>({})
  const [customRabDrafts, setCustomRabDrafts] = useState<Record<string, string[]>>({})
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark'
    try {
      return window.localStorage.getItem('maker-pencairan-theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const dateInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef({
    kitchenId: saved?.kitchenId ?? '',
    activeTransactionId: 1,
    transactions: initialTransaction ? [initialTransaction] : []
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    try {
      window.localStorage.setItem('maker-pencairan-theme', theme)
    } catch {
      // Theme still works for the current session when storage is unavailable.
    }
  }, [theme])

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

  const loadMasterData = useCallback(async (silent = false) => {
    if (!silent) setMasterLoading(true)
    setMasterError('')

    try {
      const data = await getMakerMasterData()
      setMasterData(data)
    } catch (err) {
      if (silent) {
        console.warn('Gagal memperbarui master data secara otomatis:', err)
      } else {
        setMasterError(
          err instanceof Error ? err.message : 'Gagal memuat master data.'
        )
      }
    } finally {
      if (!silent) setMasterLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let refreshTimer: number | undefined
    let refreshInFlight = false
    let refreshQueued = false

    const refreshMasterData = async () => {
      if (cancelled) return
      if (refreshInFlight) {
        refreshQueued = true
        return
      }

      refreshInFlight = true
      try {
        await loadMasterData(true)
      } finally {
        refreshInFlight = false
        if (refreshQueued && !cancelled) {
          refreshQueued = false
          scheduleRefresh()
        }
      }
    }

    const scheduleRefresh = () => {
      if (cancelled) return
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void refreshMasterData()
      }, 250)
    }

    const channel = supabase
      .channel('maker-master-data-version-live')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'maker_master_data_version'
        },
        scheduleRefresh
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Maker master-data Realtime]', status)
        }
      })

    return () => {
      cancelled = true
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
      }
      void supabase.removeChannel(channel)
    }
  }, [loadMasterData])

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

    return masterData.account_rules
      .filter((rule) => {
        if (rule.kitchen_id !== kitchenId) return false
        if (rule.flow_type !== 'neutral') return false
        if (!rule.accounts) return false
        if (seen.has(rule.account_id)) return false
        seen.add(rule.account_id)
        return true
      })
      .sort((a, b) => {
        const aName = (a.supplier?.business_name ?? a.accounts?.name ?? '').trim()
        const bName = (b.supplier?.business_name ?? b.accounts?.name ?? '').trim()
        const nameCompare = aName.localeCompare(bName, 'id', { sensitivity: 'base' })
        if (nameCompare !== 0) return nameCompare
        return (a.accounts?.bank ?? '').localeCompare(b.accounts?.bank ?? '', 'id', {
          sensitivity: 'base'
        })
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

    const rental = getSppgRental(selectedKitchen.name, masterData)
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
  }, [activeTransaction, selectedKitchen, masterData])

  useEffect(() => {
    if (!selectedKitchen || !activeTransaction) return

    const structure = getPayrollStructure(
      activeTransaction.pencairan_harian,
      selectedKitchen.name,
      masterData,
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
  }, [activeTransaction, selectedKitchen, masterData])

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

  function addOperationalEntry() {
    if (!activeTransaction) return
    const currentEntries = activeTransaction.operasional ?? []
    const nextId = currentEntries.length === 0
      ? 1
      : Math.max(...currentEntries.map((entry) => entry.id)) + 1
    const mapping = getOperationalAccount(selectedKitchen?.name ?? '', masterData)
    updateTransaction(activeTransaction.id, {
      operasional: [...currentEntries, {
        ...createOperationalEntry(nextId),
        ownerName: mapping?.ownerName ?? '',
        bank: mapping?.bank ?? '',
        accountNumber: mapping?.accountNumber ?? '',
        customAccount: true,
        need: ''
      }]
    })
  }

  function addGasCustomEntry() {
    if (!activeTransaction) return
    const currentEntries = activeTransaction.gas ?? []
    const nextId = currentEntries.length === 0
      ? 1
      : Math.max(...currentEntries.map((entry) => entry.id)) + 1
    const rule = gasRules[0]
    const accountName = rule?.supplier?.business_name || rule?.accounts?.name || ''
    updateTransaction(activeTransaction.id, {
      gas: [...currentEntries, {
        ...emptySimpleEntry(nextId),
        accountId: rule?.account_id ?? '',
        ownerName: accountName,
        bank: rule?.accounts?.bank ?? '',
        accountNumber: rule?.accounts?.account_number ?? '',
        need: '',
        gasQuantity: '',
        gasSize: '',
        customAccount: true,
        transactionType: ''
      }]
    })
  }

  function removeGasEntry(id: number) {
    if (!activeTransaction) return
    const currentEntries = activeTransaction.gas ?? []
    if (currentEntries[0]?.id === id) return
    const remaining = currentEntries.filter((entry) => entry.id !== id)
    updateTransaction(activeTransaction.id, {
      gas: remaining.length > 0 ? remaining : [{
        ...emptySimpleEntry(1),
        accountId: gasRules[0]?.account_id ?? '',
        accountNumber: gasRules[0]?.accounts?.account_number ?? '',
        need: 'Gas',
        customAccount: false
      }]
    })
  }

  function removeOperationalEntry(id: number) {
    if (!activeTransaction) return
    const remaining = (activeTransaction.operasional ?? []).filter((entry) => entry.id !== id)
    updateTransaction(activeTransaction.id, {
      operasional: remaining.length > 0 ? remaining : [createOperationalEntry(1)]
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

  function updateCustomRabProduct(
    transactionId: number,
    accountId: string,
    fieldIndex: number,
    value: string,
    availableProducts: string[]
  ) {
    const transaction = transactions.find((item) => item.id === transactionId)
    if (!transaction) return

    const entry = transaction.rab.find((item) => item.accountId === accountId)
    const currentProducts = entry?.productTypes ?? []
    const customProducts = currentProducts.filter(
      (item) => !availableProducts.includes(item)
    )
    const draftKey = transactionId + ':' + accountId
    const existingDraft = customRabDrafts[draftKey] ?? customProducts
    const nextDraft = [...existingDraft]
    while (nextDraft.length <= fieldIndex) nextDraft.push('')
    nextDraft[fieldIndex] = value
    setCustomRabDrafts((current) => ({ ...current, [draftKey]: nextDraft }))

    const nextCustomProducts = nextDraft
      .map((item) => item.trim())
      .filter(Boolean)
    // Custom input drafts and selected catalog items share productTypes.
    // Exclude a catalog item when the user is in the middle of typing that
    // same name (e.g. "Beras" before completing "Beras Merah").
    const selectedCatalogProducts = currentProducts.filter(
      (item) =>
        availableProducts.includes(item) &&
        !existingDraft.some((draft) => draft.trim() === item)
    )
    updateRabEntry(transactionId, accountId, {
      productTypes: sortStrings([
        ...selectedCatalogProducts,
        ...nextCustomProducts
      ])
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
    persistWorkspace({ kitchenId, activeTransactionId, transactions })
    setKitchenId(nextKitchenId)
    setCopyMessage('')

    if (!nextKitchenId) {
      setTransactions([])
      setActiveTransactionId(1)
      return
    }

    const savedKitchen = readWorkspaceFromStorageKey(kitchenWorkspaceStorageKey(nextKitchenId))
    const savedKitchenTransaction = savedKitchen?.transactions.find(
      (transaction) => transaction.id === savedKitchen.activeTransactionId
    ) ?? savedKitchen?.transactions[0]
    if (savedKitchen && savedKitchenTransaction && savedKitchen.kitchenId === nextKitchenId) {
      // Keep saved payment/item state, but always start the selected kitchen on today's date.
      const restoredTransaction = normalizeTransaction(
        { ...savedKitchenTransaction, date: today },
        today
      )
      setTransactions([restoredTransaction])
      setActiveTransactionId(restoredTransaction.id)
      persistWorkspace({
        kitchenId: nextKitchenId,
        activeTransactionId: restoredTransaction.id,
        transactions: [restoredTransaction]
      })
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
      today,
      nextRabRules.map((rule) => ({ account_id: rule.account_id })),
      nextGasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      })),
      nextKitchenName,
      masterData
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

    const resetDate = toIsoDate(new Date())
    const nextTransaction = makeTransaction(
      1,
      resetDate,
      sortedRabRules.map((rule) => ({ account_id: rule.account_id })),
      gasRules.map((rule) => ({
        account_id: rule.account_id,
        accounts: rule.accounts
      })),
      selectedKitchen?.name ?? '',
      masterData
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

    const mappedOperationalAccount = getOperationalAccount(kitchenName, masterData)
    for (const [operationalIndex, operationalEntry] of (transaction.operasional ?? []).entries()) {
      if (!isCompleteAmount(operationalEntry.amount)) continue
      const custom = operationalIndex > 0
      const bank = getOutputBank(custom ? (operationalEntry.bank || mappedOperationalAccount?.bank || '') : (mappedOperationalAccount?.bank ?? ''))
      const accountNumber = (custom ? (operationalEntry.accountNumber || mappedOperationalAccount?.accountNumber || '') : mappedOperationalAccount?.accountNumber ?? '').trim()
      const ownerName = (custom ? (operationalEntry.ownerName || mappedOperationalAccount?.ownerName || '') : mappedOperationalAccount?.ownerName ?? '').trim()
      if (!bank || !accountNumber || !ownerName) continue

      const note = custom ? (operationalEntry.need ?? '').trim() : 'Ops Harian'
      if (!note) continue
      outputs.push({
        bank,
        line:
          'OPS HARIAN : ' +
          capitalizeEachWord(ownerName) +
          ' - ' +
          bank +
          ' / ' +
          accountNumber +
          (note ? ' · ' + note : '') +
          ' · ' +
          formatNumber(operationalEntry.amount),
        kind: 'operasional_harian'
      })
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
          'LAIN-LAIN : ' +
          (entry.need.trim() || 'Biaya Ops Harian') +
          ' - ' +
          capitalizeEachWord(ownerName) +
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

    for (const [entryIndex, entry] of (transaction.gas ?? []).entries()) {
      if (!isCompleteAmount(entry.amount)) continue
      const customNoteMode = entryIndex > 0
      const quantity = (entry.gasQuantity ?? '').replace(/\D/g, '').replace(/^0+/, '')
      const size = entry.gasSize === '12kg' || entry.gasSize === '50kg' ? entry.gasSize : ''
      const note = customNoteMode
        ? (entry.need ?? '').trim()
        : quantity && size
          ? 'Gas ' + size + ' (' + quantity + ' tabung)'
          : 'Gas'
      if (!note) continue

      const rule = gasRules[0]
      if (!rule?.accounts) continue
      const rawAccountName = rule.supplier?.business_name || rule.accounts.name
      const accountName = formatSupplierAccountName(rawAccountName, rule.supplier?.owner_name)
      const bank = getOutputBank(rule.accounts.bank)
      const accountNumber = (rule.accounts.account_number ?? '-').trim()

      if (customNoteMode) {
        items.push({
          kind: 'operasional_harian',
          bank,
          line: 'OPS HARIAN : ' + capitalizeEachWord(rawAccountName) +
            ' - ' + bank + ' / ' + accountNumber +
            ' · ' + note + ' · ' + formatNumber(entry.amount),
          index: items.length,
          modeRank: 0
        })
      } else {
        items.push({
          kind: 'gas',
          bank,
          line: 'GAS : ' + accountName + ' / ' + note +
            ' - ' + bank + ' / ' + accountNumber + ' · ' + formatNumber(entry.amount),
          index: items.length,
          modeRank: 0
        })
      }
    }

    for (const entry of transaction.pencairan_harian) {
      if (!isCompleteAmount(entry.amount)) continue

      if (entry.category === 'sewa') {
        const rental = getSppgRental(kitchenName, masterData)
        if (!rental) continue

        items.push({
          kind: 'pencairan_harian',
          bank: getOutputBank(rental.bank),
          line:
            'INSENTIF FASILITAS SPPG : ' +
            capitalizeEachWord(rental.ownerName) +
            ' - ' +
            getOutputBank(rental.bank) +
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
      if (!areDailyPaymentKindsCompatible(kitchenName, kinds, masterData)) continue

      const mappedAccount = getDailyPaymentMappingForKinds(kitchenName, kinds, masterData)
      const bank = getOutputBank(mappedAccount?.bank ?? entry.bank)
      const accountNumber = (mappedAccount?.accountNumber ?? entry.accountNumber).trim()
      const ownerName = (mappedAccount?.ownerName ?? entry.ownerName).trim()
      if (!bank || !accountNumber || !ownerName) continue

      items.push({
        kind: 'pencairan_harian',
        bank,
        line:
          kinds.join(', ').toLocaleUpperCase('id-ID') +
          ' : ' +
          capitalizeEachWord(ownerName) +
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

      const account = getVehicleRentAccount(kitchenName, masterData)
      if (!account) continue
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
            ('SEWA KENDARAAN ' +
            vehicle.label).toLocaleUpperCase('id-ID') +
            ' (' +
            period +
            ') : ' +
            capitalizeEachWord(account.ownerName) +
            ' - ' +
            getOutputBank(account.bank) +
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
      const supplierName = formatSupplierAccountName(
        rule.supplier?.business_name ?? rule.accounts.name,
        rule.supplier?.owner_name
      )
      const catalogProducts = rule.supplier?.product_types ?? []
      const sortedProducts = sortStrings(entry.productTypes)
        .map((product) =>
          catalogProducts.includes(product) ? product : capitalizeEachWord(product)
        )
        .sort((a, b) => {
          const aIsOther = a.trim().toLocaleLowerCase('id') === 'lainnya'
          const bIsOther = b.trim().toLocaleLowerCase('id') === 'lainnya'
          if (aIsOther !== bIsOther) return aIsOther ? 1 : -1
          return a.localeCompare(b, 'id', { sensitivity: 'base' })
        })
      const productText = sortedProducts.length <= 1
        ? (sortedProducts[0] ?? '')
        : sortedProducts.length === 2
          ? sortedProducts[0] + ' dan ' + sortedProducts[1]
          : sortedProducts.slice(0, -1).join(', ') + ', dan ' + sortedProducts[sortedProducts.length - 1]
      const hasProduct = productText.length > 0
      // Product selections alone do not create an output line; RAB requires a nominal.
      if (!hasAmount) continue
      const accountText =
        supplierName +
        ' - ' +
        getOutputBank(rule.accounts.bank) +
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

    const headerLine = kitchenName + ', ' + formatDate(transaction.date)
    const mainLines = items.length > 0
      ? [headerLine, ...items.map((item) => item.line)]
      : []
    // Ops Real is temporarily disabled, so it is omitted from generated output.
    if (mainLines.length === 0) return []

    return mainLines
  }

  const output =
    activeTransaction
      ? getTransactionOutput(activeTransaction).join('\n')
      : ''
  const outputDetailLines = output ? output.split('\n').slice(1).filter((line) => line.trim()) : []
  const outputLineCount = outputDetailLines.length
  const hasOutputAmount = (prefix: string, accountNumber: string, amount: string) => {
    const normalizedAccount = (accountNumber ?? '').trim()
    const formattedAmount = formatNumber(amount ?? '')
    if (!normalizedAccount || !isCompleteAmount(amount ?? '') || !formattedAmount) return false
    const accountMarker = ' / ' + normalizedAccount + ' ·'
    const amountSuffix = ' · ' + formattedAmount
    return outputDetailLines.some(
      (line) =>
        line.startsWith(prefix) &&
        line.includes(accountMarker) &&
        line.endsWith(amountSuffix)
    )
  }
  const getOutputAmount = (line: string) => {
    const separatorIndex = line.lastIndexOf(' · ')
    if (separatorIndex < 0) return 0
    return Number(line.slice(separatorIndex + 3).replace(/\D/g, '')) || 0
  }
  const sumOutputLines = (matches: (line: string) => boolean) =>
    outputDetailLines.reduce((total, line) => total + (matches(line) ? getOutputAmount(line) : 0), 0)
  const totalRab = sumOutputLines((line) => line.startsWith('RAB : '))
  const opsHarianBreakdown = outputDetailLines.reduce<Array<{ label: string; amount: number }>>(
    (items, line) => {
      const amount = getOutputAmount(line)
      if (amount <= 0) return items

      let label = ''
      if (line.startsWith('INSENTIF FASILITAS SPPG : ')) {
        label = 'Fasilitas SPPG'
      } else if (line.startsWith('SEWA KENDARAAN ')) {
        label = 'Sewa Kendaraan'
      } else if (line.startsWith('OPS HARIAN : ')) {
        const firstSeparator = line.indexOf(' · ')
        const amountSeparator = line.lastIndexOf(' · ')
        const note = firstSeparator >= 0 && amountSeparator > firstSeparator
          ? line.slice(firstSeparator + 3, amountSeparator).trim()
          : ''
        label = note && note.toLocaleLowerCase('id-ID') !== 'ops harian'
          ? 'Ops: ' + note
          : 'Ops Harian'
      } else if (line.startsWith('GAS : ')) {
        label = 'GAS'
      } else {
        const separatorIndex = line.indexOf(' : ')
        if (separatorIndex < 0) return items
        const category = line.slice(0, separatorIndex).trim().toLocaleUpperCase('id-ID')
        const categoryLabels: Record<string, string> = {
          'GAJI RELAWAN': 'Gaji Relawan',
          'INSENTIF PIC SEKOLAH': 'PIC Sekolah',
          'INSENTIF PIC POSYANDU': 'PIC Kader'
        }
        const parts = category
          .split(',')
          .map((part) => categoryLabels[part.trim()])
          .filter((part): part is string => Boolean(part))
        if (parts.length === 0) return items
        label = parts.sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' })).join(' + ')
      }

      const existing = items.find((item) => item.label === label)
      if (existing) existing.amount += amount
      else items.push({ label, amount })
      return items
    },
    []
  ).sort((a, b) => a.label.localeCompare(b.label, 'id', { sensitivity: 'base' }))
  const totalOpsHarian = opsHarianBreakdown.reduce((total, item) => total + item.amount, 0)

  const outputChecks: { label: string; complete: boolean }[] = []
  if (activeTransaction && selectedKitchen) {
    const kitchenName = selectedKitchen.name
    const hasSewaMapping = Boolean(getSppgRental(kitchenName, masterData))
    if (hasSewaMapping) {
      const sewaEntry = activeTransaction.pencairan_harian.find(
        (entry) => entry.category === 'sewa' && entry.kinds.includes('Sewa SPPG')
      )
      outputChecks.push({
        label: 'Insentif Fasilitas SPPG',
        complete: Boolean(sewaEntry && isCompleteAmount(sewaEntry.amount))
      })
    }

    const payrollEntries = activeTransaction.pencairan_harian.filter(
      (entry) => entry.category === 'gaji'
    )
    if (kitchenName === 'Campakamulya') {
      const combinedMapping = getDailyPaymentMappingForKinds(
        kitchenName,
        DAILY_PAYMENT_GAJI_OPTIONS,
        masterData
      )
      if (combinedMapping) {
        const combinedEntry = payrollEntries.find((entry) =>
          DAILY_PAYMENT_GAJI_OPTIONS.every((kind) => entry.kinds.includes(kind))
        )
        outputChecks.push({
          label: 'Gaji Relawan + Insentif PIC',
          complete: Boolean(combinedEntry && isCompleteAmount(combinedEntry.amount))
        })
      }
    } else if (kitchenName === 'Cimanggu') {
      const gajiMapping = getDailyPaymentAccount(kitchenName, 'Gaji Relawan', masterData)
      if (gajiMapping) {
        const gajiEntry = payrollEntries.find(
          (entry) => entry.kinds.length === 1 && entry.kinds[0] === 'Gaji Relawan'
        )
        outputChecks.push({
          label: 'Gaji Relawan',
          complete: Boolean(gajiEntry && isCompleteAmount(gajiEntry.amount))
        })
      }

      const picMapping = getDailyPaymentMappingForKinds(
        kitchenName,
        DAILY_PAYMENT_PIC_OPTIONS,
        masterData
      )
      if (picMapping) {
        const picEntry = payrollEntries.find((entry) =>
          DAILY_PAYMENT_PIC_OPTIONS.every((kind) => entry.kinds.includes(kind))
        )
        outputChecks.push({
          label: 'Insentif PIC Sekolah + Insentif PIC Posyandu',
          complete: Boolean(picEntry && isCompleteAmount(picEntry.amount))
        })
      }
    } else {
      for (const kind of DAILY_PAYMENT_GAJI_OPTIONS) {
        const mapping = getDailyPaymentAccount(kitchenName, kind, masterData)
        if (!mapping) continue
        const entry = payrollEntries.find(
          (item) => item.kinds.length === 1 && item.kinds[0] === kind
        )
        outputChecks.push({
          label: kind,
          complete: Boolean(entry && isCompleteAmount(entry.amount))
        })
      }
    }

    const gasMapping = gasRules[0]
    const gasEntries = activeTransaction.gas ?? []
    if (gasMapping) {
      outputChecks.push({
        label: 'Pencairan Koperasi Arutala',
        complete: Boolean(gasMapping.accounts) &&
          gasEntries.some((entry) => isCompleteAmount(entry.amount)) &&
          gasEntries.every((entry, index) => {
            if (!isCompleteAmount(entry.amount)) return true
            // Jumlah dan ukuran gas bersifat opsional; nominal tetap wajib.
            // Entri custom tetap membutuhkan catatan agar output operasional jelas.
            if (index === 0) return true
            return Boolean((entry.need ?? '').trim())
          })
      })
    }

    const opsMapping = getOperationalAccount(kitchenName, masterData)
    const operationalEntries = activeTransaction.operasional ?? []
    if (opsMapping || operationalEntries.some((entry) => entry.customAccount)) {
      outputChecks.push({
        label: 'Operasional Harian',
        complete: Boolean(opsMapping) &&
          operationalEntries.some((entry) => isCompleteAmount(entry.amount)) &&
          operationalEntries.every((entry, index) =>
            !isCompleteAmount(entry.amount) ||
            index === 0 ||
            Boolean(entry.ownerName.trim() && (entry.bank ?? '').trim() && entry.accountNumber.trim() && (entry.need ?? '').trim())
          )
      })
    }
  }

  const outputDisplayChecks = Array.from(
    outputChecks.reduce((checks, { label, complete }) => {
      let displayLabels: string[] = []
      if (label === 'Insentif Fasilitas SPPG') displayLabels = ['Fasilitas SPPG']
      else if (label === 'Gaji Relawan + Insentif PIC') {
        displayLabels = ['Gaji Relawan + PIC Kader + PIC Sekolah']
      } else if (label === 'Insentif PIC Sekolah + Insentif PIC Posyandu') {
        displayLabels = ['PIC Kader + PIC Sekolah']
      } else if (label === 'Gaji Relawan') displayLabels = ['Gaji Relawan']
      else if (label === 'Insentif PIC Posyandu') displayLabels = ['PIC Kader']
      else if (label === 'Insentif PIC Sekolah') displayLabels = ['PIC Sekolah']

      for (const displayLabel of displayLabels) {
        checks.set(displayLabel, (checks.get(displayLabel) ?? false) || complete)
      }
      return checks
    }, new Map<string, boolean>())
  )
    .map(([label, complete]) => ({ label, complete }))
    .sort((a, b) => a.label.localeCompare(b.label, 'id', { sensitivity: 'base' }))

  async function copyOutput() {
    if (!output) return

    await navigator.clipboard.writeText(output)
    setCopyMessage('Berhasil disalin.')
    window.setTimeout(() => setCopyMessage(''), 2000)
  }

  function restoreLastDraft() {
    const recoveryKey = kitchenId
      ? kitchenRecoveryStorageKey(kitchenId)
      : RECOVERY_STORAGE_KEY
    const recovery = readWorkspaceFromStorageKey(recoveryKey)

    if (!recovery || (kitchenId && recovery.kitchenId !== kitchenId)) {
      setHistoryMessage('Belum ada backup Reset untuk dapur ini.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      return
    }

    const storedTransaction = recovery.transactions.find(
      (transaction) => transaction.id === recovery.activeTransactionId
    ) ?? recovery.transactions[0]

    if (!storedTransaction) {
      setHistoryMessage('Backup Reset tidak berisi transaksi yang bisa dipulihkan.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      return
    }

    const transaction = normalizeTransaction({ ...storedTransaction, id: 1 }, today)

    setKitchenId(recovery.kitchenId)
    setTransactions([transaction])
    setActiveTransactionId(1)
    persistWorkspace({
      kitchenId: recovery.kitchenId,
      activeTransactionId: 1,
      transactions: [transaction]
    })
    window.localStorage.removeItem(recoveryKey)

    setHistoryMessage('Draft sebelum Reset berhasil dipulihkan.')
    window.setTimeout(() => setHistoryMessage(''), 2200)
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen overflow-x-clip bg-slate-950 p-2 text-white sm:p-3 md:p-4">
      <div className="mx-auto w-full max-w-[960px]">
        <>
          <header className="flex w-full items-center justify-between gap-3 py-1">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-emerald-700/60 bg-emerald-950/50 shadow-sm" aria-hidden="true">
                <img src={appBrandIcon} alt="" className="h-10 w-10 object-contain" />
              </span>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-slate-50">Maker Pencairan</h1>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={theme === 'dark'}
              aria-label={theme === 'dark' ? 'Beralih ke tema terang' : 'Beralih ke tema gelap'}
              title={theme === 'dark' ? 'Ganti ke Light Mode' : 'Ganti ke Dark Mode'}
              data-theme={theme}
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
              className="theme-switch"
            >
              <span className="theme-switch__track" aria-hidden="true">
                <span className="theme-switch__thumb">
                  {theme === 'dark' ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20.2 15.4A8.4 8.4 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
                    </svg>
                  )}
                </span>
              </span>
            </button>
          </header>

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
              <div
                className={[
                  'mt-3 mb-2 grid min-w-0 grid-cols-1 items-stretch gap-2',
                  kitchenId && activeTransaction
                    ? 'lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.4fr)]'
                    : ''
                ].join(' ')}
              >
                <section className="mp-card flex h-full min-w-0 flex-col rounded-xl p-2.5">
                  <div className="grid min-w-0 items-end gap-2 sm:grid-cols-[145px_minmax(0,1fr)] lg:grid-cols-[145px_minmax(180px,260px)_auto] lg:justify-between">
                    <div className="min-w-0">
                      <label htmlFor="date" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Tanggal</label>
                      <div className="relative flex h-9 cursor-pointer items-center rounded-lg border border-slate-700 bg-slate-950 px-2.5 transition hover:border-emerald-500/70 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/25">
                        <span className="whitespace-nowrap text-[10px] font-semibold tracking-wide text-slate-500">TANGGAL</span>
                        <span className="ml-2 whitespace-nowrap text-xs font-semibold tabular-nums text-white">{formatDate(activeDate)}</span>
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

                    <div className="min-w-0">
                      <label htmlFor="kitchen" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Dapur</label>
                      <select
                        id="kitchen"
                        value={kitchenId}
                        title={selectedKitchen?.name ?? 'Pilih dapur'}
                        onChange={(event) => handleKitchenChange(event.target.value)}
                        className="h-9 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs font-semibold text-white outline-none transition hover:border-emerald-500/60 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25"
                      >
                        <option value="">Pilih dapur</option>
                        {masterData.kitchens.map((kitchen) => (
                          <option key={kitchen.id} value={kitchen.id}>
                            {kitchen.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex min-w-0 items-center gap-1.5 sm:col-span-2 lg:col-span-1">
                      <button
                        type="button"
                        onClick={restoreLastDraft}
                        className="h-9 min-w-0 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[10px] font-medium text-slate-200 shadow-sm transition hover:border-sky-500/70 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={resetWorkspace}
                        className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[10px] font-medium text-slate-200 shadow-sm transition hover:border-rose-500/70 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
                      >
                        Reset
                      </button>
                    </div>
                  </div>

                  {historyMessage && (
                    <div className="mt-1.5 text-[10px] text-emerald-300">
                      {historyMessage}
                    </div>
                  )}

                  {kitchenId && activeTransaction && (
                    <>
                      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 border-t border-slate-800/90 pt-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <h2 className="text-sm font-semibold">Output</h2>
                          <span
                            aria-label={outputLineCount + ' baris output'}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-700 bg-emerald-950/60 text-[10px] font-semibold tabular-nums text-emerald-200"
                          >
                            {outputLineCount}
                          </span>
                        </div>
                        <button
                          type="button"
                          data-button-kind="primary"
                          onClick={() => void copyOutput()}
                          disabled={!output}
                          className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[10px] font-semibold shadow-sm shadow-emerald-950/40 transition hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {copyMessage || 'Copy'}
                        </button>
                      </div>

                      <pre className="mt-2 min-h-[135px] max-h-[30vh] flex-1 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-slate-800 bg-gradient-to-b from-slate-950 to-slate-900/80 p-2 text-[10px] leading-4 text-slate-200 shadow-inner shadow-black/20">
                        {output}
                      </pre>

                    </>
                  )}
                </section>

                {kitchenId && activeTransaction && (
                  <aside className="mp-card flex h-full min-w-0 flex-col rounded-xl p-2.5" aria-label="Total nominal dan status pencairan">
                    <div className="space-y-2">
                      <div className="rounded-lg border border-slate-700/70 bg-slate-950/35 px-2.5 py-2 text-center">
                        <div className="text-[10px] text-slate-400">Total RAB</div>
                        <div className="mt-0.5 break-words text-lg font-semibold tabular-nums text-slate-100">Rp {formatNumber(String(totalRab)) || '0'}</div>
                      </div>
                      <div className="rounded-lg border border-slate-700/70 bg-slate-950/35 px-2.5 py-2 text-center">
                        <div className="text-[10px] text-slate-400">Total Ops Harian</div>
                        <div className="mt-0.5 break-words text-lg font-semibold tabular-nums text-slate-100">Rp {formatNumber(String(totalOpsHarian)) || '0'}</div>
                        {opsHarianBreakdown.length > 0 && (
                          <div className="mt-2 space-y-1 border-t border-slate-700/60 pt-2 text-[10px] text-slate-400">
                            {opsHarianBreakdown.map(({ label, amount }) => (
                              <div key={label} className="flex items-center justify-center gap-2">
                                <span>{label}</span>
                                <span className="tabular-nums text-slate-300">Rp {formatNumber(String(amount))}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {outputDisplayChecks.length > 0 && (
                      <div className="mt-auto flex w-full min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-slate-800/80 pt-2 text-center">
                        {outputDisplayChecks.map(({ label, complete }) => (
                          <span
                            key={label}
                            title={complete ? 'Sudah diisi' : 'Belum diisi'}
                            className={[
                              'text-center text-[10px] font-semibold leading-4 transition-colors',
                              complete ? 'text-emerald-400' : 'text-rose-400'
                            ].join(' ')}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </aside>
                )}
              </div>

              <div className="mp-form-stack flex min-w-0 w-full max-w-[960px] flex-col gap-3">
                {kitchenId && activeTransaction && (
                <>
                  <section className="mp-card w-full min-w-0 rounded-2xl border border-amber-500/45 bg-gradient-to-b from-slate-900 to-slate-950 p-3.5 shadow-lg shadow-black/15">
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
                        const customProducts = entry.productTypes
                          .filter((product) => !products.includes(product))
                          .slice(0, 3)
                        const customDraftKey = activeTransaction.id + ':' + rule.account_id
                        const customDraft = customRabDrafts[customDraftKey] ?? customProducts

                        return (
                          <div
                            key={rule.account_id}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_140px] items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 sm:gap-3"
                          >
                            <div className="min-w-0">
                              <div title={`${index + 1}. ${rule.supplier?.business_name ?? rule.accounts?.name ?? 'Tanpa nama'} - ${rule.accounts?.bank ?? '-'} (${rule.accounts?.account_number ?? '-'})`} className="truncate text-sm font-semibold text-white">
                                {index + 1}.{' '}
                                {rule.supplier?.business_name ??
                                  rule.accounts?.name ??
                                  'Tanpa nama'}{' '}
                                - {rule.accounts?.bank ?? '-'} (
                                {rule.accounts?.account_number ?? '-'})
                              </div>

                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  {products.map((product) => {
                                    const selected =
                                      entry.productTypes.includes(product)

                                    return (
                                      <button
                                        key={product}
                                        type="button"
                                        data-option-button="true"
                                        data-selected={selected}
                                        aria-pressed={selected}
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
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCustomRabOpen((current) => ({
                                        ...current,
                                        [rule.account_id]: !current[rule.account_id]
                                      }))
                                    }
                                    disabled={customProducts.length >= 3 && !customRabOpen[rule.account_id]}
                                    className="inline-flex h-9 items-center rounded-md border border-dashed border-sky-700 bg-sky-950/40 px-2.5 text-xs font-medium text-sky-200 transition hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    + Item Lain
                                  </button>
                                </div>
                                {customRabOpen[rule.account_id] && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {[0, 1, 2].map((fieldIndex) => (
                                      <input
                                        key={fieldIndex}
                                        type="text"
                                        value={customDraft[fieldIndex] ?? ''}
                                        maxLength={40}
                                        aria-label={'Item ' + (fieldIndex + 1)}
                                        onChange={(event) =>
                                          updateCustomRabProduct(
                                            activeTransaction.id,
                                            rule.account_id,
                                            fieldIndex,
                                            event.target.value,
                                            products
                                          )
                                        }
                                        placeholder={'Item ' + (fieldIndex + 1)}
                                        className={`h-8 w-[100px] rounded-md border border-slate-700 bg-slate-900 px-2 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500 ${hasOutputAmount('RAB : ', rule.accounts?.account_number ?? '-', entry.amount) && Boolean((customDraft[fieldIndex] ?? '').trim()) ? 'mp-field--has-output' : ''}`}
                                      />
                                    ))}
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
                              className={`h-10 w-full max-w-[140px] rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 ${hasOutputAmount('RAB : ', rule.accounts?.account_number ?? '-', entry.amount) ? 'mp-field--has-output' : ''}`}
                            />
                          </div>
                        )
                      }

                      return (
                        <div className="mt-2 space-y-3">
                          {sortedRabRules.map((rule, index) =>
                            renderRabRow(rule, index)
                          )}
                        </div>
                      )
                    })()}
                  </section>



                  {activeTransaction.gas.length > 0 && (
                    <section className="mp-card w-full min-w-0 rounded-xl border border-cyan-600/70 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-base font-semibold text-white">Pencairan Koperasi Arutala</h2>
                        <button
                          type="button"
                          onClick={addGasCustomEntry}
                          className="h-9 shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-100 transition hover:border-cyan-500/70 hover:bg-slate-700"
                        >
                          + Transaksi
                        </button>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        <div className="hidden lg:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 lg:grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(60px,0.4fr)_80px_105px_120px_30px]">
                          <span></span>
                          <span>Nama rekening</span>
                          <span>Bank</span>
                          <span>Nomor rekening</span>
                          <span>Catatan</span>
                          <span>Jumlah Gas</span>
                          <span>Ukuran Gas</span>
                          <span>Nominal</span>
                          <span></span>
                        </div>
                        {activeTransaction.gas.map((entry, index) => {
                          const rule = gasRules[0]
                          const accountName = rule?.supplier?.business_name || rule?.accounts?.name || 'Mapping belum tersedia'
                          const bank = rule?.accounts?.bank ?? '-'
                          const accountNumber = rule?.accounts?.account_number ?? '-'
                          const customNoteMode = index > 0
                          const note = index === 0 ? 'Gas' : (entry.need ?? '')
                          return (
                            <div key={entry.id} className={activeTransaction.gas.length > 1 ? 'rounded-lg border border-slate-800 bg-slate-950/40 p-2' : ''}>
                              <div className="grid min-w-0 items-end gap-2 lg:grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(60px,0.4fr)_80px_105px_120px_30px]">
                                {index === 0 ? (
                                  <div className="flex h-10 w-full items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-[10px] font-semibold text-slate-200">GAS</div>
                                ) : (
                                  <div className="flex h-10 w-full items-center justify-center rounded-md border border-amber-500/50 bg-amber-950/20 px-2 text-[10px] font-semibold text-amber-200">
                                    Custom
                                  </div>
                                )}
                                <div title={accountName} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">
                                  <span className="truncate">{accountName}</span>
                                </div>
                                <div title={bank} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">{bank}</div>
                                <div title={accountNumber} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">
                                  <span className="truncate">{accountNumber}</span>
                                </div>
                                <input
                                  type="text"
                                  required
                                  readOnly={index === 0 || !customNoteMode}
                                  value={note}
                                  onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { need: event.target.value })}
                                  placeholder="Wajib Isi Catatan"
                                  aria-label="Catatan pencairan Koperasi Arutala"
                                  className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 ${index === 0 || !customNoteMode ? 'bg-slate-800 text-slate-300' : 'bg-gradient-to-b from-slate-900 to-slate-950 text-slate-100'} ${customNoteMode ? 'lg:col-span-3 lg:min-w-[273px]' : ''} px-2.5 text-xs placeholder:text-slate-500 outline-none transition focus:border-cyan-500 ${hasOutputAmount(customNoteMode ? 'OPS HARIAN : ' : 'GAS : ', accountNumber, entry.amount) && Boolean(note.trim()) ? 'mp-field--has-output' : ''}`}
                                />
                                {index === 0 && (
                                  <>
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      required={isCompleteAmount(entry.amount)}
                                      value={entry.gasQuantity ?? ''}
                                      onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasQuantity: event.target.value.replace(/\D/g, '').replace(/^0+/, '') })}
                                      placeholder="Jumlah Gas"
                                      aria-label="Jumlah gas"
                                      className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-cyan-500"
                                    />
                                    <select
                                      required={isCompleteAmount(entry.amount)}
                                      value={entry.gasSize ?? ''}
                                      onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasSize: event.target.value as SimpleEntry['gasSize'] })}
                                      aria-label="Ukuran gas"
                                      className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-slate-950 px-2 text-xs text-slate-100 outline-none transition focus:border-cyan-500"
                                    >
                                      <option value="">Ukuran Gas</option>
                                      <option value="12kg">12 kg</option>
                                      <option value="50kg">50 kg</option>
                                    </select>
                                  </>
                                )}
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  required
                                  value={formatNumber(entry.amount)}
                                  disabled={!rule?.accounts}
                                  onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: event.target.value.replace(/\D/g, '') })}
                                  placeholder="Nominal"
                                  aria-label="Nominal pencairan Koperasi Arutala"
                                  className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount(customNoteMode ? 'OPS HARIAN : ' : 'GAS : ', accountNumber, entry.amount) && Boolean(note.trim()) ? 'mp-field--has-output' : ''}`}
                                />
                                <button
                                  type="button"
                                  onClick={() => removeGasEntry(entry.id)}
                                  disabled={index === 0}
                                  title="Hapus transaksi tambahan"
                                  aria-label="Hapus transaksi tambahan"
                                  className="h-10 w-full rounded-md border border-slate-800 bg-slate-900 text-base font-semibold text-slate-400 transition hover:border-rose-500/70 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-25"
                                >
                                  ×
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                  <section className="mp-card w-full min-w-0 rounded-xl border border-teal-600/70 bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-white">Operasional Harian</h2>
                      <button
                        type="button"
                        onClick={addOperationalEntry}
                        className="h-9 shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-100 transition hover:border-teal-500/70 hover:bg-slate-700"
                      >
                        + Transaksi
                      </button>
                    </div>
                    {(() => {
                      const mapping = getOperationalAccount(selectedKitchen?.name ?? '', masterData)
                      const entries = activeTransaction.operasional?.length
                        ? activeTransaction.operasional
                        : [createOperationalEntry()]
                      return (
                        <div className="mt-2 space-y-1.5">
                          <div className="hidden lg:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 lg:grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(170px,1.1fr)_120px_30px]">
                            <span></span>
                            <span>Nama rekening</span>
                            <span>Bank</span>
                            <span>Nomor rekening</span>
                            <span>Catatan</span>
                            <span>Nominal</span>
                            <span></span>
                          </div>
                          {entries.map((entry, index) => {
                            const custom = index > 0
                            const ownerName = custom ? (entry.ownerName || mapping?.ownerName || '') : mapping?.ownerName ?? ''
                            const bank = custom ? (entry.bank || mapping?.bank || '') : mapping?.bank ?? ''
                            const accountNumber = custom ? (entry.accountNumber || mapping?.accountNumber || '') : mapping?.accountNumber ?? ''
                            const note = custom ? (entry.need ?? '') : 'Ops Harian'
                            return (
                              <div key={entry.id} className={entries.length > 1 ? 'rounded-lg border border-slate-800 bg-slate-950/40 p-2' : ''}>
                                <div className="grid min-w-0 items-end gap-2 lg:grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(170px,1.1fr)_120px_30px]">
                                  <div className={`flex h-10 w-full items-center justify-center rounded-md border px-2 text-center text-[10px] font-semibold ${custom ? 'border-amber-500/50 bg-amber-950/20 text-amber-200' : 'border-slate-700 bg-slate-800 text-slate-200'}`}>
                                    {custom ? 'Custom' : 'Ops Harian'}
                                  </div>
                                  <div className="min-w-0">
                                    {custom ? (
                                      <input
                                        type="text"
                                        value={ownerName}
                                        onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { ownerName: event.target.value })}
                                        placeholder="Nama rekening"
                                        aria-label="Nama rekening Ops Harian"
                                        className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500"
                                      />
                                    ) : (
                                      <div title={ownerName || 'Mapping belum tersedia'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">
                                        <span className="truncate">{ownerName || 'Mapping belum tersedia'}</span>
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    {custom ? (
                                      <select
                                        value={entry.bank ?? ''}
                                        onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { bank: event.target.value })}
                                        aria-label="Bank Ops Harian"
                                        className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-slate-950 px-2 text-xs text-slate-100 outline-none transition focus:border-teal-500"
                                      >
                                        <option value="">Pilih bank</option>
                                        {CUSTOM_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                                      </select>
                                    ) : (
                                      <div title={bank || '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">{bank || '-'}</div>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    {custom ? (
                                      <input
                                        type="text"
                                        inputMode="numeric"
                                        value={entry.accountNumber}
                                        onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { accountNumber: event.target.value.replace(/\D/g, '') })}
                                        placeholder="Nomor rekening"
                                        aria-label="Nomor rekening Ops Harian"
                                        className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500"
                                      />
                                    ) : (
                                      <div title={accountNumber || '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountNumber || '-'}</span></div>
                                    )}
                                  </div>
                                  <input
                                    type="text"
                                    required={custom}
                                    readOnly={!custom}
                                    value={note}
                                    onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { need: event.target.value })}
                                    placeholder="Catatan"
                                    aria-label="Catatan Operasional Harian"
                                    className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 ${custom ? 'bg-gradient-to-b from-slate-900 to-slate-950 text-slate-100' : 'bg-slate-800 text-slate-300'} px-2.5 text-xs placeholder:text-slate-500 outline-none transition focus:border-teal-500`}
                                  />
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!custom && !mapping}
                                    onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: event.target.value.replace(/\D/g, '') })}
                                    placeholder="Nominal"
                                    aria-label="Nominal Ops Harian"
                                    className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount('OPS HARIAN : ', accountNumber, entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => removeOperationalEntry(entry.id)}
                                    disabled={index === 0}
                                    title="Hapus transaksi tambahan Operasional Harian"
                                    aria-label="Hapus transaksi Ops Harian"
                                    className="h-10 w-full rounded-md border border-slate-800 bg-slate-900 text-base font-semibold text-slate-400 transition hover:border-rose-500/70 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-25"
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </section>

                  <div className="w-full min-w-0 space-y-3">
                    <section className="mp-card w-full min-w-0 rounded-xl border border-sky-600/60 bg-sky-950/10 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Insentif Fasilitas SPPG</h2>
                      <div className="mt-2 space-y-1.5">
                        <div className="hidden sm:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 sm:grid-cols-[minmax(180px,1.2fr)_90px_minmax(130px,0.9fr)_140px]">
                          <span>Nama rekening</span>
                          <span>Bank</span>
                          <span>Nomor rekening</span>
                          <span>Nominal</span>
                        </div>
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'sewa')
                          .map((entry) => {
                            const rental = getSppgRental(selectedKitchen?.name ?? '', masterData)
                            return (
                              <div
                                key={entry.id}
                                className="grid min-w-0 items-stretch gap-2 sm:grid-cols-[minmax(180px,1.2fr)_90px_minmax(130px,0.9fr)_140px]"
                              >
                                  <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                    <span title={rental?.ownerName ?? 'Mapping belum tersedia'} className="truncate">{rental?.ownerName ?? 'Mapping belum tersedia'}</span>
                                  </div>
                                  <div title={rental?.bank ?? '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                    {rental?.bank ?? '-'}
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                    <span title={rental?.accountNumber ?? '-'} className="truncate">{rental?.accountNumber ?? '-'}</span>
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
                                    aria-label="Nominal Insentif Fasilitas SPPG"
                                    className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount('INSENTIF FASILITAS SPPG : ', rental?.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />
                              </div>
                            )
                          })}
                      </div>
                    </section>

                    <section className="mp-card w-full min-w-0 rounded-xl border border-orange-600/70 bg-slate-900/40 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Sewa Kendaraan</h2>
                      {(() => {
                        const entry = activeTransaction.sewa_kendaraan?.[0] ?? emptyVehicleRentEntry()
                        const account = getVehicleRentAccount(selectedKitchen?.name ?? '', masterData)
                        return (
                          <>
                            <div className="hidden lg:grid min-w-0 items-center gap-2 px-0.5 pt-2 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 lg:grid-cols-[minmax(125px,1fr)_88px_minmax(100px,0.7fr)_minmax(145px,1fr)_140px_140px]">
                              <span>Nama rekening</span>
                              <span>Bank</span>
                              <span>Nomor rekening</span>
                              <span>Periode sewa</span>
                              <span>Nominal mobil</span>
                              <span>Nominal motor</span>
                            </div>
                            <div className="mt-1.5 grid min-w-0 grid-cols-2 items-stretch gap-2 sm:grid-cols-4 lg:grid-cols-[minmax(125px,1fr)_88px_minmax(100px,0.7fr)_minmax(145px,1fr)_140px_140px]">
                              <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                <span title={account?.ownerName ?? 'Mapping belum tersedia'} className="truncate">{(account?.ownerName ?? '').trim().toLocaleLowerCase('id-ID') === 'berkah mandiri putra' ? 'BMP' : account?.ownerName ?? 'Mapping belum tersedia'}</span>
                              </div>
                              <div title={account?.bank ?? '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                {account?.bank ?? '-'}
                              </div>
                              <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                <span title={account?.accountNumber ?? '-'} className="truncate">{account?.accountNumber ?? '-'} </span>
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
                                active={
                                  hasOutputAmount('SEWA KENDARAAN MOBIL (', account?.accountNumber ?? '-', entry.mobilAmount) ||
                                  hasOutputAmount('SEWA KENDARAAN MOTOR (', account?.accountNumber ?? '-', entry.motorAmount)
                                }
                              />
                              <div className="min-w-0">
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
                                  className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 ${isCompleteAmount(entry.mobilAmount) ? 'mp-field--has-output' : ''}`}
                                />
                              </div>
                              <div className="min-w-0">
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
                                  className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 ${isCompleteAmount(entry.motorAmount) ? 'mp-field--has-output' : ''}`}
                                />
                              </div>
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

                          </>
                        )
                      })()}
                    </section>

                    <section className="mp-card w-full min-w-0 rounded-xl border border-violet-600/60 bg-violet-950/10 p-3">
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

                      <div className="mt-2 space-y-1.5">
                        <div className="hidden lg:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 lg:grid-cols-[minmax(180px,1.05fr)_minmax(180px,1.1fr)_90px_minmax(130px,0.9fr)_140px]">
                          <span>Jenis pencairan</span>
                          <span>Nama rekening</span>
                          <span>Bank</span>
                          <span>Nomor rekening</span>
                          <span>Nominal</span>
                        </div>
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'gaji')
                          .map((entry) => {
                            const mapping = getDailyPaymentMappingForKinds(
                              selectedKitchen?.name ?? '',
                              entry.kinds,
                              masterData
                            )
                            const combined = entry.kinds.length > 1
                            const label = combined
                              ? entry.kinds.join(' + ')
                              : entry.kinds[0] ?? 'Jenis belum dimapping'

                            return (
                              <div key={entry.id}>
                                <div className="grid min-w-0 items-stretch gap-2 lg:grid-cols-[minmax(180px,1.05fr)_minmax(180px,1.1fr)_90px_minmax(130px,0.9fr)_140px]">
                                  <div
                                    title={label}
                                    className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100"
                                  >
                                    <span title={label} className="truncate">{label}</span>
                                  </div>
                                  <div
                                    title={mapping?.ownerName ?? 'Mapping belum tersedia'}
                                    className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100"
                                  >
                                    <span title={mapping?.ownerName ?? 'Mapping belum tersedia'} className="truncate">{mapping?.ownerName ?? 'Mapping belum tersedia'}</span>
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                    {mapping?.bank ?? '-'}
                                  </div>
                                  <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 text-center text-sm font-semibold text-slate-100">
                                    <span title={mapping?.accountNumber ?? '-'} className="truncate">{mapping?.accountNumber ?? '-'}</span>
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
                                    className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount(entry.kinds.join(', ').toLocaleUpperCase('id-ID') + ' : ', mapping?.accountNumber ?? entry.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    </section>

                    
                  </div>




                </>
              )}
              </div>
            </>
          )}
        </>
      </div>
    </main>
  )
}

export default App
