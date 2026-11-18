import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import appBrandIcon from '../fav.svg'
import {
  getMakerMasterData,
  type MakerMasterData,
  type MakerAccountRule,
  type MakerOperationalRule
} from './services/master-data'
import { supabase } from './lib/supabase'
import HistoryPanel from './HistoryPanel'

type RabEntry = {
  accountId: string
  productTypes: string[]
  amount: string
  b3Enabled?: boolean
  b3ProductTypes?: string[]
  b3Amount?: string
}

type OtherTransactionType = '' | 'operasional_harian' | 'lain_lain' | 'gas'

type SimpleEntry = {
  id: number
  accountId: string
  amount: string
  accountNumber: string
  ownerName: string
  bank?: string
  isVirtualAccount?: boolean
  customAccount?: boolean
  operationalRuleType?: 'ops_harian' | 'gaji_akuntan' | 'gaji_ahli_gizi' | ''
  operationalRuleId?: string
  need: string
  gasQuantity?: string
  gasSize?: '' | '12kg' | '50kg'
  transactionType: OtherTransactionType
  useArutalaAccount?: boolean
}

type DailyPaymentKind =
  | 'Sewa SPPG'
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

type ArutalaDateBucket = {
  gas: SimpleEntry[]
  lain_lain: SimpleEntry[]
}

type TransactionGroup = {
  id: number
  date: string
  rab: RabEntry[]
  gas: SimpleEntry[]
  operasional: SimpleEntry[]
  legacy_gaji?: DailyPaymentEntry[]
  pencairan_harian: DailyPaymentEntry[]
  lain_lain: SimpleEntry[]
  arutala_lain_lain: SimpleEntry[]
  arutala_by_date?: Record<string, ArutalaDateBucket>
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
const KITCHEN_WORKSPACE_STORAGE_PREFIX = 'maker-pencairan-kitchen-workspace-v1:'
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
  'Insentif PIC Posyandu': 'pic_incentive_posyandu'
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

function getOperationalRules(
  kitchenId: string,
  masterData: MakerMasterData | null
): MakerOperationalRule[] {
  if (!masterData || !kitchenId) return []
  return masterData.operational_rules
    .filter((rule) => rule.kitchen_id === kitchenId && rule.rule_type === 'ops_harian' && rule.is_active)
    
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
    | 'gas'
    | 'lain_lain'
) {
  if (kind === 'rab') return 0
  if (kind === 'operasional_harian') return 1
  if (kind === 'pencairan_harian') return 2
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

function persistWorkspace(workspace: Omit<SavedWorkspace, 'version'>) {
  if (!workspace.kitchenId) return
  persistWorkspaceToKey(workspace, STORAGE_KEY)
  persistWorkspaceToKey(workspace, kitchenWorkspaceStorageKey(workspace.kitchenId))
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
    operationalRuleType: '',
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
    ? transaction.pencairan_harian.filter((entry) => {
        const legacyEntry = entry as DailyPaymentEntry & { kind?: string }
        const storedKinds = Array.isArray(entry.kinds) ? entry.kinds : legacyEntry.kind ? [legacyEntry.kind] : []
        return !storedKinds.some((kind) => String(kind) === 'Sewa Kendaraan')
      }).map((entry) => {
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

  const sewaRows = rawDailyPayments.filter((entry) => entry.category === 'sewa')
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

  const normalizedGas: SimpleEntry[] = Array.isArray(transaction.gas)
    ? transaction.gas.map((entry, index) => {
        const isGasEntry = entry.transactionType === 'gas' || (index === 0 && !entry.transactionType)
        const normalizedEntry: SimpleEntry = {
          ...entry,
          gasQuantity: typeof entry.gasQuantity === 'string' ? entry.gasQuantity.replace(/\D/g, '') : '',
          gasSize: entry.gasSize === '12kg' || entry.gasSize === '50kg' ? entry.gasSize : '',
          ownerName: sanitizeOwnerName(entry.ownerName ?? ''),
          bank: entry.bank ?? '',
          customAccount: !isGasEntry,
          transactionType: entry.transactionType === 'gas'
            ? 'gas'
            : isGasEntry ? '' : 'operasional_harian'
        }
        return {
          ...normalizedEntry,
          need: isGasEntry ? 'Gas' : (entry.need ?? ''),
          gasQuantity: isGasEntry ? normalizedEntry.gasQuantity : '',
          gasSize: isGasEntry ? normalizedEntry.gasSize : ''
        }
      }).filter((entry, index) =>
        index !== 0 || isCompleteAmount(entry.amount) ||
        Boolean(entry.gasQuantity || entry.gasSize) || entry.transactionType === 'gas'
      )
    : []

  const normalizedGasEntries = normalizedGas.filter((entry) => entry.transactionType !== 'operasional_harian')
  const legacyArutalaOpsFromGas = normalizedGas.filter((entry) => entry.transactionType === 'operasional_harian')

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
  const normalizeOpsEntry = (entry: SimpleEntry, index: number): SimpleEntry => {
    const isLegacyMappedOps = index === 0 && !entry.customAccount &&
      !entry.useArutalaAccount && !entry.operationalRuleType
    return {
      ...createOperationalEntry(entry.id),
      ...entry,
      accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''),
      ownerName: entry.ownerName ?? '',
      bank: entry.bank ?? '',
      customAccount: Boolean(entry.customAccount ?? index > 0),
      operationalRuleType: entry.operationalRuleType || (isLegacyMappedOps ? 'ops_harian' : ''),
      need: entry.need || (isLegacyMappedOps ? 'Ops Harian' : ''),
      transactionType: 'operasional_harian'
    }
  }
  const oldOpsTotal = legacyOps.reduce(
    (total, entry) => total + Number((entry.amount ?? '').replace(/\D/g, '')),
    0
  )
  const normalizedExistingOps = existingOps
    .map((entry, index) => normalizeOpsEntry(entry, index))
    .filter((entry) => !(
      entry.operationalRuleType === 'ops_harian' &&
      !entry.operationalRuleId &&
      !isCompleteAmount(entry.amount) &&
      !entry.ownerName.trim() &&
      !(entry.bank ?? '').trim() &&
      !entry.accountNumber.trim()
    ))
  const baseOperational: SimpleEntry[] = normalizedExistingOps.length > 0
    ? normalizedExistingOps
    : legacyOps.length > 0
      ? [{
          ...createOperationalEntry(legacyOps[0].id),
          operationalRuleType: 'ops_harian',
          amount: String(oldOpsTotal || legacyOps[0].amount || '')
        }]
      : []
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
  const lain_lain = [emptySimpleEntry(1)]
  const arutalaLainLain = Array.isArray(transaction.arutala_lain_lain)
    ? transaction.arutala_lain_lain.map((entry) => ({ ...entry, transactionType: 'lain_lain' as const, accountNumber: (entry.accountNumber ?? '').replace(/\D/g, ''), ownerName: entry.ownerName ?? '' }))
    : []
  const migratedArutala: SimpleEntry[] = [...legacyArutalaOpsFromGas, ...arutalaLainLain].map((entry, index) => {
    const id = lastOpsId + migratedLainLain.length + index + 1
    return {
      ...entry,
      ...createOperationalEntry(id),
      id,
      useArutalaAccount: true,
      customAccount: true,
      operationalRuleType: '',
      transactionType: 'operasional_harian',
      need: entry.need ?? ''
    }
  })
  const operational = baseOperational.concat(migratedLainLain, migratedArutala)
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
    rab: Array.isArray(transaction.rab) ? transaction.rab.map((entry) => ({
      ...entry,
      b3Enabled: Boolean(entry.b3Enabled || entry.b3Amount),
      b3ProductTypes: Array.isArray(entry.b3ProductTypes) ? entry.b3ProductTypes : [],
      b3Amount: typeof entry.b3Amount === 'string' ? entry.b3Amount : ''
    })) : [],
    gas: normalizedGasEntries,
    operasional: operational,
    pencairan_harian: normalizedSewa.concat(
      rawDailyPayments.filter((entry) => entry.category === 'gaji')
    ),
    lain_lain: lain_lain.length > 0 ? lain_lain : [emptySimpleEntry(1)],
    arutala_lain_lain: [],
    arutala_by_date: {
      ...(transaction.arutala_by_date ?? {}),
      [transaction.date || fallbackDate]: { gas: normalizedGasEntries, lain_lain: migratedArutala }
    },
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
  void gasRules

  return {
    id,
    date,
    rab: rabRules.map((rule) => ({
      accountId: rule.account_id,
      productTypes: [],
      amount: ''
    })),
    gas: [],
    operasional: [],
    pencairan_harian: [
      { ...emptyDailyPaymentEntry(1, 'sewa'), kinds: ['Sewa SPPG'] },
      ...createPayrollRowsForKitchen(kitchenName, masterData, 2)
    ],
    lain_lain: [emptyOtherEntry(1)],
    arutala_lain_lain: [],
    arutala_by_date: { [date]: { gas: [], lain_lain: [] } },
    opsRealAmount: '',
    legacy_gaji: []
  }
}

function MakerWorkspace({ fixedKitchen = false, token, role = 'admin' }: { fixedKitchen?: boolean; token: string; role: 'admin' | 'accountant' }) {
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySaveOpen, setHistorySaveOpen] = useState(false)
  const [historySaveType, setHistorySaveType] = useState<'REVISI' | 'KEKURANGAN' | 'TAMBAHAN'>('REVISI')
  const [historySaveSummary, setHistorySaveSummary] = useState('')
  const [historyChangeBase, setHistoryChangeBase] = useState<Record<string, unknown> | null>(null)
  const [historyEntryKeys, setHistoryEntryKeys] = useState<string[]>([])
  const [historyShortageKeys, setHistoryShortageKeys] = useState<string[]>([])
  const historyChangeActive = Boolean(historyChangeBase)
  const isHistoryShortage = (key: string) => historyShortageKeys.includes(key)
  const toggleHistoryShortage = (key: string, enabled: boolean) => setHistoryShortageKeys(current => enabled ? [...new Set([...current, key])] : current.filter(item => item !== key))
  const historyPreviousAmount = (key: string) => {
    const base = historyChangeBase?.transaction as TransactionGroup | undefined
    if (!base) return ''
    const separator = key.indexOf(':')
    const field = key.slice(0, separator)
    const id = key.slice(separator + 1)
    if (field === 'rab' || field === 'rab_b3') {
      const row = base.rab.find(item => item.accountId === id)
      return field === 'rab_b3' ? row?.b3Amount ?? '' : row?.amount ?? ''
    }
    const rows = base[field as keyof TransactionGroup] as Array<{ id: number; amount: string }> | undefined
    return rows?.find(row => String(row.id) === id)?.amount ?? ''
  }
  const renderHistoryShortageButton = (key: string, onEnable: () => void) => {
    if (!historyChangeActive || !historyEntryKeys.includes(key)) return null
    const enabled = isHistoryShortage(key)
    const previous = historyPreviousAmount(key)
    return <button type="button" aria-pressed={enabled} title={`Nominal sebelumnya: Rp ${formatNumber(previous) || '0'}`} onClick={() => { toggleHistoryShortage(key, !enabled); if (!enabled) onEnable() }} className={`h-10 shrink-0 rounded-md border px-3 text-xs font-semibold transition ${enabled ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-amber-500/70 hover:text-amber-200'}`}>Kekurangan</button>
  }
  const getHistoryEntryKeys = (transaction: TransactionGroup) => [
    ...transaction.rab.flatMap(row => [
      'rab:' + row.accountId,
      ...(row.b3Enabled || isCompleteAmount(row.b3Amount ?? '') ? ['rab_b3:' + row.accountId] : [])
    ]),
    ...(['gas', 'operasional', 'pencairan_harian', 'lain_lain', 'arutala_lain_lain'] as const).flatMap(field =>
      (transaction[field] ?? []).map(row => field + ':' + row.id)
    )
  ]
  const isHistoryEntryEnabled = (key: string) => !historyChangeActive || historyEntryKeys.includes(key)
  const isHistoryRabEnabled = (accountId: string) => isHistoryEntryEnabled('rab:' + accountId)
  const isHistoryRabB3Enabled = (accountId: string) => isHistoryEntryEnabled('rab_b3:' + accountId)
  const isHistoryRowEnabled = (field: string, id: number) => {
    if (!historyChangeActive) return true
    const key = field + ':' + id
    if (historyEntryKeys.includes(key)) return true
    const base = historyChangeBase?.transaction as TransactionGroup | undefined
    const baseRows = (base as unknown as Record<string, Array<{ id: number }> | undefined> | undefined)?.[field]
    return !(baseRows ?? []).some(row => String(row.id) === String(id))
  }
  const [historySaveBusy, setHistorySaveBusy] = useState(false)
  const [operationalAddMenuOpen, setOperationalAddMenuOpen] = useState(false)
  const [customRabOpen, setCustomRabOpen] = useState<Record<string, boolean>>({})
  const [customRabDrafts, setCustomRabDrafts] = useState<Record<string, string[]>>({})
  const dateInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef({
    kitchenId: saved?.kitchenId ?? '',
    activeTransactionId: 1,
    transactions: initialTransaction ? [initialTransaction] : []
  })

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  }, [])

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

  useEffect(() => {
    if (!fixedKitchen || !masterData || masterData.kitchens.length !== 1) return
    const assignedKitchen = masterData.kitchens[0]
    if (kitchenId !== assignedKitchen.id) handleKitchenChange(assignedKitchen.id)
  }, [fixedKitchen, masterData, kitchenId])

  const selectedKitchen = masterData?.kitchens.find(
    (kitchen) => kitchen.id === kitchenId
  )
  const isCihaurKitchen = (selectedKitchen?.name ?? '').trim().toLocaleLowerCase('id-ID') === 'cihaur'
  const opsMappings = useMemo(() => getOperationalRules(kitchenId, masterData), [kitchenId, masterData])

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

  const arutalaGasRule = gasRules.find((rule) =>
    (rule.accounts?.name ?? '').trim().toLocaleLowerCase('id-ID') === 'koperasi arutala' &&
    (rule.accounts?.bank ?? '').trim().toUpperCase() === 'BNI' &&
    (rule.accounts?.account_number ?? '').replace(/\D/g, '') === '1985322260'
  )

  const activeTransaction =
    transactions.find(
      (transaction) => transaction.id === activeTransactionId
    ) ?? transactions[0]
  const operationalEntries = activeTransaction?.operasional ?? []

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
          ? (() => {
              const nextTransaction = { ...transaction, ...update }
              if (!('arutala_by_date' in update) && ('gas' in update || 'operasional' in update || 'arutala_lain_lain' in update)) {
                nextTransaction.arutala_by_date = {
                  ...(transaction.arutala_by_date ?? {}),
                  [nextTransaction.date]: {
                    gas: nextTransaction.gas ?? [],
                    lain_lain: (nextTransaction.operasional ?? []).filter((entry) => entry.useArutalaAccount)
                  }
                }
              }
              return nextTransaction
            })()
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
    section: 'gas' | 'operasional' | 'lain_lain' | 'arutala_lain_lain',
    id: number,
    update: Partial<SimpleEntry>
  ) {
    setTransactions((current) =>
      current.map((transaction) => {
        if (transaction.id !== transactionId) return transaction
        const entries = transaction[section] ?? []
        const nextEntries = entries.map((entry) =>
          entry.id === id ? { ...entry, ...update } : entry
        )
        const nextTransaction = { ...transaction, [section]: nextEntries }
        if (section === 'gas' || section === 'operasional' || section === 'arutala_lain_lain') {
          nextTransaction.arutala_by_date = {
            ...(transaction.arutala_by_date ?? {}),
            [transaction.date]: {
              gas: section === 'gas' ? nextEntries as SimpleEntry[] : transaction.gas ?? [],
              lain_lain: section === 'operasional'
                ? (nextEntries as SimpleEntry[]).filter((entry) => entry.useArutalaAccount)
                : section === 'arutala_lain_lain'
                  ? nextEntries as SimpleEntry[]
                  : (transaction.operasional ?? []).filter((entry) => entry.useArutalaAccount)
            }
          }
        }
        return nextTransaction
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

  function addMappedOperationalEntry(ruleId: string) {
    if (!activeTransaction) return
    const rule = getOperationalRules(kitchenId, masterData).find((item) => item.id === ruleId)
    if (!rule) {
      setHistoryMessage('Mapping Ops Harian tidak tersedia atau sudah dinonaktifkan.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      return
    }
    const entries = activeTransaction.operasional ?? []
    if (entries.some((entry) => entry.operationalRuleId === rule.id || (
      entry.operationalRuleType === 'ops_harian' &&
      entry.ownerName.trim() === rule.owner_name.trim() &&
      (entry.bank ?? '').trim().toUpperCase() === rule.bank.trim().toUpperCase() &&
      entry.accountNumber.replace(/\D/g, '') === rule.account_number.replace(/\D/g, '')
    ))) {
      setHistoryMessage('Mapping rekening ini sudah ditambahkan.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      setOperationalAddMenuOpen(false)
      return
    }
    const nextId = Math.max(0, ...entries.map((entry) => entry.id)) + 1
    updateTransaction(activeTransaction.id, {
      operasional: [...entries, {
        ...createOperationalEntry(nextId),
        operationalRuleType: 'ops_harian',
        operationalRuleId: rule.id,
        ownerName: rule.owner_name,
        bank: rule.bank,
        accountNumber: rule.account_number.replace(/\D/g, ''),
        customAccount: false,
        useArutalaAccount: false,
        need: 'Ops Harian'
      }]
    })
    setOperationalAddMenuOpen(false)
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
        operationalRuleType: '',
        useArutalaAccount: false,
        isVirtualAccount: false,
        need: ''
      }]
    })
    setOperationalAddMenuOpen(false)
  }

  function addGasEntry() {
    if (!activeTransaction) return
    const currentEntries = activeTransaction.gas ?? []
    const gasCount = currentEntries.filter((entry, index) => entry.transactionType === 'gas' || (index === 0 && !entry.transactionType)).length
    if (gasCount >= 2) {
      setHistoryMessage('Maksimal 2 transaksi GAS untuk tanggal ini.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      return
    }
    const rule = arutalaGasRule
    if (!rule?.accounts) {
      setHistoryMessage('Mapping rekening GAS belum tersedia.')
      window.setTimeout(() => setHistoryMessage(''), 2200)
      return
    }
    const nextId = Math.max(0, ...currentEntries.map((entry) => entry.id)) + 1
    const accountName = rule.supplier?.business_name || rule.accounts.name || ''
    updateTransaction(activeTransaction.id, {
      gas: [...currentEntries, { ...emptySimpleEntry(nextId), accountId: rule.account_id, ownerName: accountName, bank: rule.accounts.bank ?? '', accountNumber: rule.accounts.account_number ?? '', need: 'Gas', gasQuantity: '', gasSize: '', customAccount: false, transactionType: 'gas' }]
    })
    setOperationalAddMenuOpen(false)
  }

  function removeGasEntry(id: number) {
    if (!activeTransaction) return
    updateTransaction(activeTransaction.id, { gas: (activeTransaction.gas ?? []).filter((entry) => entry.id !== id) })
  }

  function addArutalaOtherEntry() {
    if (!activeTransaction) return
    const entries = activeTransaction.operasional ?? []
    const nextId = Math.max(0, ...entries.map((entry) => entry.id)) + 1
    const account = arutalaGasRule?.accounts
    const ownerName = arutalaGasRule?.supplier?.business_name || account?.name || 'Koperasi Arutala'
    updateTransaction(activeTransaction.id, {
      operasional: [...entries, {
        ...createOperationalEntry(nextId),
        accountId: arutalaGasRule?.account_id ?? '',
        ownerName,
        bank: account?.bank ?? '',
        accountNumber: account?.account_number ?? '',
        customAccount: true,
        operationalRuleType: '',
        useArutalaAccount: true,
        isVirtualAccount: false,
        need: ''
      }]
    })
    setOperationalAddMenuOpen(false)
  }

  function removeOperationalEntry(id: number) {
    if (!activeTransaction) return
    const remaining = (activeTransaction.operasional ?? []).filter((entry) => entry.id !== id)
    updateTransaction(activeTransaction.id, {
      operasional: remaining
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
    if (!activeTransaction || !nextDate || nextDate === activeTransaction.date) return
    const dateBuckets = activeTransaction.arutala_by_date ?? {}
    const currentBucket: ArutalaDateBucket = {
      gas: activeTransaction.gas ?? [],
      lain_lain: (activeTransaction.operasional ?? []).filter((entry) => entry.useArutalaAccount)
    }
    const nextBucket = dateBuckets[nextDate] ?? { gas: [], lain_lain: [] }
    const nextLegacyArutalaOpsFromGas = nextBucket.gas.filter((entry) => entry.transactionType === 'operasional_harian')
    const nextGasEntries = nextBucket.gas.filter((entry) => entry.transactionType !== 'operasional_harian')
    const baseOperational = (activeTransaction.operasional ?? []).filter((entry) => !entry.useArutalaAccount)
    const nextArutalaEntries = [...nextLegacyArutalaOpsFromGas, ...nextBucket.lain_lain].map((entry, index) => {
      const id = Math.max(0, ...baseOperational.map((item) => item.id)) + index + 1
      return {
        ...entry,
        ...createOperationalEntry(id),
        id,
        useArutalaAccount: true,
        customAccount: true,
        operationalRuleType: '' as const,
        transactionType: 'operasional_harian' as const,
        need: entry.need ?? ''
      }
    })
    updateTransaction(activeTransaction.id, {
      date: nextDate,
      arutala_by_date: { ...dateBuckets, [activeTransaction.date]: currentBucket },
      gas: nextGasEntries,
      arutala_lain_lain: [],
      operasional: baseOperational.concat(nextArutalaEntries)
    })
    setCopyMessage('')
  }

  function resetWorkspace() {
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
    setHistoryChangeBase(null)
    setHistoryEntryKeys([])
    setTransactions(nextTransaction.date ? [nextTransaction] : [])
    setActiveTransactionId(1)
    setCopyMessage('')
    setHistoryMessage('Form berhasil direset. Snapshot tersimpan tetap tersedia di Riwayat.')
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
    const operationalRules = getOperationalRules(kitchenId, masterData)
    const arutalaRule = arutalaGasRule
    const arutalaAccount = arutalaRule?.accounts
    const arutalaOwnerName = arutalaRule?.supplier?.business_name || arutalaAccount?.name || ''

    for (const [operationalIndex, operationalEntry] of (transaction.operasional ?? []).entries()) {
      if (!isCompleteAmount(operationalEntry.amount)) continue
      const isMappedOps = operationalEntry.operationalRuleType === 'ops_harian'
      const isArutala = Boolean(operationalEntry.useArutalaAccount)
      const isMappedSalary = operationalEntry.operationalRuleType === 'gaji_akuntan' ||
        operationalEntry.operationalRuleType === 'gaji_ahli_gizi'
      const custom = !isMappedOps && !isArutala && !isMappedSalary &&
        (operationalIndex > 0 || Boolean(operationalEntry.customAccount))
      const mappedOpsRule = isMappedOps
        ? operationalRules.find((rule) => rule.id === operationalEntry.operationalRuleId)
        : null
      const selectedCustomMapping = isMappedSalary && operationalEntry.operationalRuleType
        ? getOperationalMapping(kitchenName, masterData, operationalEntry.operationalRuleType)
        : null
      const bank = getOutputBank(isArutala
        ? arutalaAccount?.bank ?? ''
        : isMappedOps
          ? mappedOpsRule?.bank || operationalEntry.bank || mappedOperationalAccount?.bank || ''
          : isMappedSalary
            ? selectedCustomMapping?.bank ?? operationalEntry.bank ?? ''
            : custom
              ? operationalEntry.bank ?? ''
              : mappedOperationalAccount?.bank ?? '')
      const accountNumber = (isArutala
        ? arutalaAccount?.account_number ?? ''
        : isMappedOps
          ? mappedOpsRule?.account_number || operationalEntry.accountNumber || mappedOperationalAccount?.accountNumber || ''
          : isMappedSalary
            ? selectedCustomMapping?.accountNumber ?? operationalEntry.accountNumber ?? ''
            : custom
              ? operationalEntry.accountNumber ?? ''
              : mappedOperationalAccount?.accountNumber ?? '').trim()
      const ownerName = (isArutala
        ? arutalaOwnerName
        : isMappedOps
          ? mappedOpsRule?.owner_name || operationalEntry.ownerName || mappedOperationalAccount?.ownerName || ''
          : isMappedSalary
            ? selectedCustomMapping?.ownerName ?? operationalEntry.ownerName ?? ''
            : custom
              ? operationalEntry.ownerName ?? ''
              : mappedOperationalAccount?.ownerName ?? '').trim()
      if (!bank || !accountNumber || !ownerName) continue

      const note = (operationalEntry.need ?? (isMappedOps ? 'Ops Harian' : '')).trim()
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
          ' · ' +
          note +
          (custom && !isArutala && operationalEntry.isVirtualAccount ? ' · VA' : '') +
          ' · ' +
          formatNumber(operationalEntry.amount),
        kind: 'operasional_harian'
      })
    }

    return outputs
  }

    function getTransactionOutput(transaction: TransactionGroup, eventType?: 'REVISI' | 'KEKURANGAN' | 'TAMBAHAN') {
    type OutputItem = {
      kind:
        | 'rab'
        | 'pencairan_harian'
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
      const isGasEntry = entry.transactionType === 'gas' || (entryIndex === 0 && !entry.transactionType)
      const customNoteMode = !isGasEntry
      const quantity = (entry.gasQuantity ?? '').replace(/\D/g, '').replace(/^0+/, '')
      const size = entry.gasSize === '12kg' || entry.gasSize === '50kg' ? entry.gasSize : ''
      const note = customNoteMode
        ? (entry.need ?? '').trim()
        : quantity && size
          ? 'Gas ' + size + ' (' + quantity + ' tabung)'
          : 'Gas'
      if (!note) continue

      const rule = arutalaGasRule
      if (!rule?.accounts) continue
      const rawAccountName = rule.supplier?.business_name || rule.accounts.name
      const bank = getOutputBank(rule.accounts.bank)
      const accountNumber = (rule.accounts.account_number ?? '-').trim()

      items.push({
        kind: 'operasional_harian',
        bank,
        line: 'OPS HARIAN : ' + capitalizeEachWord(rawAccountName) +
          ' - ' + bank + ' / ' + accountNumber +
          ' · ' + note + ' · ' + formatNumber(entry.amount),
        index: items.length,
        modeRank: 0
      })
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

    for (const rule of sortedRabRules) {
      const entry = transaction.rab.find(
        (item) => item.accountId === rule.account_id
      )
      if (!entry || !rule.accounts) continue

      const hasAmount = isCompleteAmount(entry.amount)
      const hasB3Amount = isCompleteAmount(entry.b3Amount ?? '')
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
      if (!hasAmount && !hasB3Amount) continue
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

      if (hasAmount) {
        items.push({
          kind: 'rab',
          bank: getOutputBank(rule.accounts.bank),
          line: 'RAB : ' + outputLine,
          index: items.length,
          modeRank: 0
        })
      }
      if (hasB3Amount) {
        const b3Products = sortStrings(entry.b3ProductTypes ?? [])
          .map((product) => catalogProducts.includes(product) ? product : capitalizeEachWord(product))
        const b3ProductText = b3Products.length <= 1
          ? (b3Products[0] ?? '')
          : b3Products.length === 2
            ? b3Products[0] + ' dan ' + b3Products[1]
            : b3Products.slice(0, -1).join(', ') + ', dan ' + b3Products[b3Products.length - 1]
        const b3OutputLine = b3ProductText
          ? accountText + ' · ' + b3ProductText + ' · ' + formatNumber(entry.b3Amount ?? '')
          : accountText + ' · ' + formatNumber(entry.b3Amount ?? '')
        items.push({
          kind: 'rab',
          bank: getOutputBank(rule.accounts.bank),
          line: 'RAB B3 : ' + b3OutputLine,
          index: items.length,
          modeRank: 0
        })
      }
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

    const normalizedKitchenName = kitchenName.trim().toLocaleLowerCase('id-ID')
    const headerSuffix = normalizedKitchenName === 'cibaregbeg'
      ? ' (29)'
      : normalizedKitchenName === 'warungbitung'
        ? ' (37)'
        : ''
    const eventMarker = eventType ? eventType + ' - ' : ''
    const headerLine = eventMarker + kitchenName + ', ' + formatDate(transaction.date) + headerSuffix
    const mainLines = items.length > 0
      ? [headerLine, ...items.map((item) => item.line)]
      : []
    // Ops Real is temporarily disabled, so it is omitted from generated output.
    if (mainLines.length === 0) return []

    return mainLines
  }

  const outputTransaction = useMemo(() => {
    if (!activeTransaction || !historyChangeActive) return activeTransaction
    const base = historyChangeBase?.transaction as TransactionGroup | undefined
    if (!base) return activeTransaction
    const next: TransactionGroup = {
      ...activeTransaction,
      rab: activeTransaction.rab.map(row => ({
        ...row,
        amount: isHistoryRabEnabled(row.accountId) ? row.amount : '',
        b3Amount: isHistoryRabB3Enabled(row.accountId) ? (row.b3Amount ?? '') : ''
      })),
      gas: (activeTransaction.gas ?? []).map(row => isHistoryRowEnabled('gas', row.id) ? row : { ...row, amount: '' }),
      operasional: (activeTransaction.operasional ?? []).map(row => isHistoryRowEnabled('operasional', row.id) ? row : { ...row, amount: '' }),
      pencairan_harian: (activeTransaction.pencairan_harian ?? []).map(row => isHistoryRowEnabled('pencairan_harian', row.id) ? row : { ...row, amount: '' }),
      lain_lain: (activeTransaction.lain_lain ?? []).map(row => isHistoryRowEnabled('lain_lain', row.id) ? row : { ...row, amount: '' }),
      arutala_lain_lain: (activeTransaction.arutala_lain_lain ?? []).map(row => isHistoryRowEnabled('arutala_lain_lain', row.id) ? row : { ...row, amount: '' }),
    }
    return next
  }, [activeTransaction, historyChangeActive, historyEntryKeys, historyChangeBase])
  const output = outputTransaction
    ? getTransactionOutput(outputTransaction).join('\n')
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
  const totalRab = sumOutputLines((line) => line.startsWith('RAB : ') || line.startsWith('RAB B3 : '))
  const opsHarianBreakdown = outputDetailLines.reduce<Array<{ label: string; amount: number }>>(
    (items, line) => {
      const amount = getOutputAmount(line)
      if (amount <= 0) return items

      let label = ''
      if (line.startsWith('INSENTIF FASILITAS SPPG : ')) {
        label = 'Fasilitas SPPG'
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
      } else if (line.startsWith('LAIN-LAIN : ')) {
        const separatorIndex = line.indexOf(' - ')
        const note = separatorIndex >= 0 ? line.slice('LAIN-LAIN : '.length, separatorIndex).trim() : ''
        label = note ? 'Arutala: ' + note : 'Arutala: Transaksi lain'
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

    const gasMapping = arutalaGasRule
    const gasEntries = activeTransaction.gas ?? []
    if (gasMapping) {
      outputChecks.push({
        label: 'Pencairan Gas',
        complete: Boolean(gasMapping.accounts) &&
          gasEntries.filter((entry, index) => entry.transactionType === 'gas' || (index === 0 && !entry.transactionType)).length <= 2 &&
          (gasEntries.length === 0 || gasEntries.some((entry) => isCompleteAmount(entry.amount)))
      })
    }

    const operationalEntries = activeTransaction.operasional ?? []
    const hasArutalaMapping = Boolean(arutalaGasRule?.accounts)
    if (operationalEntries.length > 0) {
      outputChecks.push({
        label: 'Operasional Harian',
        complete: operationalEntries.some((entry) => isCompleteAmount(entry.amount)) &&
          operationalEntries.every((entry) => {
            if (!isCompleteAmount(entry.amount)) return true
            if (entry.useArutalaAccount) return Boolean(hasArutalaMapping && (entry.need ?? '').trim())
            return Boolean(entry.ownerName.trim() && (entry.bank ?? '').trim() &&
              entry.accountNumber.trim() && (entry.need ?? '').trim())
          })
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

  function getHistorySnapshot(): Record<string, unknown> | null {
    if (!activeTransaction || !selectedKitchen) return null
    return {
      kitchenId,
      kitchenName: selectedKitchen?.name ?? '',
      transactionDate: activeDate,
      transaction: activeTransaction,
      output,
      totalRab,
      totalOpsHarian,
      totalOverall: sumOutputLines(() => true)
    }
  }

  async function copyOutput() {
    if ((!output && !historyChangeBase) || !activeTransaction || !kitchenId) return
    setHistorySaveBusy(true)
    try {
      const snapshot = getHistorySnapshot()
      if (!snapshot) return
      if (historyChangeBase) {
        setHistorySaveOpen(true)
        setHistorySaveBusy(false)
        return
      }
      const { data, error } = await supabase.functions.invoke('maker-history', {
        body: { action: 'list', kitchen_id: kitchenId, date_from: activeDate, date_to: activeDate },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Riwayat gagal diperiksa.')
      const existing = (data?.histories ?? []).find((row: { payload?: Record<string, unknown> }) => {
        const transaction = row.payload?.transaction as { id?: number } | undefined
        return transaction?.id === activeTransaction.id
      })
      if (existing) {
        const previous = existing.payload?.transaction as TransactionGroup | undefined
        if (!previous) throw new Error('Snapshot Riwayat tidak valid.')
        setHistoryChangeBase(existing.payload as Record<string, unknown>)
        setHistorySaveType('REVISI')
        setHistoryEntryKeys(getHistoryEntryKeys(previous))
        setHistorySaveOpen(true)
        setHistorySaveBusy(false)
        return
      }
      const { error: saveError } = await supabase.functions.invoke('maker-history', {
        body: {
          action: 'create',
          kitchen_id: kitchenId,
          transaction_date: activeDate,
          title: `Pencairan ${selectedKitchen?.name ?? 'Dapur'} - ${activeDate}`,
          payload: snapshot
        },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (saveError) throw new Error(saveError.message || 'Riwayat gagal disimpan.')
      await navigator.clipboard.writeText(output)
      setCopyMessage('Tersimpan di Riwayat dan berhasil disalin')
      window.setTimeout(() => setCopyMessage(''), 2200)
    } catch (err) {
      setCopyMessage(err instanceof Error ? err.message : 'Gagal menyimpan dan menyalin output')
      window.setTimeout(() => setCopyMessage(''), 3000)
    } finally {
      setHistorySaveBusy(false)
    }
  }

  async function confirmHistorySave() {
    if (!activeTransaction || !historyChangeBase) return
    setHistorySaveBusy(true)
    try {
      const currentSnapshot = getHistorySnapshot()
      if (!currentSnapshot) throw new Error('Snapshot perubahan tidak dapat dibentuk.')
      const snapshot: Record<string, unknown> = { ...currentSnapshot }
      const baseTransaction = historyChangeBase.transaction as TransactionGroup | undefined
      const currentTransaction = snapshot.transaction as TransactionGroup
      if (!baseTransaction) throw new Error('Snapshot asal tidak ditemukan. Muat ulang transaksi dari Riwayat.')

      const nextTransaction: TransactionGroup = { ...baseTransaction }
      const incrementalTransaction: TransactionGroup = {
        ...baseTransaction,
        rab: [],
        gas: [],
        operasional: [],
        pencairan_harian: [],
        lain_lain: [],
        arutala_lain_lain: []
      }
      const parseAmount = (value: string | undefined) => Number(String(value ?? '').replace(/\D/g, '')) || 0
      const amountWithDelta = (previous: string, entered: string) =>
        String(parseAmount(previous) + parseAmount(entered))
      const fields = ['gas', 'operasional', 'pencairan_harian', 'lain_lain', 'arutala_lain_lain'] as const
      const shortageKeys = new Set(historyShortageKeys)
      const isShortage = (key: string) => shortageKeys.has(key)

{
        const selected = new Set(historyEntryKeys)
        const rabById = new Map(baseTransaction.rab.map(row => [row.accountId, { ...row }]))
        const changedRabById = new Map(currentTransaction.rab.map(row => [row.accountId, row]))
        const incrementalRabById = new Map<string, RabEntry>()

        for (const key of selected) {
          const separator = key.indexOf(':')
          const field = key.slice(0, separator)
          const id = key.slice(separator + 1)

          if (field === 'rab' || field === 'rab_b3') {
            const previous = rabById.get(id)
            if (!previous) continue
            const changed = changedRabById.get(id)
            if (changed && !isShortage(key)) {
              const unchanged = field === 'rab'
                ? changed.amount === previous.amount && JSON.stringify(changed.productTypes ?? []) === JSON.stringify(previous.productTypes ?? [])
                : (changed.b3Amount ?? '') === (previous.b3Amount ?? '') && JSON.stringify(changed.b3ProductTypes ?? []) === JSON.stringify(previous.b3ProductTypes ?? [])
              if (unchanged) continue
            }
            const incremental = incrementalRabById.get(id) ?? {
              ...previous,
              amount: '',
              b3Amount: '',
              b3Enabled: false,
              b3ProductTypes: []
            }

            if (field === 'rab') {
              if (!changed) {
                previous.amount = ''
                previous.productTypes = []
              } else if (isShortage(key)) {
                const delta = parseAmount(changed.amount)
                if (delta <= 0) throw new Error('Isi nominal kekurangan RAB atau hapus baris yang dipilih.')
                previous.amount = amountWithDelta(previous.amount, changed.amount)
                incremental.amount = changed.amount
                incremental.productTypes = changed.productTypes
              } else {
                previous.amount = changed.amount
                previous.productTypes = changed.productTypes
                incremental.amount = changed.amount
                incremental.productTypes = changed.productTypes
              }
            } else {
              if (!changed) {
                previous.b3Amount = ''
                previous.b3Enabled = false
                previous.b3ProductTypes = []
              } else if (isShortage(key)) {
                const delta = parseAmount(changed.b3Amount)
                if (delta <= 0) throw new Error('Isi nominal kekurangan RAB B3 atau hapus baris yang dipilih.')
                previous.b3Amount = amountWithDelta(previous.b3Amount ?? '', changed.b3Amount ?? '')
                previous.b3Enabled = true
                previous.b3ProductTypes = changed.b3ProductTypes ?? []
                incremental.b3Amount = changed.b3Amount ?? ''
                incremental.b3Enabled = true
                incremental.b3ProductTypes = changed.b3ProductTypes ?? []
              } else {
                previous.b3Amount = changed.b3Amount ?? ''
                previous.b3Enabled = Boolean(changed.b3Enabled || parseAmount(changed.b3Amount) > 0)
                previous.b3ProductTypes = changed.b3ProductTypes ?? []
                incremental.b3Amount = changed.b3Amount ?? ''
                incremental.b3Enabled = Boolean(changed.b3Enabled || parseAmount(changed.b3Amount) > 0)
                incremental.b3ProductTypes = changed.b3ProductTypes ?? []
              }
            }
            incrementalRabById.set(id, incremental)
            continue
          }

          if (!fields.includes(field as typeof fields[number])) continue
          const section = field as typeof fields[number]
          const previousRows = (nextTransaction[section] ?? []) as SimpleEntry[] | DailyPaymentEntry[]
          const changedRows = (currentTransaction[section] ?? []) as SimpleEntry[] | DailyPaymentEntry[]
          const previous = previousRows.find(row => String(row.id) === id)
          if (!previous) continue
          const changed = changedRows.find(row => String(row.id) === id)

          if (!changed) {
            ;(nextTransaction as unknown as Record<string, unknown>)[section] = previousRows.filter(row => String(row.id) !== id)
            continue
          }

          if (!isShortage(key) && JSON.stringify(changed) === JSON.stringify(previous)) continue

          let merged: typeof changed
          if (isShortage(key)) {
            if (parseAmount(changed.amount) <= 0) {
              throw new Error('Isi nominal kekurangan untuk transaksi yang dipilih, atau hapus barisnya.')
            }
            merged = { ...changed, amount: amountWithDelta(previous.amount, changed.amount) }
          } else {
            merged = { ...changed, amount: changed.amount }
          }

          ;(nextTransaction as unknown as Record<string, unknown>)[section] = previousRows.map(row =>
            String(row.id) === id ? merged : row
          )
          ;(incrementalTransaction as unknown as Record<string, unknown>)[section] = [
            ...((incrementalTransaction[section] ?? []) as typeof changedRows),
            { ...changed }
          ]
        }

        nextTransaction.rab = [...rabById.values()]
        incrementalTransaction.rab = [...incrementalRabById.values()]

        // Rows created from the Form during a change are appended as new transactions.
        for (const section of fields) {
          const baseRows = (baseTransaction[section] ?? []) as Array<{ id: number }>
          const currentRows = (currentTransaction[section] ?? []) as SimpleEntry[] | DailyPaymentEntry[]
          const baseIds = new Set(baseRows.map(row => String(row.id)))
          const addedRows = currentRows.filter(row => !baseIds.has(String(row.id)) && parseAmount(row.amount) > 0)
          if (addedRows.length) {
            ;(nextTransaction as unknown as Record<string, unknown>)[section] = [
              ...((nextTransaction[section] ?? []) as typeof currentRows),
              ...addedRows
            ]
            ;(incrementalTransaction as unknown as Record<string, unknown>)[section] = [
              ...((incrementalTransaction[section] ?? []) as typeof currentRows),
              ...addedRows
            ]
          }
        }
      }

      // GAS and Arutala date buckets are a mirror of the active transaction rows.
      // Rebuild the active date bucket for every change mode to prevent stale snapshots.
      const dateBuckets: Record<string, ArutalaDateBucket> = {
        ...(baseTransaction.arutala_by_date ?? {}),
        ...(currentTransaction.arutala_by_date ?? {})
      }
      dateBuckets[activeDate] = {
        gas: nextTransaction.gas ?? [],
        lain_lain: (nextTransaction.operasional ?? []).filter(row => row.useArutalaAccount)
      }
      nextTransaction.arutala_by_date = dateBuckets

      snapshot.transaction = nextTransaction
      const mergedOutput = getTransactionOutput(nextTransaction).join('\n')
      const mergedLines = mergedOutput.split('\n').slice(1).filter(line => line.trim())
      const amountFromLine = (line: string) => {
        const separator = line.lastIndexOf(' · ')
        return separator < 0 ? 0 : Number(line.slice(separator + 3).replace(/\D/g, '')) || 0
      }
      snapshot.output = mergedOutput
      snapshot.totalRab = mergedLines
        .filter(line => line.startsWith('RAB : ') || line.startsWith('RAB B3 : '))
        .reduce((sum, line) => sum + amountFromLine(line), 0)
      snapshot.totalOpsHarian = mergedLines
        .filter(line => !line.startsWith('RAB : ') && !line.startsWith('RAB B3 : '))
        .reduce((sum, line) => sum + amountFromLine(line), 0)
      snapshot.totalOverall = mergedLines.reduce((sum, line) => sum + amountFromLine(line), 0)

      const { data: listData, error: listError } = await supabase.functions.invoke('maker-history', {
        body: { action: 'list', kitchen_id: kitchenId, date_from: activeDate, date_to: activeDate },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (listError || listData?.error) throw new Error(listData?.error ?? listError?.message ?? 'Riwayat gagal diperiksa.')
      const existing = (listData?.histories ?? []).find((row: { payload?: Record<string, unknown> }) => {
        const transaction = row.payload?.transaction as { id?: number } | undefined
        return transaction?.id === activeTransaction.id
      })
      if (!existing) throw new Error('Riwayat awal tidak ditemukan. Tutup dialog lalu tekan Copy dan Simpan lagi.')

      const { data: detailData, error: detailError } = await supabase.functions.invoke('maker-history', {
        body: { action: 'get', draft_id: existing.id },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (detailError || detailData?.error) throw new Error(detailData?.error ?? detailError?.message ?? 'Detail Riwayat gagal dimuat.')
      const before = detailData.history.payload as Record<string, unknown>
      const delta: Record<string, unknown> = {}
      for (const key of new Set([...Object.keys(before), ...Object.keys(snapshot)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(snapshot[key])) delta[key] = snapshot[key] ?? null
      }

      const incrementalOutput = getTransactionOutput(incrementalTransaction, 'REVISI').join('\n')
      delta.incremental_output = incrementalOutput
      if (shortageKeys.size > 0) delta.shortage_keys = [...shortageKeys]

      if (!Object.keys(delta).length) throw new Error('Tidak ada perubahan dari snapshot terakhir.')
      const { error: changeError } = await supabase.functions.invoke('maker-history', {
        body: {
          action: 'change',
          draft_id: existing.id,
          expected_version: detailData.history.version,
          event_type: 'REVISI',
          summary: historySaveSummary,
          delta,
          snapshot
        },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (changeError) throw new Error(changeError.message || 'Versi Riwayat gagal disimpan.')

      const savedTransaction = normalizeTransaction({ ...nextTransaction, id: activeTransaction.id }, activeDate)
      setTransactions([savedTransaction])
      setActiveTransactionId(savedTransaction.id)
      persistWorkspace({ kitchenId, activeTransactionId: savedTransaction.id, transactions: [savedTransaction] })
      setHistoryChangeBase(null)
      setHistoryEntryKeys([])
      setHistoryShortageKeys([])
      setHistorySaveType('REVISI')
      setHistorySaveOpen(false)
      setHistorySaveSummary('')

      if (incrementalOutput) {
        try {
          await navigator.clipboard.writeText(incrementalOutput)
          setCopyMessage(`${historySaveType} tersimpan dan output perubahan disalin`)
        } catch {
          setCopyMessage(`${historySaveType} tersimpan, tetapi clipboard tidak tersedia`)
        }
      } else {
        setCopyMessage(`${historySaveType} tersimpan. Tidak ada baris bernominal untuk disalin.`)
      }
      window.setTimeout(() => setCopyMessage(''), 3000)
    } catch (err) {
      setCopyMessage(err instanceof Error ? err.message : 'Gagal menyimpan versi Riwayat')
      window.setTimeout(() => setCopyMessage(''), 3000)
    } finally {
      setHistorySaveBusy(false)
    }
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen overflow-x-clip bg-slate-950 p-2 text-white sm:p-3 md:p-4">
      <div className="mx-auto w-full max-w-[1120px]">
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

          </header>

          {masterData && !masterLoading && !masterError && (
            <div className="mt-3 mb-2 flex w-fit max-w-full flex-wrap items-end gap-2">
              <div className="w-[220px] shrink-0">
                <label htmlFor="date" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Tanggal</label>
                <div className="relative flex h-9 cursor-pointer items-center rounded-lg border border-slate-700 bg-slate-950 px-2.5 transition hover:border-emerald-500/70 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/25">
                  <span className="whitespace-nowrap text-[10px] font-semibold tracking-wide text-slate-500">TANGGAL</span>
                  <span className="ml-2 whitespace-nowrap text-xs font-semibold tabular-nums text-white">{formatDate(activeDate)}</span>
                  <input ref={dateInputRef} id="date" type="date" value={activeDate} onChange={(event) => changeActiveDate(event.target.value)} onClick={(event) => { event.stopPropagation(); openDatePicker() }} aria-label="Pilih tanggal transaksi" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                </div>
              </div>
              {!fixedKitchen && (
                <div className="w-[190px] shrink-0">
                  <label htmlFor="workspace-kitchen" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Dapur</label>
                  <select id="workspace-kitchen" value={kitchenId} onChange={(event) => handleKitchenChange(event.target.value)} className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs font-semibold text-white">
                    <option value="">Pilih dapur</option>
                    {masterData?.kitchens.map((kitchen) => <option key={kitchen.id} value={kitchen.id}>{kitchen.name}</option>)}
                  </select>
                </div>
              )}
              {kitchenId && activeTransaction && (
                <div className="flex items-end gap-1.5">
                  <button type="button" onClick={() => setHistoryOpen(true)} className="h-9 rounded-lg border border-emerald-700/70 bg-emerald-950/50 px-3 text-[10px] font-semibold text-emerald-200 shadow-sm transition hover:border-emerald-500">Riwayat</button>
                  <button type="button" onClick={resetWorkspace} className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[10px] font-medium text-slate-200 shadow-sm transition hover:border-rose-500/70 hover:bg-slate-800">Reset</button>
                </div>
              )}
              {historyMessage && <span className="pb-2 text-[10px] text-emerald-300">{historyMessage}</span>}
            </div>
          )}

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
                        {copyMessage && <span role="status" className="text-[10px] font-semibold text-emerald-300">{copyMessage}</span>}
                      </div>

                      <div className="mt-2 flex min-h-[135px] flex-1 flex-col gap-2">
                        <pre className="max-h-[30vh] flex-1 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-slate-800 bg-gradient-to-b from-slate-950 to-slate-900/80 p-2 text-[10px] leading-4 text-slate-200 shadow-inner shadow-black/20">{output}</pre>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" disabled={(!output && !historyChangeBase) || historySaveBusy} onClick={() => void copyOutput()} className="self-start rounded-lg border border-emerald-700 bg-emerald-950/50 px-3 py-2 text-[11px] font-semibold text-emerald-200 disabled:opacity-40">{historySaveBusy ? 'Menyimpan...' : 'Copy dan Simpan'}</button>
                        </div>
                      </div>

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
                        const normalizedKitchenName = (selectedKitchen?.name ?? '').trim().toLocaleLowerCase('id-ID')
                        const normalizedSupplierName = (rule.supplier?.business_name ?? rule.accounts?.name ?? '').trim().toLocaleLowerCase('id-ID')
                        const isWarungbitungArumikata = normalizedKitchenName === 'warungbitung' && normalizedSupplierName.includes('toko arumikata')
                        const historyEnabled = isHistoryRabEnabled(rule.account_id)
                        const b3HistoryEnabled = isHistoryRabB3Enabled(rule.account_id)
                        const customProducts = entry.productTypes
                          .filter((product) => !products.includes(product))
                          .slice(0, 3)
                        const customDraftKey = activeTransaction.id + ':' + rule.account_id
                        const customDraft = customRabDrafts[customDraftKey] ?? customProducts

                        return (
                          <div
                            key={rule.account_id}
                            className={`grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(220px,auto)] items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 sm:gap-3 ${!historyEnabled ? "opacity-45" : ""}`}
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
                                        disabled={!historyEnabled}
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
                                    disabled={!historyEnabled || (customProducts.length >= 3 && !customRabOpen[rule.account_id])}
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
                                        value={customDraft[fieldIndex] ?? ''} disabled={!historyEnabled}
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
<div className="flex min-w-0 items-center gap-1.5"><input
                              id={'rab-' + activeTransaction.id + '-' + rule.account_id}
                              type="text"
                              inputMode="numeric"
                              value={formatNumber(entry.amount)}
                              disabled={!historyEnabled}
                              onChange={(event) =>
                                updateRabEntry(
                                  activeTransaction.id,
                                  rule.account_id,
                                  {
                                    amount: event.target.value.replace(/\D/g, '')
                                  }
                                )
                              }
                              placeholder={isHistoryShortage('rab:' + rule.account_id) ? 'Masukkan nominal kekurangan' : 'Nominal'}
                              className={`h-10 w-full max-w-[140px] rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 ${hasOutputAmount('RAB : ', rule.accounts?.account_number ?? '-', entry.amount) ? 'mp-field--has-output' : ''}`}
                            />{renderHistoryShortageButton('rab:' + rule.account_id, () => updateRabEntry(activeTransaction.id, rule.account_id, { amount: '' }))}</div>
                            {isWarungbitungArumikata && (
                              <div className="col-span-2 rounded-lg border border-amber-800/50 bg-amber-950/15 p-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="text-xs font-semibold text-amber-200">Pencairan B3 terpisah</div>
                                  <button
                                    type="button"
                                    disabled={historyChangeActive && !entry.b3Enabled && !b3HistoryEnabled}
                                    onClick={() => updateRabEntry(activeTransaction.id, rule.account_id, {
                                      b3Enabled: !entry.b3Enabled,
                                      b3Amount: entry.b3Enabled ? '' : (entry.b3Amount ?? ''),
                                      b3ProductTypes: entry.b3Enabled ? [] : (entry.b3ProductTypes ?? [])
                                    })}
                                    className="rounded-md border border-amber-700/70 bg-amber-950/40 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {entry.b3Enabled ? 'Tutup B3' : '+ Tambah B3'}
                                  </button>
                                </div>
                                {(entry.b3Enabled || (historyChangeActive && b3HistoryEnabled)) && (
                                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    {products.map((product) => {
                                      const selected = (entry.b3ProductTypes ?? []).includes(product)
                                      return (
                                        <button
                                          key={'b3-' + product}
                                          type="button"
                                          data-option-button="true"
                                          data-selected={selected}
                                          aria-pressed={selected}
                                          disabled={!b3HistoryEnabled}
                                          onClick={() => {
                                            const current = entry.b3ProductTypes ?? []
                                            updateRabEntry(activeTransaction.id, rule.account_id, {
                                              b3Enabled: true,
                                              b3ProductTypes: sortStrings(selected
                                                ? current.filter(item => item !== product)
                                                : [...current, product])
                                            })
                                          }}
                                          className={'inline-flex h-8 items-center rounded-md border px-2 text-[11px] font-medium ' + (selected
                                            ? 'border-amber-500 bg-amber-700 text-white'
                                            : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800')}
                                        >
                                          {selected ? '✓ ' : ''}{product}
                                        </button>
                                      )
                                    })}
<div className="flex min-w-0 items-center gap-1.5"><input
                                      type="text"
                                      inputMode="numeric"
                                      value={formatNumber(entry.b3Amount ?? '')}
                                      disabled={!b3HistoryEnabled}
                                      onChange={(event) => updateRabEntry(activeTransaction.id, rule.account_id, {
                                        b3Enabled: true,
                                        b3Amount: event.target.value.replace(/\D/g, '')
                                      })}
                                      placeholder={isHistoryShortage('rab_b3:' + rule.account_id) ? 'Masukkan nominal kekurangan' : 'Nominal B3'}
                                      aria-label="Nominal RAB B3 Toko Arumikata"
                                      className="h-9 w-[150px] rounded-md border border-amber-700/50 bg-slate-950 px-2.5 text-xs font-semibold text-white placeholder:text-slate-500"
                                    />{renderHistoryShortageButton('rab_b3:' + rule.account_id, () => updateRabEntry(activeTransaction.id, rule.account_id, { b3Amount: '' }))}</div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      }

                      return (
                        <div className="mt-2 space-y-3">
                          {sortedRabRules.filter(rule => !historyChangeActive || historyEntryKeys.includes('rab:' + rule.account_id) || historyEntryKeys.includes('rab_b3:' + rule.account_id)).map((rule, index) =>
                            renderRabRow(rule, index)
                          )}
                        </div>
                      )
                    })()}
                  </section>


                  <section className={`mp-card relative w-full min-w-0 rounded-xl border border-teal-600/70 bg-slate-900/40 p-3 ${operationalAddMenuOpen ? 'z-40' : 'z-0'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Operasional Harian</h2>
                      <div className="relative">
                        <button type="button" aria-expanded={operationalAddMenuOpen} onClick={() => setOperationalAddMenuOpen((open) => !open)} className="h-9 shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-100 transition hover:border-teal-500/70 hover:bg-slate-700">+ Transaksi</button>
                        {operationalAddMenuOpen && (
                          <div className="absolute right-0 z-[60] mt-1 flex min-w-48 flex-col gap-1 rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl">
                            {opsMappings.map((rule) => {
                              const added = operationalEntries.some((entry) => entry.operationalRuleId === rule.id || (
                                entry.operationalRuleType === 'ops_harian' &&
                                entry.ownerName.trim() === rule.owner_name.trim() &&
                                (entry.bank ?? '').trim().toUpperCase() === rule.bank.trim().toUpperCase() &&
                                entry.accountNumber.replace(/\D/g, '') === rule.account_number.replace(/\D/g, '')
                              ))
                              return <button key={rule.id} type="button" onClick={() => addMappedOperationalEntry(rule.id)} disabled={added} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40">Ops Harian — {rule.owner_name}{added ? ' (Ditambahkan)' : ''}</button>
                            })}
                            {opsMappings.length === 0 && <button type="button" disabled className="rounded-md px-3 py-2.5 text-left text-xs text-slate-500">Ops Harian — Mapping belum tersedia</button>}
                            {!isCihaurKitchen && <>
                              <button type="button" onClick={addArutalaOtherEntry} disabled={!arutalaGasRule?.accounts} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40">Arutala</button>
                              <button type="button" onClick={addGasEntry} disabled={!arutalaGasRule?.accounts || (activeTransaction.gas ?? []).filter((entry, index) => entry.transactionType === 'gas' || (index === 0 && !entry.transactionType)).length >= 2} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40">GAS</button>
                            </>}
                            <button type="button" onClick={addOperationalEntry} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 hover:bg-slate-800">Lain-lain</button>
                          </div>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const mapping = getOperationalAccount(selectedKitchen?.name ?? '', masterData)
                      const entries = activeTransaction.operasional ?? []
                      return (
                        <div className="mt-3 space-y-3">
                        <div className="pt-1">
                        {(activeTransaction.gas ?? []).length > 0 ? (
                          <div className="space-y-2">
                            {(activeTransaction.gas ?? []).map((entry) => {
                              const historyEnabled = isHistoryRowEnabled('gas', entry.id)
                                                            const rule = arutalaGasRule
                              const accountName = rule?.supplier?.business_name || rule?.accounts?.name || 'Mapping belum tersedia'
                              const bank = rule?.accounts?.bank ?? '-'
                              const accountNumber = rule?.accounts?.account_number ?? '-'
                              return (
                                <div key={entry.id} className={`rounded-lg border border-slate-800 bg-slate-950/40 p-2 ${!historyEnabled ? "opacity-45" : ""}`}>
                                  <div className="grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(130px,1fr)_85px_minmax(110px,0.8fr)_minmax(120px,1fr)_90px_100px_110px_34px]">
                                    <div className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">GAS</div>
                                    <div title={accountName} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountName}</span></div>
                                    <div className="flex h-10 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-xs font-semibold text-slate-100">{bank}</div>
                                    <div title={accountNumber} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountNumber}</span></div>
                                    <input type="text" inputMode="numeric" value={entry.gasQuantity ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasQuantity: event.target.value.replace(/\D/g, '').replace(/^0+/, '') })} placeholder="Jumlah" aria-label="Jumlah tabung gas" className="h-10 min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-white" />
                                    <select value={entry.gasSize ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasSize: event.target.value as SimpleEntry['gasSize'] })} aria-label="Ukuran gas" className="h-10 min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-white"><option value="">Ukuran</option><option value="12kg">12 kg</option><option value="50kg">50 kg</option></select>
                                    <div className="col-span-2 flex min-w-0 items-center gap-1.5"><input type="text" inputMode="numeric" required value={formatNumber(entry.amount)} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: event.target.value.replace(/\D/g, '') })} placeholder={isHistoryShortage('gas:' + entry.id) ? 'Masukkan nominal kekurangan' : 'Nominal'} aria-label="Nominal GAS" className="h-10 min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm font-semibold text-white" />{renderHistoryShortageButton('gas:' + entry.id, () => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: '' }))}</div>
                                    <button type="button" onClick={() => removeGasEntry(entry.id)} disabled={!historyEnabled} aria-label="Hapus transaksi GAS" title="Hapus transaksi" className="h-10 rounded-md border border-slate-800 bg-slate-900 text-base text-slate-400 hover:border-rose-500/70 hover:text-rose-300">×</button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-3 space-y-1.5">
                          {entries.some(entry => !historyChangeActive || isHistoryRowEnabled('operasional', entry.id)) && (
                            <div className="hidden lg:grid min-w-0 grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(240px,1.6fr)_minmax(190px,1.2fr)_30px] items-center gap-2 border-b border-slate-700/70 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300">
                              <span></span><span>Nama rekening</span><span>Bank</span><span>Nomor rekening</span><span>Catatan</span><span>Nominal</span><span></span>
                            </div>
                          )}
                          {entries.map((entry, index) => {
                            const historyEnabled = isHistoryRowEnabled('operasional', entry.id)
                                                        const isMappedOps = entry.operationalRuleType === 'ops_harian'
                            const custom = !isMappedOps && (index > 0 || Boolean(entry.customAccount))
                            const isArutala = Boolean(entry.useArutalaAccount)
                            const mappedOpsRule = isMappedOps
                              ? opsMappings.find((rule) => rule.id === entry.operationalRuleId)
                              : null
                            const arutalaAccount = arutalaGasRule?.accounts
                            const arutalaOwnerName = arutalaGasRule?.supplier?.business_name || arutalaAccount?.name || 'Koperasi Arutala'
                            const selectedType = entry.operationalRuleType ?? ''
                            const selectedRuleType = selectedType === 'gaji_akuntan'
                              ? 'gaji_akuntan'
                              : selectedType === 'gaji_ahli_gizi'
                                ? 'gaji_ahli_gizi'
                                : ''
                            const selectedMapping = selectedRuleType
                              ? getOperationalMapping(selectedKitchen?.name ?? '', masterData, selectedRuleType)
                              : null
                            const isMappedSalary = selectedType === 'gaji_akuntan' || selectedType === 'gaji_ahli_gizi'
                            const showVirtualAccount = custom && !isArutala && !isMappedSalary
                            const ownerName = isArutala
                              ? arutalaOwnerName
                              : isMappedOps
                                ? mappedOpsRule?.owner_name || entry.ownerName || mapping?.ownerName || ''
                                : custom
                                  ? (isMappedSalary ? selectedMapping?.ownerName : entry.ownerName) ?? ''
                                  : mapping?.ownerName ?? ''
                            const bank = isArutala
                              ? arutalaAccount?.bank ?? ''
                              : isMappedOps
                                ? mappedOpsRule?.bank || entry.bank || mapping?.bank || ''
                                : custom
                                  ? (isMappedSalary ? selectedMapping?.bank : entry.bank) ?? ''
                                  : mapping?.bank ?? ''
                            const accountNumber = isArutala
                              ? arutalaAccount?.account_number ?? ''
                              : isMappedOps
                                ? mappedOpsRule?.account_number || entry.accountNumber || mapping?.accountNumber || ''
                                : custom
                                  ? (isMappedSalary ? selectedMapping?.accountNumber : entry.accountNumber) ?? ''
                                  : mapping?.accountNumber ?? ''
                            const note = entry.need ?? (isMappedOps ? 'Ops Harian' : '')
                            const availableAccountant = getOperationalMapping(selectedKitchen?.name ?? '', masterData, 'gaji_akuntan')
                            const availableNutritionist = getOperationalMapping(selectedKitchen?.name ?? '', masterData, 'gaji_ahli_gizi')
                            return (
                              <div key={entry.id} className={`${entries.length > 1 ? 'rounded-lg border border-slate-800 bg-slate-950/40 p-2' : ''} ${!historyEnabled ? 'opacity-45' : ''}`}>
                                <div className={'grid min-w-0 items-end gap-2 ' + (showVirtualAccount
                                  ? entry.isVirtualAccount
                                    ? 'lg:grid-cols-[62px_54px_90px_minmax(105px,0.75fr)_minmax(240px,1.6fr)_120px_30px]'
                                    : 'lg:grid-cols-[62px_54px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(170px,1.1fr)_minmax(190px,1.2fr)_30px]'
                                  : 'lg:grid-cols-[62px_minmax(130px,0.95fr)_90px_minmax(105px,0.75fr)_minmax(240px,1.6fr)_120px_30px]')}>
                                  {isMappedOps ? (
                                    <div className="flex h-10 w-full items-center justify-center rounded-md border border-teal-700/60 bg-teal-950/30 px-2 text-center text-[10px] font-semibold text-teal-100">Ops Harian</div>
                                  ) : custom ? (isArutala ? (
                                    <div className="flex h-10 w-full items-center justify-center rounded-md border border-cyan-700/60 bg-cyan-950/40 px-2 text-center text-[10px] font-semibold text-cyan-100">Koperasi Arutala</div>
                                  ) : (
                                    <select
                                      value={selectedType}
                                      disabled={!historyEnabled}
                                      onChange={(event) => {
                                        const nextType = event.target.value as SimpleEntry['operationalRuleType']
                                        const nextMapping = nextType
                                          ? getOperationalMapping(selectedKitchen?.name ?? '', masterData, nextType)
                                          : getOperationalAccount(selectedKitchen?.name ?? '', masterData)
                                        updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, {
                                          operationalRuleType: nextType ?? '',
                                          useArutalaAccount: false,
                                          ownerName: nextMapping?.ownerName ?? '',
                                          bank: nextMapping?.bank ?? '',
                                          accountNumber: nextMapping?.accountNumber ?? '',
                                          need: nextType === 'gaji_akuntan'
                                            ? 'Gaji Pengawas Keuangan'
                                            : nextType === 'gaji_ahli_gizi'
                                              ? 'Gaji Pengawas Gizi'
                                              : ''
                                        })
                                      }}
                                      aria-label="Jenis transaksi tambahan Operasional Harian"
                                      className="h-10 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-slate-700/90 bg-slate-950 px-2 text-center text-[10px] font-semibold text-slate-100 outline-none transition focus:border-teal-500"
                                    >
                                      <option value="">Custom</option>
                                      {availableAccountant && <option value="gaji_akuntan">Gaji AK</option>}
                                      {availableNutritionist && <option value="gaji_ahli_gizi">Gaji AG</option>}
                                    </select>
                                  )) : (
                                    <div className="flex h-10 w-full items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-[10px] font-semibold text-slate-200">Ops Harian</div>
                                  )}
                                  {showVirtualAccount && (
                                    <label className="flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md border border-slate-700/90 bg-slate-950 px-1.5 text-[10px] font-semibold text-slate-200">
                                      <input type="checkbox" checked={Boolean(entry.isVirtualAccount)} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { isVirtualAccount: event.target.checked })} aria-label="Transfer Virtual Account" className="h-3.5 w-3.5 shrink-0 accent-cyan-400" />
                                      <span>VA</span>
                                    </label>
                                  )}
                                  {!(showVirtualAccount && entry.isVirtualAccount) && (custom && !isMappedSalary && !isArutala ? (
                                    <input type="text" value={ownerName} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { ownerName: event.target.value })} placeholder="Nama rekening" aria-label="Nama rekening Ops Harian" className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500" />
                                  ) : (
                                    <div title={ownerName || 'Mapping belum tersedia'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{ownerName || 'Mapping belum tersedia'}</span></div>
                                  ))}
                                  {custom && !isMappedSalary && !isArutala ? (
                                    <select value={entry.bank ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { bank: event.target.value })} aria-label="Bank Ops Harian" className="h-10 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-slate-700/90 bg-slate-950 px-2 text-center text-xs text-slate-100 outline-none transition focus:border-teal-500">
                                      <option value="">Pilih bank</option>
                                      {OPERATIONAL_BANKS.map((bankOption) => <option key={bankOption} value={bankOption}>{bankOption}</option>)}
                                    </select>
                                  ) : (
                                    <div title={bank || '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100">{bank || '-'}</div>
                                  )}
                                  {custom && !isMappedSalary && !isArutala ? (
                                    <input type="text" inputMode="numeric" value={entry.accountNumber} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { accountNumber: event.target.value.replace(/\D/g, '') })} placeholder="Nomor rekening" aria-label="Nomor rekening Ops Harian" className="h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500" />
                                  ) : (
                                    <div title={accountNumber || '-'} className="flex h-10 min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountNumber || '-'}</span></div>
                                  )}
                                  <input
                                    type="text"
                                    required
                                    disabled={!historyEnabled}
                                    value={note}
                                    onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { need: event.target.value })}
                                    placeholder="Catatan"
                                    aria-label="Catatan Operasional Harian"
                                    className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 ${custom ? 'bg-gradient-to-b from-slate-900 to-slate-950 text-slate-100' : 'bg-slate-800 text-slate-300'} px-2.5 text-xs placeholder:text-slate-500 outline-none transition focus:border-teal-500`}
                                  />
                                  <div className="col-span-2 flex min-w-0 items-center gap-1.5"><input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!historyEnabled || (isMappedOps && !accountNumber) || (isArutala && !arutalaAccount) || (isMappedSalary && !selectedMapping)}
                                    onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: event.target.value.replace(/\D/g, '') })}
                                    placeholder={isHistoryShortage('operasional:' + entry.id) ? 'Masukkan nominal kekurangan' : 'Nominal'}
                                    aria-label="Nominal Ops Harian"
                                    className={`h-10 w-full min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-2.5 text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-teal-500 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount('OPS HARIAN : ', accountNumber, entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{renderHistoryShortageButton('operasional:' + entry.id, () => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: '' }))}</div>
                                  <button
                                    type="button"
                                    onClick={() => removeOperationalEntry(entry.id)}
                                    disabled={!historyEnabled}
                                    title="Hapus transaksi tambahan Operasional Harian"
                                    aria-label="Hapus transaksi Ops Harian"
                                    className="h-10 w-full rounded-md border border-slate-800 bg-slate-900 text-base font-semibold text-slate-400 transition hover:border-rose-500/70 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-25"
                                  >×</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        </div>
                      )
                    })()}
                  </section>

                  <div className="w-full min-w-0 space-y-3">
                    <section className="mp-card w-full min-w-0 rounded-xl border border-sky-600/60 bg-sky-950/10 p-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Insentif Fasilitas SPPG</h2>
                      <div className="mt-2 space-y-1.5">
                        <div className="hidden sm:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 sm:grid-cols-[minmax(180px,1.2fr)_90px_minmax(130px,0.9fr)_minmax(220px,1.2fr)]">
                          <span>Nama rekening</span>
                          <span>Bank</span>
                          <span>Nomor rekening</span>
                          <span>Nominal</span>
                        </div>
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'sewa' && isHistoryRowEnabled('pencairan_harian', entry.id))
                          .map((entry) => {
                            const historyEnabled = isHistoryRowEnabled('pencairan_harian', entry.id)
                            const rental = getSppgRental(selectedKitchen?.name ?? '', masterData)
                            return (
                              <div
                                key={entry.id}
                                className={`grid min-w-0 items-stretch gap-2 sm:grid-cols-[minmax(180px,1.2fr)_90px_minmax(130px,0.9fr)_minmax(220px,1.2fr)] ${!historyEnabled ? "opacity-45" : ""}`}
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
                                  <div className="flex min-w-0 items-center gap-1.5"><input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!historyEnabled || !rental}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { amount: event.target.value.replace(/\D/g, '') }
                                      )
                                    }
                                    placeholder={isHistoryShortage('pencairan_harian:' + entry.id) ? 'Masukkan nominal kekurangan' : 'Nominal'}
                                    aria-label="Nominal Insentif Fasilitas SPPG"
                                    className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount('INSENTIF FASILITAS SPPG : ', rental?.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{renderHistoryShortageButton('pencairan_harian:' + entry.id, () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: '' }))}</div>
                              </div>
                            )
                          })}
                      </div>
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
                        <div className="hidden lg:grid min-w-0 items-center gap-2 px-0.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 border-b border-slate-700/70 lg:grid-cols-[minmax(180px,1.05fr)_minmax(180px,1.1fr)_90px_minmax(130px,0.9fr)_minmax(220px,1.2fr)]">
                          <span>Jenis pencairan</span>
                          <span>Nama rekening</span>
                          <span>Bank</span>
                          <span>Nomor rekening</span>
                          <span>Nominal</span>
                        </div>
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'gaji' && isHistoryRowEnabled('pencairan_harian', entry.id))
                          .map((entry) => {
                            const historyEnabled = isHistoryRowEnabled('pencairan_harian', entry.id)
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
                              <div key={entry.id} className={!historyEnabled ? 'opacity-45' : ''}>
                                <div className="grid min-w-0 items-stretch gap-2 lg:grid-cols-[minmax(180px,1.05fr)_minmax(180px,1.1fr)_90px_minmax(130px,0.9fr)_minmax(220px,1.2fr)]">
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
                                  <div className="flex min-w-0 items-center gap-1.5"><input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!historyEnabled || !mapping}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { amount: event.target.value.replace(/\D/g, '') }
                                      )
                                    }
                                    placeholder={isHistoryShortage('pencairan_harian:' + entry.id) ? 'Masukkan nominal kekurangan' : 'Nominal'}
                                    aria-label={'Nominal ' + label}
                                    className={`h-10 w-full max-w-[140px] min-w-0 rounded-md border border-slate-700/90 bg-gradient-to-b from-slate-900 to-slate-950 px-3 text-sm shadow-inner shadow-black/20 font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition hover:border-emerald-500/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 ${hasOutputAmount(entry.kinds.join(', ').toLocaleUpperCase('id-ID') + ' : ', mapping?.accountNumber ?? entry.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{renderHistoryShortageButton('pencairan_harian:' + entry.id, () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: '' }))}</div>
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
      {historySaveOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4">
          <section className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 p-4 shadow-2xl">
            <h3 className="text-sm font-bold">Simpan perubahan pencairan</h3>
            <p className="mt-1 text-xs text-slate-400">Periksa perubahan, lalu simpan dan salin output.</p>
            <p className="mt-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold text-emerald-200">Jenis perubahan: {historySaveType}</p>{historyChangeActive && <p className="mt-2 text-xs text-slate-400">Seluruh transaksi dari snapshot sedang diedit di Form Utama.</p>}
            <label className="mt-3 block text-xs text-slate-300">Catatan {historySaveType === 'REVISI' ? 'revisi' : historySaveType === 'KEKURANGAN' ? 'kekurangan' : 'tambahan'} (opsional)
              <input value={historySaveSummary} onChange={event => setHistorySaveSummary(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs" placeholder={historySaveType === 'REVISI' ? 'Apa yang direvisi?' : historySaveType === 'KEKURANGAN' ? 'Apa yang menjadi kekurangan?' : 'Apa yang ditambahkan?'} />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={historySaveBusy} onClick={() => setHistorySaveOpen(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Batal</button>
              <button type="button" disabled={historySaveBusy} onClick={() => void confirmHistorySave()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold disabled:opacity-40">{historySaveBusy ? 'Menyimpan...' : 'Simpan dan Salin'}</button>
            </div>
          </section>
        </div>
      )}
      {historyOpen && selectedKitchen && activeTransaction && (
        <HistoryPanel
          token={token}
          role={role}
          kitchenId={kitchenId}
          kitchenName={selectedKitchen.name}
          transactionDate={activeDate}
          onStartChange={(payload) => {
            const source = payload.transaction as TransactionGroup | undefined
            if (!source || !Array.isArray(source.rab) || !Array.isArray(source.pencairan_harian)) return
            const restored = normalizeTransaction({ ...source, id: 1 }, String(payload.transactionDate ?? source.date ?? today))
            const restoredKitchenId = String(payload.kitchenId ?? kitchenId)

            setHistoryChangeBase(payload)
            setHistoryEntryKeys(getHistoryEntryKeys(restored))
            setHistoryShortageKeys([])
            setHistorySaveType('REVISI')
            setHistorySaveSummary('')
            setKitchenId(restoredKitchenId)
            setTransactions([restored])
            setActiveTransactionId(1)
            setHistoryOpen(false)
            setHistorySaveOpen(false)
            persistWorkspace({ kitchenId: restoredKitchenId, activeTransactionId: 1, transactions: [restored] })
            setHistoryMessage('Seluruh snapshot dimuat ke Form Utama. Revisi nominal, tandai Kekurangan pada baris terkait, atau tambahkan transaksi baru di Form.')
          }}
          onLoadSnapshot={(payload) => {
            const source = payload.transaction as TransactionGroup | undefined
            if (!source || !Array.isArray(source.rab) || !Array.isArray(source.pencairan_harian)) return
            const restored = normalizeTransaction({ ...source, id: 1 }, String(payload.transactionDate ?? source.date ?? today))
            const restoredKitchenId = String(payload.kitchenId ?? kitchenId)
            setKitchenId(restoredKitchenId)
            setTransactions([restored])
            setActiveTransactionId(1)
            setHistoryOpen(false)
            persistWorkspace({ kitchenId: restoredKitchenId, activeTransactionId: 1, transactions: [restored] })
            setHistoryMessage('Snapshot Riwayat berhasil dimuat ke Form Utama.')
          }}
          onRefreshSnapshot={(payload) => {
            const source = payload.transaction as TransactionGroup | undefined
            if (!source || !Array.isArray(source.rab) || !Array.isArray(source.pencairan_harian)) return
            const refreshed = normalizeTransaction({ ...source, id: 1 }, String(payload.transactionDate ?? source.date ?? today))
            const refreshedKitchenId = String(payload.kitchenId ?? kitchenId)
            setKitchenId(refreshedKitchenId)
            setTransactions([refreshed])
            setActiveTransactionId(1)
            persistWorkspace({ kitchenId: refreshedKitchenId, activeTransactionId: 1, transactions: [refreshed] })
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </main>
  )
}

export default MakerWorkspace
