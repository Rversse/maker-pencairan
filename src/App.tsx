import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getMakerMasterData,
  type MakerMasterData,
  type MakerAccountRule,
  type MakerOperationalRule,
  type MakerKitchen
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
  gasNote?: string
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

function isCustomOperationalEntry(entry: SimpleEntry, index: number) {
  const isMappedOps = entry.operationalRuleType === 'ops_harian'
  const isMappedSalary = entry.operationalRuleType === 'gaji_akuntan' ||
    entry.operationalRuleType === 'gaji_ahli_gizi'
  const isArutala = Boolean(entry.useArutalaAccount)

  return !isMappedOps && !isMappedSalary && !isArutala &&
    (index > 0 || Boolean(entry.customAccount))
}

type CustomOperationalField = 'ownerName' | 'bank' | 'accountNumber' | 'need' | 'amount'
type CustomOperationalFieldStatus = 'is-complete' | 'is-missing' | 'not-required'

function getCustomOperationalFieldStatus(
  entry: SimpleEntry,
  field: CustomOperationalField
): CustomOperationalFieldStatus {
  if (field === 'ownerName' && entry.isVirtualAccount) return 'not-required'

  const complete = field === 'ownerName'
    ? Boolean(entry.ownerName?.trim())
    : field === 'bank'
      ? Boolean(entry.bank?.trim())
      : field === 'accountNumber'
        ? Boolean(entry.accountNumber?.trim())
        : field === 'need'
          ? Boolean(entry.need?.trim())
          : isCompleteAmount(entry.amount ?? '')

  return complete ? 'is-complete' : 'is-missing'
}

function getCustomOperationalCompletion(entry: SimpleEntry) {
  const fields: Array<{ label: string; field: CustomOperationalField }> = [
    ...(!entry.isVirtualAccount ? [{ label: 'Nama rekening', field: 'ownerName' as const }] : []),
    { label: 'Nama bank', field: 'bank' },
    { label: 'Nomor rekening', field: 'accountNumber' },
    { label: 'Catatan', field: 'need' },
    { label: 'Nominal', field: 'amount' }
  ]
  const missing = fields
    .filter(({ field }) => getCustomOperationalFieldStatus(entry, field) === 'is-missing')
    .map(({ label }) => label)

  return { complete: missing.length === 0, missing }
}

function getIncompleteCustomOperationalEntries(
  transaction: TransactionGroup | null | undefined,
  isRowEnabled: (entry: SimpleEntry) => boolean = () => true
) {
  return (transaction?.operasional ?? []).flatMap((entry, index) => {
    if (!isCustomOperationalEntry(entry, index) || !isRowEnabled(entry)) return []

    const completion = getCustomOperationalCompletion(entry)
    if (completion.complete) return []

    return [{ entryId: entry.id, missing: completion.missing }]
  })
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

  if (normalized === 'cihaur' || normalized === 'sukaraharja') {
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
  if (kind === 'gas') return 1
  if (kind === 'pencairan_harian') return 2
  return 3
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
    gasNote: '',
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
    need: ''
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
          gasNote: typeof entry.gasNote === 'string' ? entry.gasNote : '',
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
          gasSize: isGasEntry ? normalizedEntry.gasSize : '',
          gasNote: isGasEntry ? normalizedEntry.gasNote : ''
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
      isVirtualAccount: entry.operationalRuleType === 'gaji_akuntan' || entry.operationalRuleType === 'gaji_ahli_gizi'
        ? false
        : Boolean(entry.isVirtualAccount),
      need: entry.need ?? '',
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


type MakerImportGroup = {
  kitchenId: string
  kitchenName: string
  transactionDate: string
  sourceHeader: string
  transaction: TransactionGroup
  output: string
  lines: string[]
  categories: Array<{ label: string; count: number; amount: number }>
  totalRab: number
  totalOpsHarian: number
  totalOverall: number
}
type MakerImportParseResult = { groups: MakerImportGroup[]; errors: string[] }

function parseMakerOutputHeader(line: string) {
  const match = /^(?:(REVISI|TAMBAHAN|KEKURANGAN)\s*-\s*)?(.+),\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+\(\d+\))?$/.exec(line.trim())
  if (!match) return null
  const monthMap: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6,
    jul: 7, agu: 8, sep: 9, okt: 10, nov: 11, des: 12
  }
  const month = monthMap[match[4].toLocaleLowerCase('id-ID')]
  const day = Number(match[3])
  const year = Number(match[5])
  if (!month || day < 1 || day > 31 || year < 2000 || year > 2100) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return {
    kitchenName: match[2].trim(),
    transactionDate: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
    eventMarker: (match[1] ?? '').toUpperCase()
  }
}

function normalizeImportIdentity(value: string) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('id-ID')
}
function normalizeImportAccountNumber(value: string) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits || (String(value ?? '').trim() === '-' ? '-' : '')
}
function makerIdentityMatches(
  identity: { ownerName: string; bank: string; accountNumber: string },
  expected: { ownerName: string; bank: string; accountNumber: string } | null | undefined
) {
  if (!expected) return false
  return normalizeImportIdentity(identity.ownerName) === normalizeImportIdentity(expected.ownerName) &&
    normalizeImportIdentity(identity.bank) === normalizeImportIdentity(expected.bank) &&
    normalizeImportAccountNumber(identity.accountNumber) === normalizeImportAccountNumber(expected.accountNumber)
}
function parseMakerOutputAmount(line: string) {
  const separator = line.lastIndexOf(' · ')
  if (separator < 0) throw new Error('pemisah nominal tidak ditemukan')
  const amountText = line.slice(separator + 3).trim()
  if (!/^[0-9][0-9.,\s]*$/.test(amountText)) throw new Error('format nominal tidak dikenali')
  const digits = amountText.replace(/\D/g, '')
  const amount = Number(digits)
  if (!digits || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('nominal harus lebih besar dari nol')
  return { body: line.slice(0, separator).trim(), amount: String(amount), numericAmount: amount }
}
function parseMakerAccountIdentity(value: string) {
  const bankSeparator = value.lastIndexOf(' - ')
  const accountSeparator = value.indexOf(' / ', bankSeparator + 3)
  if (bankSeparator <= 0 || accountSeparator < bankSeparator + 4) {
    throw new Error('identitas rekening harus berformat Nama - Bank / Nomor Rekening')
  }
  const ownerName = value.slice(0, bankSeparator).trim()
  const bank = value.slice(bankSeparator + 3, accountSeparator).trim().toUpperCase()
  const accountNumber = value.slice(accountSeparator + 3).trim()
  if (!ownerName || !bank || !accountNumber) throw new Error('nama, bank, atau nomor rekening kosong')
  return { ownerName, bank, accountNumber }
}
function splitMakerProductList(value: string): string[] {
  const text = value.trim()
  if (!text) return []
  const parts = text.split(/\s*,\s*/).filter(Boolean)
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    const conjunction = /\s+dan\s+/i.exec(last)
    if (conjunction) {
      parts.splice(parts.length - 1, 1, last.slice(0, conjunction.index).trim(), last.slice(conjunction.index + conjunction[0].length).trim())
    }
    return parts.map(item => item.trim()).filter(Boolean)
  }
  const conjunction = /\s+dan\s+/i.exec(text)
  if (conjunction) return [text.slice(0, conjunction.index).trim(), text.slice(conjunction.index + conjunction[0].length).trim()].filter(Boolean)
  return [text]
}

function parseMakerOutputGroup(
  kitchen: MakerKitchen,
  transactionDate: string,
  lines: string[],
  sourceHeader: string,
  masterData: MakerMasterData
): MakerImportGroup {
  const kitchenRules = masterData.account_rules.filter(rule => rule.kitchen_id === kitchen.id)
  const rabRules = kitchenRules.filter(rule => rule.flow_type === 'income' && rule.accounts && rule.supplier)
  const gasRules = kitchenRules.filter(rule => rule.flow_type === 'neutral' && rule.accounts)
  const arutalaRule = gasRules.find(rule =>
    normalizeImportIdentity(rule.accounts?.name ?? '') === 'koperasi arutala' &&
    (rule.accounts?.bank ?? '').trim().toUpperCase() === 'BNI' &&
    normalizeImportAccountNumber(rule.accounts?.account_number ?? '') === '1985322260'
  )
  const base = normalizeTransaction(
    makeTransaction(
      1,
      transactionDate,
      rabRules.map(rule => ({ account_id: rule.account_id })),
      gasRules.map(rule => ({ account_id: rule.account_id, accounts: rule.accounts })),
      kitchen.name,
      masterData
    ),
    transactionDate
  )
  const rab: RabEntry[] = base.rab.map(row => ({
    ...row,
    productTypes: [] as string[],
    amount: '',
    b3Enabled: false,
    b3ProductTypes: [] as string[],
    b3Amount: ''
  }))
  const gas: SimpleEntry[] = []
  const operasional: SimpleEntry[] = []
  const dailyPayments = base.pencairan_harian.map(entry => ({ ...entry, amount: '' }))
  const sewaEntry = dailyPayments.find(entry => entry.category === 'sewa')
  const payrollKinds: Record<string, DailyPaymentKind> = {
    'GAJI RELAWAN': 'Gaji Relawan',
    'INSENTIF PIC SEKOLAH': 'Insentif PIC Sekolah',
    'INSENTIF PIC POSYANDU': 'Insentif PIC Posyandu'
  }
  const mappedOpsRules = masterData.operational_rules.filter(rule =>
    rule.kitchen_id === kitchen.id && rule.is_active && rule.rule_type === 'ops_harian'
  )
  const mappedSalaryRules = masterData.operational_rules.filter(rule =>
    rule.kitchen_id === kitchen.id && rule.is_active &&
    (rule.rule_type === 'gaji_akuntan' || rule.rule_type === 'gaji_ahli_gizi')
  )
  const seenRab = new Set<string>()
  const categories = new Map<string, { count: number; amount: number }>()
  let totalRab = 0
  let totalOpsHarian = 0
  let totalOverall = 0
  let gasId = 0
  let operationalId = 0
  let fallbackDailyId = Math.max(0, ...dailyPayments.map(entry => entry.id)) + 1

  const addCategory = (label: string, value: number) => {
    const current = categories.get(label) ?? { count: 0, amount: 0 }
    current.count += 1
    current.amount += value
    categories.set(label, current)
    totalOverall += value
    if (label === 'RAB' || label === 'RAB B3') totalRab += value
    else totalOpsHarian += value
  }

  for (const sourceLine of lines) {
    const parsed = parseMakerOutputAmount(sourceLine)
    const separator = parsed.body.indexOf(' : ')
    if (separator < 0) throw new Error('kategori transaksi tidak dikenali')
    const prefix = parsed.body.slice(0, separator).trim().toLocaleUpperCase('id-ID')
    const detail = parsed.body.slice(separator + 3).trim()
    const segments = detail.split(' · ').map(part => part.trim())
    const amount = parsed.amount
    const numericAmount = parsed.numericAmount

    if (prefix === 'RAB' || prefix === 'RAB B3') {
      const identity = parseMakerAccountIdentity(segments[0] ?? '')
      const rule = rabRules.find(candidate => {
        const account = candidate.accounts
        const supplier = candidate.supplier
        if (!account || !supplier) return false
        return makerIdentityMatches(identity, {
          ownerName: formatSupplierAccountName(supplier.business_name || account.name, supplier.owner_name),
          bank: account.bank,
          accountNumber: account.account_number ?? '-'
        })
      })
      if (!rule) throw new Error('rekening RAB tidak cocok dengan mapping dapur ' + kitchen.name)
      const lineKey = prefix + ':' + rule.account_id
      if (seenRab.has(lineKey)) throw new Error('rekening RAB yang sama muncul dua kali pada kategori ' + prefix)
      seenRab.add(lineKey)
      const products = splitMakerProductList(segments.slice(1).join(' · '))
      const row = rab.find(entry => entry.accountId === rule.account_id)
      if (!row) throw new Error('baris RAB tidak tersedia untuk rekening ' + identity.ownerName)
      if (prefix === 'RAB') {
        row.amount = amount
        row.productTypes = products
      } else {
        row.b3Enabled = true
        row.b3Amount = amount
        row.b3ProductTypes = products
      }
      addCategory(prefix, numericAmount)
      continue
    }

    if (prefix === 'INSENTIF FASILITAS SPPG') {
      const identity = parseMakerAccountIdentity(segments[0] ?? '')
      const rental = getSppgRental(kitchen.name, masterData)
      if (!rental || !makerIdentityMatches(identity, rental)) {
        throw new Error('rekening Insentif Fasilitas SPPG tidak cocok dengan mapping dapur')
      }
      if (!sewaEntry) throw new Error('baris Insentif Fasilitas SPPG tidak tersedia')
      sewaEntry.amount = amount
      sewaEntry.ownerName = identity.ownerName
      sewaEntry.bank = identity.bank
      sewaEntry.accountNumber = normalizeImportAccountNumber(identity.accountNumber)
      addCategory('INSENTIF FASILITAS SPPG', numericAmount)
      continue
    }

    const payrollLabels = prefix.split(',').map(item => item.trim()).filter(Boolean)
    if (payrollLabels.some(label => Boolean(payrollKinds[label]))) {
      const identity = parseMakerAccountIdentity(segments[0] ?? '')
      const kinds = payrollLabels.map(label => {
        const kind = payrollKinds[label]
        if (!kind) throw new Error('kategori gaji/insentif tidak dikenali: ' + label)
        return kind
      })
      const mapped = getDailyPaymentMappingForKinds(kitchen.name, kinds, masterData)
      if (mapped && !makerIdentityMatches(identity, mapped)) {
        throw new Error('rekening Gaji/Insentif tidak cocok dengan mapping dapur')
      }
      const kindKey = [...new Set(kinds)].sort((a, b) => a.localeCompare(b, 'id')).join('|')
      let row = dailyPayments.find(entry =>
        entry.category === 'gaji' &&
        [...entry.kinds].sort((a, b) => a.localeCompare(b, 'id')).join('|') === kindKey
      )
      if (!row) {
        row = {
          id: fallbackDailyId++,
          category: 'gaji',
          kinds: [...new Set(kinds)],
          bank: identity.bank,
          accountNumber: normalizeImportAccountNumber(identity.accountNumber),
          ownerName: identity.ownerName,
          amount: ''
        }
        dailyPayments.push(row)
      }
      row.amount = amount
      row.bank = identity.bank
      row.accountNumber = normalizeImportAccountNumber(identity.accountNumber)
      row.ownerName = identity.ownerName
      addCategory(payrollLabels.length > 1 ? 'GAJI + INSENTIF PIC' : payrollLabels[0], numericAmount)
      continue
    }

    if (prefix === 'OPS HARIAN' || prefix === 'GAS') {
      const identity = parseMakerAccountIdentity(segments[0] ?? '')
      const noteSegments = segments.slice(1)
      const note = noteSegments.find(part => part.toUpperCase() !== 'VA') ?? ''
      const isVirtualAccount = noteSegments.some(part => part.toUpperCase() === 'VA')
      const gasMatch = /^Gas(?:\s+(12kg|50kg))?(?:\s+\((\d+)\s+tabung\))?(?:,\s*(.*))?$/i.exec(note)

      if (gasMatch || prefix === 'GAS') {
        if (!arutalaRule?.accounts || !arutalaRule.supplier) {
          throw new Error('Mapping rekening GAS Arutala tidak tersedia untuk dapur ' + kitchen.name)
        }
        const expectedOwner = capitalizeEachWord(arutalaRule.supplier.business_name || arutalaRule.accounts.name)
        if (!makerIdentityMatches(identity, {
          ownerName: expectedOwner,
          bank: arutalaRule.accounts.bank,
          accountNumber: arutalaRule.accounts.account_number ?? '-'
        })) throw new Error('baris GAS tidak cocok dengan rekening GAS Arutala')
        if (prefix === 'GAS' && !gasMatch) throw new Error('baris GAS tidak memiliki keterangan Gas yang valid')
        gasId += 1
        gas.push({
          ...emptySimpleEntry(gasId),
          accountId: arutalaRule.accounts.id,
          amount,
          ownerName: identity.ownerName,
          bank: identity.bank,
          accountNumber: normalizeImportAccountNumber(identity.accountNumber),
          need: 'Gas',
          gasQuantity: gasMatch?.[2] ?? '',
          gasSize: gasMatch?.[1] === '12kg' || gasMatch?.[1] === '50kg' ? gasMatch[1] : '',
          gasNote: gasMatch?.[3]?.trim() ?? '',
          transactionType: 'gas'
        })
        addCategory('GAS', numericAmount)
        continue
      }

      const mappedOps = mappedOpsRules.find(rule => makerIdentityMatches(identity, {
        ownerName: rule.owner_name, bank: rule.bank, accountNumber: rule.account_number
      }))
      if (mappedOps) {
        operationalId += 1
        operasional.push({
          ...createOperationalEntry(operationalId),
          operationalRuleType: 'ops_harian',
          operationalRuleId: mappedOps.id,
          ownerName: identity.ownerName,
          bank: identity.bank,
          accountNumber: normalizeImportAccountNumber(identity.accountNumber),
          amount,
          customAccount: false,
          need: note || 'Ops Harian'
        })
        addCategory('OPS HARIAN', numericAmount)
        continue
      }

      const mappedSalary = mappedSalaryRules.find(rule => makerIdentityMatches(identity, {
        ownerName: rule.owner_name, bank: rule.bank, accountNumber: rule.account_number
      }))
      if (mappedSalary) {
        operationalId += 1
        const defaultNote = mappedSalary.rule_type === 'gaji_akuntan'
          ? 'Gaji Pengawas Keuangan'
          : 'Gaji Pengawas Gizi'
        operasional.push({
          ...createOperationalEntry(operationalId),
          operationalRuleType: mappedSalary.rule_type as SimpleEntry['operationalRuleType'],
          operationalRuleId: mappedSalary.id,
          ownerName: identity.ownerName,
          bank: identity.bank,
          accountNumber: normalizeImportAccountNumber(identity.accountNumber),
          amount,
          customAccount: true,
          need: note || defaultNote,
          isVirtualAccount
        })
        addCategory('GAJI PENGAWAS', numericAmount)
        continue
      }

      const arutalaIdentity = arutalaRule?.accounts && arutalaRule.supplier
        ? makerIdentityMatches(identity, {
            ownerName: capitalizeEachWord(arutalaRule.supplier.business_name || arutalaRule.accounts.name),
            bank: arutalaRule.accounts.bank,
            accountNumber: arutalaRule.accounts.account_number ?? '-'
          })
        : false
      operationalId += 1
      operasional.push({
        ...createOperationalEntry(operationalId),
        ownerName: identity.ownerName,
        bank: identity.bank,
        accountNumber: normalizeImportAccountNumber(identity.accountNumber),
        amount,
        customAccount: true,
        useArutalaAccount: arutalaIdentity,
        need: note,
        isVirtualAccount
      })
      addCategory(arutalaIdentity ? 'ARUTALA' : 'OPS HARIAN', numericAmount)
      continue
    }

    throw new Error('kategori "' + prefix + '" belum didukung oleh parser Maker-Pencairan')
  }

  const transaction = normalizeTransaction({
    ...base,
    date: transactionDate,
    rab,
    gas,
    operasional,
    pencairan_harian: dailyPayments,
    lain_lain: [emptyOtherEntry(1)],
    arutala_lain_lain: [],
    arutala_by_date: {},
    legacy_gaji: []
  }, transactionDate)
  transaction.arutala_by_date = {
    ...(transaction.arutala_by_date ?? {}),
    [transactionDate]: {
      gas: transaction.gas,
      lain_lain: transaction.operasional.filter(entry => entry.useArutalaAccount)
    }
  }

  return {
    kitchenId: kitchen.id,
    kitchenName: kitchen.name,
    transactionDate,
    sourceHeader,
    transaction,
    output: [sourceHeader, ...lines].join('\n'),
    lines: [...lines],
    categories: [...categories.entries()].map(([label, value]) => ({
      label, count: value.count, amount: value.amount
    })).sort((a, b) => a.label.localeCompare(b.label, 'id', { sensitivity: 'base' })),
    totalRab,
    totalOpsHarian,
    totalOverall
  }
}

function parseMakerOutputText(raw: string, masterData: MakerMasterData | null): MakerImportParseResult {
  if (!masterData) return { groups: [], errors: ['Master data belum selesai dimuat.'] }
  const errors: string[] = []
  const builders: Array<{ kitchen: MakerKitchen; date: string; lines: string[]; header: string }> = []
  let current: { kitchen: MakerKitchen; date: string; lines: string[]; header: string } | null = null
  const finishCurrent = () => {
    if (current) builders.push(current)
    current = null
  }

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line) return
    const header = parseMakerOutputHeader(line)
    if (header) {
      finishCurrent()
      if (header.eventMarker) {
        errors.push('Baris ' + (index + 1) + ': output ' + header.eventMarker + ' adalah delta revisi, bukan snapshot final.')
        return
      }
      const kitchen = masterData.kitchens.find(item =>
        item.name.trim().toLocaleLowerCase('id-ID') === header.kitchenName.toLocaleLowerCase('id-ID')
      )
      if (!kitchen) {
        errors.push('Baris ' + (index + 1) + ': dapur "' + header.kitchenName + '" tidak ditemukan di master data.')
        return
      }
      current = { kitchen, date: header.transactionDate, lines: [], header: line }
      return
    }
    if (!current) {
      errors.push('Baris ' + (index + 1) + ': baris transaksi muncul sebelum header dapur/tanggal.')
      return
    }
    current.lines.push(line)
  })
  finishCurrent()

  const groups: MakerImportGroup[] = []
  const seenGroups = new Set<string>()
  for (const builder of builders) {
    const key = builder.kitchen.id + ':' + builder.date
    if (seenGroups.has(key)) {
      errors.push('Dapur ' + builder.kitchen.name + ' tanggal ' + formatDate(builder.date) + ' muncul lebih dari sekali di paste.')
      continue
    }
    seenGroups.add(key)
    if (!builder.lines.length) {
      errors.push('Dapur ' + builder.kitchen.name + ' tanggal ' + formatDate(builder.date) + ': tidak ada baris transaksi.')
      continue
    }
    try {
      groups.push(parseMakerOutputGroup(builder.kitchen, builder.date, builder.lines, builder.header, masterData))
    } catch (error) {
      errors.push('Dapur ' + builder.kitchen.name + ' tanggal ' + formatDate(builder.date) + ': ' +
        (error instanceof Error ? error.message : 'baris output tidak dapat dibaca'))
    }
  }
  if (!builders.length && !errors.length) errors.push('Output kosong. Paste hasil Copy dari Maker-Pencairan.')
  return { groups, errors }
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
  const historySavePreviousFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (historySaveOpen) {
      const frame = window.requestAnimationFrame(() => {
        document.getElementById('mp-history-save-cancel')?.focus()
      })
      return () => window.cancelAnimationFrame(frame)
    }
    const previous = historySavePreviousFocusRef.current
    if (previous?.isConnected) previous.focus()
    historySavePreviousFocusRef.current = null
  }, [historySaveOpen])
  const [historyChangeBase, setHistoryChangeBase] = useState<Record<string, unknown> | null>(null)
  const [historyEntryKeys, setHistoryEntryKeys] = useState<string[]>([])
  const [historyAdditionalKeys, setHistoryAdditionalKeys] = useState<string[]>([])
  const historyChangeActive = Boolean(historyChangeBase)
  const isHistoryAdditional = (key: string) => historyAdditionalKeys.includes(key)
  const toggleHistoryAdditional = (key: string, enabled: boolean) => setHistoryAdditionalKeys(current => enabled ? [...new Set([...current, key])] : current.filter(item => item !== key))
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
  const historyPreviousGasQuantity = (id: number) => {
    const base = historyChangeBase?.transaction as TransactionGroup | undefined
    return base?.gas?.find(row => row.id === id)?.gasQuantity ?? ''
  }
  const historyCurrentAmount = (key: string) => {
    if (!activeTransaction) return ''
    const separator = key.indexOf(':')
    const field = key.slice(0, separator)
    const id = key.slice(separator + 1)
    if (field === 'rab' || field === 'rab_b3') {
      const row = activeTransaction.rab.find(item => item.accountId === id)
      return field === 'rab_b3' ? row?.b3Amount ?? '' : row?.amount ?? ''
    }
    const rows = activeTransaction[field as keyof TransactionGroup] as Array<{ id: number; amount: string }> | undefined
    return rows?.find(row => String(row.id) === id)?.amount ?? ''
  }
  const hasHistoryPreviousAmount = (key: string) => {
    if (!historyChangeActive || !historyEntryKeys.includes(key)) return false
    const normalizeAmount = (value: string) => String(value ?? '').replace(/\D/g, '') || '0'
    const previous = normalizeAmount(historyPreviousAmount(key))
    const current = normalizeAmount(historyCurrentAmount(key))
    return previous !== current || isHistoryAdditional(key)
  }
  const renderHistoryPreviousAmount = (key: string) => {
    if (!hasHistoryPreviousAmount(key)) return null
    return <span className="mp-history-previous-amount">Sebelumnya: Rp {formatNumber(historyPreviousAmount(key)) || '0'}</span>
  }
  const renderHistoryPreviousGasQuantity = (id: number) => {
    if (!historyChangeActive || !historyEntryKeys.includes('gas:' + id)) return null
    const previous = historyPreviousGasQuantity(id)
    const current = activeTransaction?.gas?.find(row => row.id === id)?.gasQuantity ?? ''
    const normalizeQuantity = (value: string) => String(value ?? '').replace(/\D/g, '').replace(/^0+/, '')
    if (normalizeQuantity(previous) === normalizeQuantity(current)) return null
    return <span className="mp-history-previous-amount">Sebelumnya: {previous} tabung</span>
  }
  const renderHistoryAdditionalButton = (key: string, onEnable: () => void, onDisable: () => void) => {
    if (!historyChangeActive || !historyEntryKeys.includes(key)) return null
    const enabled = isHistoryAdditional(key)
    const previous = historyPreviousAmount(key)
    return (
      <button
        type="button"
        aria-pressed={enabled}
        aria-label={enabled ? 'Nonaktifkan tambahan saldo' : 'Aktifkan tambahan saldo'}
        title={enabled ? 'Nonaktifkan Tambahan dan pulihkan nominal sebelumnya' : `Tambahkan nominal baru ke nominal sebelumnya. Sebelumnya: Rp ${formatNumber(previous) || '0'}`}
        onClick={() => {
          const nextEnabled = !enabled
          toggleHistoryAdditional(key, nextEnabled)
          if (nextEnabled) onEnable()
          else onDisable()
        }}
        className={`mp-history-additional-toggle h-8 shrink-0 transition ${enabled ? 'is-active' : ''}`}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 6.5v7M6.5 10h7" />
        </svg>
      </button>
    )
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
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<'insert' | 'replace'>('insert')
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const importParse = useMemo(() => parseMakerOutputText(importText, masterData), [importText, masterData])
  const [operationalAddMenuOpen, setOperationalAddMenuOpen] = useState(false)
  const operationalAddMenuRef = useRef<HTMLDivElement>(null)
  const [customRabOpen, setCustomRabOpen] = useState<Record<string, boolean>>({})
  const [customRabDrafts, setCustomRabDrafts] = useState<Record<string, string[]>>({})
  const dateInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef({
    kitchenId: saved?.kitchenId ?? '',
    activeTransactionId: 1,
    transactions: initialTransaction ? [initialTransaction] : []
  })

  useEffect(() => {
    if (!operationalAddMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !operationalAddMenuRef.current?.contains(target)) {
        setOperationalAddMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOperationalAddMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [operationalAddMenuOpen])

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
    // A mapped Ops Harian account may receive multiple payouts on the same date.
    // Each payout is a distinct row with its own amount and transaction ID.
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
    updateTransaction(activeTransaction.id, {
      operasional: [...currentEntries, {
        ...createOperationalEntry(nextId),
        ownerName: '',
        bank: '',
        accountNumber: '',
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
      if (custom && !getCustomOperationalCompletion(operationalEntry).complete) continue

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
      const note = (operationalEntry.need?.trim() || (isMappedOps || isArutala ? 'Ops Harian' : '')).trim().slice(0, 109)
      const outputOwnerName = ownerName ? capitalizeEachWord(ownerName.slice(0, 30)) : '-'
      const outputOwnerPrefix = custom && operationalEntry.isVirtualAccount
        ? ''
        : outputOwnerName + ' - '
      const outputBank = bank || '-'
      const outputAccountNumber = accountNumber || '-'
      outputs.push({
        bank: outputBank,
        line:
          'OPS HARIAN : ' +
          outputOwnerPrefix +
          outputBank +
          ' / ' +
          outputAccountNumber +
          (note ? ' · ' + note : '') +
          (custom && !isArutala && operationalEntry.isVirtualAccount ? ' · VA' : '') +
          ' · ' +
          formatNumber(operationalEntry.amount),
        kind: 'operasional_harian'
      })
    }

    return outputs
  }

    function getTransactionOutput(transaction: TransactionGroup, eventType?: 'REVISI' | 'TAMBAHAN' | 'TAMBAHAN') {
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
      const gasDescription = quantity && size
        ? 'Gas ' + size + ' (' + quantity + ' tabung)'
        : 'Gas'
      const gasNoteMaxLength = Math.max(0, 109 - gasDescription.length - 2)
      const additionalGasNote = isGasEntry
        ? (entry.gasNote ?? '').trim().slice(0, gasNoteMaxLength)
        : ''
      const note = customNoteMode
        ? (entry.need ?? '').trim()
        : gasDescription + (additionalGasNote ? ', ' + additionalGasNote : '')
      const rule = arutalaGasRule
      if (!rule?.accounts) continue
      const rawAccountName = rule.supplier?.business_name || rule.accounts.name
      const bank = getOutputBank(rule.accounts.bank)
      const accountNumber = (rule.accounts.account_number ?? '-').trim()

      items.push({
        kind: isGasEntry ? 'gas' : 'operasional_harian',
        bank,
        line: 'OPS HARIAN : ' + capitalizeEachWord(rawAccountName) +
          ' - ' + bank + ' / ' + accountNumber +
          (note ? ' · ' + note : '') + ' · ' + formatNumber(entry.amount),
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
      const outputBank = bank || '-'
      const outputAccountNumber = accountNumber || '-'
      const outputOwnerName = ownerName ? capitalizeEachWord(ownerName) : '-'

      items.push({
        kind: 'pencairan_harian',
        bank: outputBank,
        line:
          kinds.join(', ').toLocaleUpperCase('id-ID') +
          ' : ' +
          outputOwnerName +
          ' - ' +
          outputBank +
          ' / ' +
          outputAccountNumber +
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
  const incompleteCustomOperationalRows = getIncompleteCustomOperationalEntries(
    outputTransaction,
    (entry) => isHistoryRowEnabled('operasional', entry.id)
  )
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
      if (line.startsWith('RAB : ') || line.startsWith('RAB B3 : ')) return items
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
          .map((part) => categoryLabels[part.trim()] ?? capitalizeEachWord(part.trim().toLocaleLowerCase('id-ID')))
          .filter(Boolean)
        label = parts.sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' })).join(', ')
      }

      const existing = items.find((item) => item.label === label)
      if (existing) existing.amount += amount
      else items.push({ label, amount })
      return items
    },
    []
  ).sort((a, b) => a.label.localeCompare(b.label, 'id', { sensitivity: 'base' }))
  const totalOpsHarian = sumOutputLines((line) => !line.startsWith('RAB : ') && !line.startsWith('RAB B3 : '))

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
    if (operationalEntries.length > 0) {
      outputChecks.push({
        label: 'Operasional Harian',
        complete: operationalEntries.some((entry) => isCompleteAmount(entry.amount))
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

  async function copyOutputText() {
    if (incompleteCustomOperationalRows.length > 0 || !output) return
    try {
      await navigator.clipboard.writeText(output)
      setCopyMessage('Output berhasil disalin')
      window.setTimeout(() => setCopyMessage(''), 2200)
    } catch {
      setCopyMessage('Gagal menyalin output. Periksa izin clipboard browser.')
      window.setTimeout(() => setCopyMessage(''), 3000)
    }
  }

  function cancelHistoryChange() {
    if (!historyChangeBase) return

    const source = historyChangeBase.transaction as TransactionGroup | undefined
    if (source && Array.isArray(source.rab) && Array.isArray(source.pencairan_harian)) {
      const restored = normalizeTransaction(
        { ...source, id: 1 },
        String(historyChangeBase.transactionDate ?? source.date ?? today)
      )
      const restoredKitchenId = String(historyChangeBase.kitchenId ?? kitchenId)

      setKitchenId(restoredKitchenId)
      setTransactions([restored])
      setActiveTransactionId(1)
      persistWorkspace({
        kitchenId: restoredKitchenId,
        activeTransactionId: 1,
        transactions: [restored]
      })
    }

    setHistoryChangeBase(null)
    setHistoryEntryKeys([])
    setHistoryAdditionalKeys([])
    setHistorySaveOpen(false)
    setHistorySaveBusy(false)
    setCopyMessage('')
    setHistoryMessage('Revisi dibatalkan. Tidak ada perubahan yang disimpan.')
    setHistoryOpen(true)
  }

  async function copyOutput() {
    if (incompleteCustomOperationalRows.length > 0) return
    if ((!output && !historyChangeBase) || !activeTransaction || !kitchenId) return
    setHistorySaveBusy(true)
    try {
      const snapshot = getHistorySnapshot()
      if (!snapshot) return
      if (historyChangeBase) {
        historySavePreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
        setHistoryEntryKeys(getHistoryEntryKeys(previous))
        historySavePreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
    if (incompleteCustomOperationalRows.length > 0) return
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
      const additionalKeys = new Set(historyAdditionalKeys)
      const isAdditional = (key: string) => additionalKeys.has(key)

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
            if (changed && !isAdditional(key)) {
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
              } else if (isAdditional(key)) {
                const delta = parseAmount(changed.amount)
                if (delta <= 0) throw new Error('Isi nominal tambahan RAB atau hapus baris yang dipilih.')
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
              } else if (isAdditional(key)) {
                const delta = parseAmount(changed.b3Amount)
                if (delta <= 0) throw new Error('Isi nominal tambahan RAB B3 atau hapus baris yang dipilih.')
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

          if (!isAdditional(key) && JSON.stringify(changed) === JSON.stringify(previous)) continue

          let merged: typeof changed
          if (isAdditional(key)) {
            if (parseAmount(changed.amount) <= 0) {
              throw new Error('Isi nominal tambahan untuk transaksi yang dipilih, atau hapus barisnya.')
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

      if (additionalKeys.size > 0) delta.additional_keys = [...additionalKeys]

      type AuditRowKind = 'revision' | 'additional' | 'addition' | 'removal'
      type AuditRowRecord = {
        key: string
        kind: AuditRowKind
        before: string | null
        after: string | null
        beforeAmount: number
        afterAmount: number
        deltaAmount: number
      }
      const auditRows: AuditRowRecord[] = []
      const outputLinesFor = (
        source: TransactionGroup,
        section: 'rab' | 'gas' | 'operasional' | 'pencairan_harian' | 'lain_lain' | 'arutala_lain_lain',
        row: RabEntry | SimpleEntry | DailyPaymentEntry | null,
        rabPart?: 'rab' | 'rab_b3'
      ): string[] => {
        const isolated: TransactionGroup = {
          ...source,
          rab: [],
          gas: [],
          operasional: [],
          pencairan_harian: [],
          lain_lain: [],
          arutala_lain_lain: []
        }
        if (section === 'rab' && row) {
          const entry = row as RabEntry
          isolated.rab = [{
            ...entry,
            amount: rabPart === 'rab' ? entry.amount : '',
            productTypes: rabPart === 'rab' ? entry.productTypes : [],
            b3Amount: rabPart === 'rab_b3' ? entry.b3Amount ?? '' : '',
            b3Enabled: rabPart === 'rab_b3' && Boolean(entry.b3Enabled),
            b3ProductTypes: rabPart === 'rab_b3' ? entry.b3ProductTypes ?? [] : []
          }]
        } else if (section === 'gas') {
          isolated.gas = row ? [row as SimpleEntry] : []
        } else if (section === 'operasional') {
          isolated.operasional = row ? [row as SimpleEntry] : []
        } else if (section === 'pencairan_harian') {
          isolated.pencairan_harian = row ? [row as DailyPaymentEntry] : []
        } else if (section === 'lain_lain') {
          isolated.lain_lain = row ? [row as SimpleEntry] : []
        } else if (section === 'arutala_lain_lain') {
          isolated.arutala_lain_lain = row ? [row as SimpleEntry] : []
        }
        return getTransactionOutput(isolated).slice(1)
      }
      const addAuditRow = (
        key: string,
        beforeLines: string[],
        afterLines: string[],
        beforeAmount: number,
        afterAmount: number
      ) => {
        const beforeLine = beforeLines[0] ?? null
        const afterLine = afterLines[0] ?? null
        if (beforeLine === afterLine || (!beforeLine && !afterLine)) return
        const isAddition = beforeAmount <= 0 && afterAmount > 0 && Boolean(afterLine)
        const kind: AuditRowKind = isAddition
          ? 'addition'
          : additionalKeys.has(key)
            ? 'additional'
            : !afterLine
              ? 'removal'
              : 'revision'
        auditRows.push({
          key,
          kind,
          before: beforeLine,
          after: afterLine,
          beforeAmount,
          afterAmount,
          deltaAmount: afterAmount - beforeAmount
        })
      }

      const beforeRabById = new Map(baseTransaction.rab.map(row => [row.accountId, row]))
      const afterRabById = new Map(nextTransaction.rab.map(row => [row.accountId, row]))
      for (const accountId of new Set([...beforeRabById.keys(), ...afterRabById.keys()])) {
        const before = beforeRabById.get(accountId) ?? null
        const after = afterRabById.get(accountId) ?? null
        const beforeAmount = Number(String(before?.amount ?? '').replace(/\D/g, '')) || 0
        const afterAmount = Number(String(after?.amount ?? '').replace(/\D/g, '')) || 0
        if (JSON.stringify(before?.amount ?? '') !== JSON.stringify(after?.amount ?? '') ||
            JSON.stringify(before?.productTypes ?? []) !== JSON.stringify(after?.productTypes ?? [])) {
          addAuditRow(
            'rab:' + accountId,
            before ? outputLinesFor(baseTransaction, 'rab', before, 'rab') : [],
            after ? outputLinesFor(nextTransaction, 'rab', after, 'rab') : [],
            beforeAmount,
            afterAmount
          )
        }
        const beforeB3Amount = Number(String(before?.b3Amount ?? '').replace(/\D/g, '')) || 0
        const afterB3Amount = Number(String(after?.b3Amount ?? '').replace(/\D/g, '')) || 0
        if (JSON.stringify(before?.b3Amount ?? '') !== JSON.stringify(after?.b3Amount ?? '') ||
            JSON.stringify(before?.b3ProductTypes ?? []) !== JSON.stringify(after?.b3ProductTypes ?? [])) {
          addAuditRow(
            'rab_b3:' + accountId,
            before ? outputLinesFor(baseTransaction, 'rab', before, 'rab_b3') : [],
            after ? outputLinesFor(nextTransaction, 'rab', after, 'rab_b3') : [],
            beforeB3Amount,
            afterB3Amount
          )
        }
      }

      for (const section of ['gas', 'operasional', 'pencairan_harian', 'lain_lain', 'arutala_lain_lain'] as const) {
        const beforeRows = (baseTransaction[section] ?? []) as Array<SimpleEntry | DailyPaymentEntry>
        const afterRows = (nextTransaction[section] ?? []) as Array<SimpleEntry | DailyPaymentEntry>
        const beforeById = new Map(beforeRows.map(row => [String(row.id), row]))
        const afterById = new Map(afterRows.map(row => [String(row.id), row]))
        for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
          const before = beforeById.get(id) ?? null
          const after = afterById.get(id) ?? null
          if (JSON.stringify(before) === JSON.stringify(after)) continue
          const beforeAmount = Number(String(before?.amount ?? '').replace(/\D/g, '')) || 0
          const afterAmount = Number(String(after?.amount ?? '').replace(/\D/g, '')) || 0
          addAuditRow(
            section + ':' + id,
            before ? outputLinesFor(baseTransaction, section, before) : [],
            after ? outputLinesFor(nextTransaction, section, after) : [],
            beforeAmount,
            afterAmount
          )
        }
      }
      delta.audit_rows = auditRows
      const historyEventType = additionalKeys.size > 0 || auditRows.some(row => row.kind === 'addition') ? 'TAMBAHAN' : 'REVISI'
      const incrementalOutput = getTransactionOutput(incrementalTransaction, historyEventType).join('\n')
      delta.incremental_output = incrementalOutput

      if (!Object.keys(delta).length) throw new Error('Tidak ada perubahan dari snapshot terakhir.')
      const { error: changeError } = await supabase.functions.invoke('maker-history', {
        body: {
          action: 'change',
          draft_id: existing.id,
          expected_version: detailData.history.version,
          event_type: historyEventType,
          summary: null,
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
      setHistoryAdditionalKeys([])
      setHistorySaveOpen(false)

      if (incrementalOutput) {
        try {
          await navigator.clipboard.writeText(incrementalOutput)
          setCopyMessage(`Perubahan tersimpan dan output audit disalin`)
        } catch {
          setCopyMessage(`Perubahan tersimpan, tetapi clipboard tidak tersedia`)
        }
      } else {
        setCopyMessage(`Perubahan tersimpan. Tidak ada baris bernominal untuk disalin.`)
      }
      window.setTimeout(() => setCopyMessage(''), 3000)
    } catch (err) {
      setCopyMessage(err instanceof Error ? err.message : 'Gagal menyimpan versi Riwayat')
      window.setTimeout(() => setCopyMessage(''), 3000)
    } finally {
      setHistorySaveBusy(false)
    }
  }

  async function confirmMakerImport() {
    if (role !== 'admin' || !importParse.groups.length || importParse.errors.length > 0 || importBusy) return
    setImportBusy(true)
    setImportMessage('')
    try {
      const items = importParse.groups.map(group => ({
        kitchen_id: group.kitchenId,
        transaction_date: group.transactionDate,
        title: 'Import final ' + group.kitchenName + ' - ' + group.transactionDate,
        payload: {
          kitchenId: group.kitchenId,
          kitchenName: group.kitchenName,
          transactionDate: group.transactionDate,
          transaction: group.transaction,
          output: group.output,
          totalRab: group.totalRab,
          totalOpsHarian: group.totalOpsHarian,
          totalOverall: group.totalOverall
        }
      }))
      const { data, error } = await supabase.functions.invoke('maker-history', {
        body: { action: 'import', mode: importMode, items },
        headers: { Authorization: `Bearer ${token}` }
      })
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Import gagal disimpan.')

      const first = importParse.groups[0]
      const restored = normalizeTransaction({ ...first.transaction, id: 1 }, first.transactionDate)
      setHistoryChangeBase(null)
      setHistoryEntryKeys([])
      setHistoryAdditionalKeys([])
      setKitchenId(first.kitchenId)
      setTransactions([restored])
      setActiveTransactionId(1)
      persistWorkspace({ kitchenId: first.kitchenId, activeTransactionId: 1, transactions: [restored] })
      setImportOpen(false)
      setImportConfirmOpen(false)
      setImportText('')
      setHistoryMessage(
        (importMode === 'replace' ? 'Replace berhasil. ' : 'Import berhasil. ') +
        String(data?.created_count ?? importParse.groups.length) + ' snapshot final tersimpan' +
        (Number(data?.replaced_count ?? 0) > 0
          ? '; ' + data.replaced_count + ' snapshot lama dipindahkan ke arsip.'
          : '.')
      )
      setCopyMessage('')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Import gagal diproses.')
      setImportConfirmOpen(false)
    } finally {
      setImportBusy(false)
    }
  }

  const activeRabMap: Map<string, RabEntry> = new Map(
    (activeTransaction?.rab ?? []).map(
      (entry) => [entry.accountId, entry] as [string, RabEntry]
    )
  )

  return (
    <main className="min-h-screen overflow-x-clip bg-slate-950 p-2 text-white sm:p-3 md:p-4">
      <div className="mx-auto w-full max-w-[1040px]">
        <>
          {masterData && !masterLoading && !masterError && (
            <div className="mt-3 mb-2 flex w-fit max-w-full flex-wrap items-end gap-2">
              <div className="w-[180px] shrink-0">
                <label htmlFor="date" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Tanggal</label>
                <div className="mp-date-control mp-control-surface relative flex h-9 items-center px-2.5 transition">
                  <span className="mp-date-label whitespace-nowrap text-[10px] font-semibold tracking-wide">TANGGAL</span>
                  <span className="mp-date-value ml-2 whitespace-nowrap text-xs font-semibold tabular-nums">{formatDate(activeDate)}</span>
                  <input ref={dateInputRef} id="date" type="date" value={activeDate} onChange={(event) => changeActiveDate(event.target.value)} onClick={(event) => { event.stopPropagation(); openDatePicker() }} aria-label="Pilih tanggal transaksi" className="absolute inset-0 h-full w-full opacity-0" />
                </div>
              </div>
              {!fixedKitchen && (
                <div className="w-[190px] shrink-0">
                  <label htmlFor="workspace-kitchen" className="mb-1 block text-xs font-medium leading-4 text-slate-300">Dapur</label>
                  <select id="workspace-kitchen" value={kitchenId} onChange={(event) => handleKitchenChange(event.target.value)} className="mp-kitchen-select mp-control-surface h-9 w-full px-2.5 text-xs font-semibold text-white">
                    <option value="">Pilih dapur</option>
                    {masterData?.kitchens.map((kitchen) => <option key={kitchen.id} value={kitchen.id}>{kitchen.name}</option>)}
                  </select>
                </div>
              )}
              {kitchenId && activeTransaction && (
                <div className="flex items-end gap-1.5">
                  <button type="button" onClick={() => setHistoryOpen(true)} className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-3 text-[10px] font-semibold text-slate-200 shadow-sm transition">Riwayat</button>
                  {role === 'admin' && (
                    <button type="button" onClick={() => { setImportOpen(true); setImportMessage(''); setImportConfirmOpen(false) }} className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-3 text-[10px] font-semibold text-slate-200 shadow-sm transition">Import Data</button>
                  )}
                  <button type="button" onClick={resetWorkspace} className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-[10px] font-medium text-slate-200 shadow-sm transition">Reset</button>
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
                className="mt-3 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white"
              >
                Coba Lagi
              </button>
            </div>
          )}

          {masterData && !masterLoading && !masterError && (
            <>
              <div
                className={[
                  'mt-2 mb-2 grid min-w-0 grid-cols-1 items-stretch gap-2',
                  kitchenId && activeTransaction
                    ? 'lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.4fr)]'
                    : ''
                ].join(' ')}
              >
                <section className="mp-card flex h-full min-w-0 flex-col rounded-xl p-2.5">
                  {kitchenId && activeTransaction && (
                    <>
                      <div className="mp-output-header mt-0 flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-800/90 pt-1.5">
                        <div className="flex min-w-0 shrink-0 items-center gap-2">
                          <h2 className="text-sm font-semibold">Output</h2>
                          <span
                            aria-label={outputLineCount + ' baris output'}
                            className="mp-output-count inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums"
                          >
                            {outputLineCount}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                          <p role="note" className="max-w-full text-right text-[10px] font-semibold leading-4 text-amber-200 sm:max-w-[420px]">
                            Periksa kembali seluruh pencairan sebelum disimpan.
                          </p>
                          {copyMessage && <span role="status" className="text-[10px] font-semibold text-emerald-300">{copyMessage}</span>}
                        </div>
                      </div>

                      <div className="mt-2 flex min-h-[135px] flex-1 flex-col gap-2">
                        <pre
                          role="button"
                          tabIndex={output && incompleteCustomOperationalRows.length === 0 ? 0 : -1}
                          aria-disabled={!output || incompleteCustomOperationalRows.length > 0}
                          aria-label="Klik untuk menyalin output"
                          title={incompleteCustomOperationalRows.length > 0 ? 'Lengkapi semua data CUSTOM sebelum menyalin output' : 'Klik untuk menyalin output'}
                          onClick={() => void copyOutputText()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void copyOutputText()
                            }
                          }}
                          className="mp-output-copy max-h-[30vh] flex-1 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-slate-800 bg-gradient-to-b from-slate-950 to-slate-900/80 p-2 text-left text-[10px] leading-4 text-slate-200 shadow-inner shadow-black/20"
                        >{output}</pre>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" disabled={(!output && !historyChangeBase) || historySaveBusy || incompleteCustomOperationalRows.length > 0} onClick={() => void copyOutput()} className="self-start rounded-lg border border-emerald-700 bg-emerald-950/50 px-3 py-2 text-[11px] font-semibold text-emerald-200 disabled:opacity-40" title={incompleteCustomOperationalRows.length > 0 ? 'Lengkapi semua data CUSTOM sebelum disimpan' : undefined}>{historySaveBusy ? 'Menyimpan...' : 'Copy dan Simpan'}</button>
                          {historyChangeActive && (
                            <button type="button" disabled={historySaveBusy} onClick={cancelHistoryChange} className="mp-revision-cancel-button self-start rounded-lg px-3 py-2 text-[11px] font-semibold disabled:opacity-40">
                              Batalkan Revisi
                            </button>
                          )}
                        </div>
                      </div>

                    </>
                  )}
                </section>

                {kitchenId && activeTransaction && (
                  <aside className="mp-card mp-summary-panel flex h-full min-w-0 flex-col rounded-xl p-2.5" aria-label="Total nominal dan status pencairan">
                    <div className="space-y-2">
                      <div className="mp-summary-total-card rounded-lg border px-2.5 py-2 text-center">
                        <div className="mp-summary-total-label text-[10px]">Total RAB</div>
                        <div className="mp-summary-total-value mt-0.5 break-words text-lg font-semibold tabular-nums">Rp {formatNumber(String(totalRab)) || '0'}</div>
                      </div>
                      <div className="mp-summary-total-card rounded-lg border px-2.5 py-2 text-center">
                        <div className="mp-summary-total-label text-[10px]">Total Ops Harian</div>
                        <div className="mp-summary-total-value mt-0.5 break-words text-lg font-semibold tabular-nums">Rp {formatNumber(String(totalOpsHarian)) || '0'}</div>
                        {opsHarianBreakdown.length > 0 && (
                          <div className="mp-summary-breakdown mt-2 w-full min-w-0 max-w-full space-y-1 border-t border-slate-700/60 pt-2 text-[10px] text-slate-400">
                            {opsHarianBreakdown.map(({ label, amount }) => (
                              <div key={label} className="mp-summary-breakdown-row">
                                <span className="mp-summary-breakdown-label">{label}</span>
                                <span className="mp-summary-breakdown-amount tabular-nums">Rp {formatNumber(String(amount))}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {outputDisplayChecks.length > 0 && (
                      <div className="mp-summary-checks mt-auto flex w-full min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-2 text-center">
                        {outputDisplayChecks.map(({ label, complete }) => (
                          <span
                            key={label}
                            className={`mp-summary-check text-center text-[10px] font-semibold leading-4 ${complete ? 'is-complete' : 'is-incomplete'}`}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </aside>
                )}
              </div>

              <div className="mp-form-stack flex min-w-0 w-full max-w-[1040px] flex-col gap-3">
                {kitchenId && activeTransaction && (
                <>
                  <section className="mp-card mp-card--rgb-rim w-full min-w-0 rounded-2xl border border-amber-500/45 bg-gradient-to-b from-slate-900 to-slate-950 p-3.5 shadow-lg shadow-black/15">
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
                            className={`mp-rab-row grid min-w-0 items-center gap-3 p-2.5 ${!historyEnabled ? "opacity-45" : ""}`}
                          >
                            <div className="mp-rab-details min-w-0">
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
                                        className="mp-rab-choice inline-flex h-9 items-center rounded-md border border-slate-700 bg-slate-900 px-2.5 text-xs font-medium text-slate-300 transition"
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
                                    className="mp-rab-add inline-flex h-9 items-center rounded-md border border-dashed px-2.5 text-xs font-semibold transition disabled:opacity-40"
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
                                        className={`h-8 w-[100px] rounded-md border border-slate-700 bg-slate-900 px-2 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none  ${hasOutputAmount('RAB : ', rule.accounts?.account_number ?? '-', entry.amount) && Boolean((customDraft[fieldIndex] ?? '').trim()) ? 'mp-field--has-output' : ''}`}
                                      />
                                    ))}
                                  </div>
                                )}
                            </div>
<div className={`mp-payment-nominal mp-rab-nominal ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center gap-1.5 ${hasHistoryPreviousAmount('rab:' + rule.account_id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('rab:' + rule.account_id)}
<input
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
                              placeholder="Nominal"
                              className={`mp-nominal-input mp-rab-amount h-10 w-full min-w-0 px-3 text-center text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition ${hasOutputAmount('RAB : ', rule.accounts?.account_number ?? '-', entry.amount) ? 'mp-field--has-output' : ''}`}
                            />{renderHistoryAdditionalButton('rab:' + rule.account_id, () => updateRabEntry(activeTransaction.id, rule.account_id, { amount: '' }), () => updateRabEntry(activeTransaction.id, rule.account_id, { amount: historyPreviousAmount('rab:' + rule.account_id) }))}</div>
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
                                    className="rounded-md border border-amber-700/70 bg-amber-950/40 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 disabled:opacity-40"
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
                                            : 'border-slate-700 bg-slate-900 text-slate-300 ')}
                                        >
                                          {selected ? '✓ ' : ''}{product}
                                        </button>
                                      )
                                    })}
<div className={`mp-payment-nominal mp-rab-b3-nominal ml-auto ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center justify-end gap-1.5 ${hasHistoryPreviousAmount('rab_b3:' + rule.account_id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('rab_b3:' + rule.account_id)}
<input
                                      type="text"
                                      inputMode="numeric"
                                      value={formatNumber(entry.b3Amount ?? '')}
                                      disabled={!b3HistoryEnabled}
                                      onChange={(event) => updateRabEntry(activeTransaction.id, rule.account_id, {
                                        b3Enabled: true,
                                        b3Amount: event.target.value.replace(/\D/g, '')
                                      })}
                                      placeholder="Nominal B3"
                                      aria-label="Nominal RAB B3 Toko Arumikata"
                                      className="mp-nominal-input mp-rab-amount h-10 w-full min-w-0 px-2.5 text-center text-sm font-semibold text-white placeholder:text-slate-500"
                                    />{renderHistoryAdditionalButton('rab_b3:' + rule.account_id, () => updateRabEntry(activeTransaction.id, rule.account_id, { b3Amount: '' }), () => updateRabEntry(activeTransaction.id, rule.account_id, { b3Amount: historyPreviousAmount('rab_b3:' + rule.account_id) }))}</div>
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


                  <section className={`mp-card mp-card--rgb-rim relative w-full min-w-0 rounded-xl border border-teal-600/70 bg-slate-900/40 p-3 ${operationalAddMenuOpen ? 'z-40' : 'z-0'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-white">Pencairan Operasional Harian</h2>
                      <div className="relative" ref={operationalAddMenuRef}>
                        <button type="button" aria-expanded={operationalAddMenuOpen} onClick={() => setOperationalAddMenuOpen((open) => !open)} className="h-9 shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-100 transition">+ Transaksi</button>
                        {operationalAddMenuOpen && (
                          <div className="mp-operational-add-menu absolute right-0 z-[60] mt-1 flex min-w-48 flex-col gap-1 rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl">
                            {opsMappings.map((rule) => (
                              <button key={rule.id} type="button" onClick={() => addMappedOperationalEntry(rule.id)} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100">Ops Harian — {rule.owner_name}</button>
                            ))}
                            {opsMappings.length === 0 && <button type="button" disabled className="rounded-md px-3 py-2.5 text-left text-xs text-slate-500">Ops Harian — Mapping belum tersedia</button>}
                            {!isCihaurKitchen && <>
                              <button type="button" onClick={addArutalaOtherEntry} disabled={!arutalaGasRule?.accounts} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 disabled:opacity-40">Arutala</button>
                              <button type="button" onClick={addGasEntry} disabled={!arutalaGasRule?.accounts || (activeTransaction.gas ?? []).filter((entry, index) => entry.transactionType === 'gas' || (index === 0 && !entry.transactionType)).length >= 2} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100 disabled:opacity-40">GAS</button>
                            </>}
                            <button type="button" onClick={addOperationalEntry} className="rounded-md px-3 py-2.5 text-left text-xs font-semibold text-slate-100">Lain-lain</button>
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
                              const gasQuantityForNote = (entry.gasQuantity ?? '').replace(/\D/g, '').replace(/^0+/, '')
                              const gasSizeForNote = entry.gasSize === '12kg' || entry.gasSize === '50kg' ? entry.gasSize : ''
                              const gasDescriptionForNote = gasQuantityForNote && gasSizeForNote
                                ? 'Gas ' + gasSizeForNote + ' (' + gasQuantityForNote + ' tabung)'
                                : 'Gas'
                              const gasNoteMaxLength = Math.max(0, 109 - gasDescriptionForNote.length - 2)
                              const rule = arutalaGasRule
                              const accountName = capitalizeEachWord(rule?.supplier?.business_name || rule?.accounts?.name || 'Mapping belum tersedia')
                              const bank = rule?.accounts?.bank ?? '-'
                              const accountNumber = rule?.accounts?.account_number ?? '-'
                              return (
                                <div key={entry.id} className={`mp-ops-row ${!historyEnabled ? "opacity-45" : ""}`}>
                                  <div className="mp-gas-flex-row grid min-w-0 items-center gap-2">
                                    <button type="button" onClick={() => removeGasEntry(entry.id)} disabled={!historyEnabled} aria-label="Hapus transaksi GAS" title="Hapus transaksi" className="mp-row-remove h-9 w-9 shrink-0 text-base text-slate-400">×</button>
                                    <div className="mp-tag mp-tag--gas">GAS</div>
                                    <div title={accountName} className="mp-ops-field mp-payment-detail mp-gas-owner flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountName}</span></div>
                                    <div className="mp-ops-field mp-payment-detail mp-gas-bank flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100">{bank}</div>
                                    <div title={accountNumber} className="mp-ops-field mp-payment-detail mp-gas-account flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountNumber}</span></div>
                                    <div className={`mp-gas-quantity mp-gas-quantity-stack ${renderHistoryPreviousGasQuantity(entry.id) ? 'mp-has-history-previous' : ''}`}>
                                      {renderHistoryPreviousGasQuantity(entry.id)}
                                      <input type="text" inputMode="numeric" value={entry.gasQuantity ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasQuantity: event.target.value.replace(/\D/g, '').replace(/^0+/, '') })} placeholder="Jml" aria-label="Jumlah tabung gas" className="mp-ops-field mp-payment-detail mp-gas-quantity-input h-10 min-w-0 px-2 text-center text-xs text-slate-100" />
                                    </div>
                                    <select value={entry.gasSize ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasSize: event.target.value as SimpleEntry['gasSize'] })} aria-label="Ukuran gas" className="mp-ops-field mp-payment-detail mp-gas-size h-10 min-w-0 px-2 text-center text-xs text-slate-100"><option value="">Ukr</option><option value="12kg">12 kg</option><option value="50kg">50 kg</option></select>
                                    <input type="text" value={(entry.gasNote ?? '').slice(0, gasNoteMaxLength)} maxLength={gasNoteMaxLength} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { gasNote: event.target.value.slice(0, gasNoteMaxLength) })} placeholder="Catatan" aria-label="Catatan tambahan GAS (mengikuti sisa batas 109 karakter)" className="mp-ops-field mp-payment-detail mp-gas-note h-10 min-w-0 px-2 text-center text-xs text-slate-100" />
                                    <div className={`mp-payment-nominal ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center justify-end gap-1.5 ${hasHistoryPreviousAmount('gas:' + entry.id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('gas:' + entry.id)}
<input type="text" inputMode="numeric" value={formatNumber(entry.amount)} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: event.target.value.replace(/\D/g, '') })} placeholder="Nominal" aria-label="Nominal GAS" className="mp-ops-field mp-nominal-input h-10 w-full min-w-0 px-2 text-center text-sm font-semibold text-white" />{renderHistoryAdditionalButton('gas:' + entry.id, () => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: '' }), () => updateSimpleEntry(activeTransaction.id, 'gas', entry.id, { amount: historyPreviousAmount('gas:' + entry.id) }))}</div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-3 space-y-1.5">
                          {entries.map((entry, index) => {
                            const historyEnabled = isHistoryRowEnabled('operasional', entry.id)
                                                        const isMappedOps = entry.operationalRuleType === 'ops_harian'
                            const custom = !isMappedOps && (index > 0 || Boolean(entry.customAccount))
                            const isArutala = Boolean(entry.useArutalaAccount)
                            const isStrictCustom = isCustomOperationalEntry(entry, index)
                            const customFieldStatus = {
                              ownerName: getCustomOperationalFieldStatus(entry, 'ownerName'),
                              bank: getCustomOperationalFieldStatus(entry, 'bank'),
                              accountNumber: getCustomOperationalFieldStatus(entry, 'accountNumber'),
                              need: getCustomOperationalFieldStatus(entry, 'need'),
                              amount: getCustomOperationalFieldStatus(entry, 'amount')
                            }
                            const mappedOpsRule = isMappedOps
                              ? opsMappings.find((rule) => rule.id === entry.operationalRuleId)
                              : null
                            const arutalaAccount = arutalaGasRule?.accounts
                            const arutalaOwnerName = arutalaGasRule?.supplier?.business_name || arutalaAccount?.name || 'Koperasi Arutala'
                            const selectedType = entry.operationalRuleType ?? ''
                            const isSalaryCategory = selectedType === 'gaji_akuntan' || selectedType === 'gaji_ahli_gizi'
                            const selectedRuleType = isSalaryCategory ? selectedType : ''
                            const selectedMapping = selectedRuleType
                              ? getOperationalMapping(selectedKitchen?.name ?? '', masterData, selectedRuleType)
                              : null
                            const isMappedSalary = isSalaryCategory
                                                  const showVirtualAccount = custom && !isArutala && !isSalaryCategory
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
                            return (
                              <div key={entry.id} className={`mp-ops-row ${!historyEnabled ? 'opacity-45' : ''}`}>
                                <div className={`mp-ops-flex-row grid min-w-0 items-center gap-2 ${showVirtualAccount ? (entry.isVirtualAccount ? 'is-va' : 'has-va') : 'is-standard'}`}>
                                  <button
                                    type="button"
                                    onClick={() => removeOperationalEntry(entry.id)}
                                    disabled={!historyEnabled}
                                    title="Hapus transaksi tambahan Operasional Harian"
                                    aria-label="Hapus transaksi Ops Harian"
                                    className="mp-row-remove h-9 w-9 shrink-0 text-base text-slate-400 disabled:opacity-25"
                                  >×</button>
                                  {isMappedOps ? (
                                    <div className="mp-tag mp-tag--ops">OPS HARIAN</div>
                                  ) : custom ? (isArutala ? (
                                    <div className="mp-tag mp-tag--arutala">ARUTALA</div>
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
                                          isVirtualAccount: nextType === 'gaji_akuntan' || nextType === 'gaji_ahli_gizi'
                                            ? false
                                            : Boolean(entry.isVirtualAccount),
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
                                      className="mp-tag mp-tag--custom mp-payment-detail h-9 w-full min-w-0 appearance-none px-2 text-center text-[10px] font-extrabold uppercase outline-none transition"
                                    >
                                      <option value="">Custom</option>
                                      <option value="gaji_akuntan">Gaji AK</option>
                                      <option value="gaji_ahli_gizi">Gaji AG</option>
                                    </select>
                                  )) : (
                                    <div className="mp-tag mp-tag--ops">OPS HARIAN</div>
                                  )}
                                  {showVirtualAccount && (
                                    <label className="mp-va-toggle flex h-9 min-w-0 items-center justify-center gap-1.5 px-1 text-[10px] font-semibold text-slate-200">
                                      <input type="checkbox" checked={Boolean(entry.isVirtualAccount)} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { isVirtualAccount: event.target.checked })} aria-label="Transfer Virtual Account" className="h-3.5 w-3.5 shrink-0 accent-teal-400" />
                                      <span>VA</span>
                                    </label>
                                  )}
                                  {!(showVirtualAccount && entry.isVirtualAccount) && (
                                    custom && !isMappedSalary && !isArutala ? (
                                      <div className="mp-custom-field-wrap mp-ops-owner">
                                      <input type="text" value={ownerName} maxLength={30} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { ownerName: event.target.value.slice(0, 30) })} placeholder="Nama rekening" aria-label="Nama rekening Ops Harian (maksimal 30 karakter)" className="mp-custom-field-control mp-ops-field mp-payment-detail h-10 min-w-0 px-2.5 text-center text-xs text-slate-100 placeholder:text-slate-500 outline-none transition" />
                                      {isStrictCustom && customFieldStatus.ownerName !== 'not-required' && (
                                        <span className={`mp-custom-field-dot ${customFieldStatus.ownerName}`} role="img" aria-label={customFieldStatus.ownerName === 'is-complete' ? 'Nama rekening terisi' : 'Nama rekening belum diisi'} title={customFieldStatus.ownerName === 'is-complete' ? 'Nama rekening terisi' : 'Nama rekening belum diisi'} />
                                      )}
                                    </div>
                                  ) : (
                                      <div title={ownerName || 'Mapping belum tersedia'} className="mp-ops-field mp-payment-detail mp-ops-owner flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{capitalizeEachWord(ownerName || 'Mapping belum tersedia')}</span></div>
                                    )
                                  )}
                                  {custom && !isMappedSalary && !isArutala ? (
                                    <div className="mp-custom-field-wrap mp-ops-bank">
                                      <select value={entry.bank ?? ''} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { bank: event.target.value })} aria-label="Bank Ops Harian" className="mp-custom-field-control mp-ops-field mp-payment-detail h-10 min-w-0 appearance-none px-2 text-center text-xs text-slate-100 outline-none transition">
                                        <option value="">Nama bank</option>
                                        {OPERATIONAL_BANKS.map((bankOption) => <option key={bankOption} value={bankOption}>{bankOption}</option>)}
                                      </select>
                                      <span className={`mp-custom-field-dot ${customFieldStatus.bank}`} role="img" aria-label={customFieldStatus.bank === 'is-complete' ? 'Nama bank terisi' : 'Nama bank belum diisi'} title={customFieldStatus.bank === 'is-complete' ? 'Nama bank terisi' : 'Nama bank belum diisi'} />
                                    </div>
                                  ) : (
                                    <div title={bank || '-'} className="mp-ops-field mp-payment-detail mp-ops-bank flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100">{bank || '-'}</div>
                                  )}
                                  {custom && !isMappedSalary && !isArutala ? (
                                    <div className="mp-custom-field-wrap mp-ops-account">
                                      <input type="text" inputMode="numeric" value={entry.accountNumber} disabled={!historyEnabled} onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { accountNumber: event.target.value.replace(/\D/g, '') })} placeholder="Nomor rekening" aria-label="Nomor rekening Ops Harian" className="mp-custom-field-control mp-ops-field mp-payment-detail h-10 min-w-0 px-2.5 text-center text-xs text-slate-100 placeholder:text-slate-500 outline-none transition" />
                                      <span className={`mp-custom-field-dot ${customFieldStatus.accountNumber}`} role="img" aria-label={customFieldStatus.accountNumber === 'is-complete' ? 'Nomor rekening terisi' : 'Nomor rekening belum diisi'} title={customFieldStatus.accountNumber === 'is-complete' ? 'Nomor rekening terisi' : 'Nomor rekening belum diisi'} />
                                    </div>
                                  ) : (
                                    <div title={accountNumber || '-'} className="mp-ops-field mp-payment-detail mp-ops-account flex h-10 min-w-0 items-center justify-center px-2 text-center text-xs font-semibold text-slate-100"><span className="truncate">{accountNumber || '-'}</span></div>
                                  )}
                                  {custom && !isMappedSalary && !isArutala ? (
                                    <div className="mp-custom-field-wrap mp-ops-note">
                                      <input
                                        type="text"
                                        disabled={!historyEnabled}
                                        value={entry.need}
                                        maxLength={109}
                                        onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { need: event.target.value.slice(0, 109) })}
                                        placeholder="Catatan"
                                        aria-label="Catatan Operasional Harian (maksimal 109 karakter)"
                                        className="mp-custom-field-control mp-payment-detail mp-ops-field h-10 min-w-0 text-center px-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none transition"
                                      />
                                      <span className={`mp-custom-field-dot ${customFieldStatus.need}`} role="img" aria-label={customFieldStatus.need === 'is-complete' ? 'Catatan terisi' : 'Catatan belum diisi'} title={customFieldStatus.need === 'is-complete' ? 'Catatan terisi' : 'Catatan belum diisi'} />
                                    </div>
                                  ) : (
                                    <input
                                      type="text"
                                      disabled={!historyEnabled}
                                      value={entry.need || ((isMappedOps || isArutala) ? 'Ops Harian' : '')}
                                      maxLength={109}
                                      onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { need: event.target.value.slice(0, 109) })}
                                      placeholder={(isMappedOps || isArutala) ? 'Ops Harian' : 'Catatan'}
                                      aria-label="Catatan Operasional Harian (maksimal 109 karakter)"
                                      className={`mp-payment-detail mp-ops-note h-10 w-full min-w-0 text-center ${isMappedOps || isArutala ? 'mp-static-field mp-salary-field mp-ops-note--mapped' : 'mp-ops-field'} ${custom ? 'text-slate-100' : 'text-slate-300'} px-2.5 text-xs placeholder:text-slate-500 outline-none transition `}
                                    />
                                  )}
                                  <div className={`mp-payment-nominal ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center justify-end gap-1.5 ${hasHistoryPreviousAmount('operasional:' + entry.id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('operasional:' + entry.id)}
<input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!historyEnabled}
                                    onChange={(event) => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: event.target.value.replace(/\D/g, '') })}
                                    aria-label="Nominal Ops Harian"
                                    
                                    placeholder="Nominal"
                                    className={`mp-ops-field mp-nominal-input h-10 w-full min-w-0 px-2.5 text-center text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition   disabled:opacity-50 ${hasOutputAmount('OPS HARIAN : ', accountNumber, entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{isStrictCustom && (
                                    <span className={`mp-custom-field-dot ${customFieldStatus.amount}`} role="img" aria-label={customFieldStatus.amount === 'is-complete' ? 'Nominal terisi' : 'Nominal belum diisi'} title={customFieldStatus.amount === 'is-complete' ? 'Nominal terisi' : 'Nominal belum diisi'} />
                                  )}{renderHistoryAdditionalButton('operasional:' + entry.id, () => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: '' }), () => updateSimpleEntry(activeTransaction.id, 'operasional', entry.id, { amount: historyPreviousAmount('operasional:' + entry.id) }))}</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        </div>
                      )
                    })()}
                  </section>

                  <section className="mp-card mp-card--rgb-rim w-full min-w-0 rounded-xl border border-teal-600/50 bg-slate-950/35 p-3">
                    <h2 className="text-base font-semibold text-white">Pencairan Insentif dan Gaji</h2>
                    <div className="mt-3 space-y-1.5">
                      
                        {activeTransaction.pencairan_harian
                          .filter((entry) => entry.category === 'sewa' && isHistoryRowEnabled('pencairan_harian', entry.id))
                          .map((entry) => {
                            const historyEnabled = isHistoryRowEnabled('pencairan_harian', entry.id)
                            const rental = getSppgRental(selectedKitchen?.name ?? '', masterData)
                            return (
                              <div
                                key={entry.id}
                                className={`mp-payment-row mp-salary-flex-row grid min-w-0 items-center gap-2 ${!historyEnabled ? "opacity-45" : ""}`}
                              >
                                  <div className="mp-tag mp-tag--salary mp-payment-detail flex h-9 min-w-0 items-center justify-center text-center text-[10px] font-extrabold uppercase">
                                    Insentif Fasilitas SPPG
                                  </div>
                                  <div className="mp-salary-account-details">
                                    <div title={rental?.ownerName ?? 'Mapping belum tersedia'} className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100">
                                      <span title={rental?.ownerName ?? 'Mapping belum tersedia'} className="truncate">{rental?.ownerName ?? 'Mapping belum tersedia'}</span>
                                    </div>
                                    <div title={rental?.bank ?? '-'} className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100">
                                      {rental?.bank ?? '-'}
                                    </div>
                                    <div className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100">
                                      <span title={rental?.accountNumber ?? '-'} className="truncate">{rental?.accountNumber ?? '-'}</span>
                                    </div>
                                  </div>
                                  <div className={`mp-payment-nominal ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center justify-end gap-1.5 ${hasHistoryPreviousAmount('pencairan_harian:' + entry.id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('pencairan_harian:' + entry.id)}
<input
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
                                    placeholder="Nominal"
                                    aria-label="Nominal Insentif Fasilitas SPPG"
                                    className={`mp-nominal-input h-10 w-full min-w-0 px-3 text-center text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition   disabled:opacity-50 ${hasOutputAmount('INSENTIF FASILITAS SPPG : ', rental?.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{renderHistoryAdditionalButton('pencairan_harian:' + entry.id, () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: '' }), () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: historyPreviousAmount('pencairan_harian:' + entry.id) }))}</div>
                              </div>
                            )
                          })}
                      </div>

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

                      <div className="mt-1.5 space-y-1.5">
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
                                <div className="mp-payment-row mp-salary-flex-row grid min-w-0 items-center gap-2">
                                  <div
                                    title={label}
                                    className="mp-tag mp-tag--salary mp-payment-detail flex h-9 min-w-0 items-center justify-center text-center text-[10px] font-extrabold uppercase"
                                  >
                                    <span title={label} className="truncate">{label}</span>
                                  </div>
                                  <div className="mp-salary-account-details">
                                    <div
                                      title={mapping?.ownerName ?? 'Mapping belum tersedia'}
                                      className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100"
                                    >
                                      <span title={mapping?.ownerName ?? 'Mapping belum tersedia'} className="truncate">{mapping?.ownerName ?? 'Mapping belum tersedia'}</span>
                                    </div>
                                    <div className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100">
                                      {mapping?.bank ?? '-'}
                                    </div>
                                    <div className="mp-static-field mp-payment-detail mp-salary-field flex h-10 min-w-0 items-center justify-center px-3 text-center text-sm font-semibold text-slate-100">
                                      <span title={mapping?.accountNumber ?? '-'} className="truncate">{mapping?.accountNumber ?? '-'}</span>
                                    </div>
                                  </div>
                                  <div className={`mp-payment-nominal ${historyChangeActive ? 'mp-revision-nominal' : ''} flex min-w-0 items-center justify-end gap-1.5 ${hasHistoryPreviousAmount('pencairan_harian:' + entry.id) ? 'mp-has-history-previous' : ''}`}>
                                    {renderHistoryPreviousAmount('pencairan_harian:' + entry.id)}
<input
                                    type="text"
                                    inputMode="numeric"
                                    value={formatNumber(entry.amount)}
                                    disabled={!historyEnabled}
                                    onChange={(event) =>
                                      updateDailyPaymentEntry(
                                        activeTransaction.id,
                                        entry.id,
                                        { amount: event.target.value.replace(/\D/g, '') }
                                      )
                                    }
                                    placeholder="Nominal"
                                    aria-label={'Nominal ' + label}
                                    className={`mp-nominal-input h-10 w-full min-w-0 px-3 text-center text-sm font-semibold text-slate-100 placeholder:text-slate-500 outline-none transition   disabled:opacity-50 ${hasOutputAmount(entry.kinds.join(', ').toLocaleUpperCase('id-ID') + ' : ', mapping?.accountNumber ?? entry.accountNumber ?? '', entry.amount) ? 'mp-field--has-output' : ''}`}
                                  />{renderHistoryAdditionalButton('pencairan_harian:' + entry.id, () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: '' }), () => updateDailyPaymentEntry(activeTransaction.id, entry.id, { amount: historyPreviousAmount('pencairan_harian:' + entry.id) }))}</div>
                                </div>
                              </div>
                            )
                          })}
                      </div>
                  </section>




                </>
              )}
              </div>
            </>
          )}
        </>
      </div>
      {importOpen && role === 'admin' && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-3 sm:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="mp-import-title" className="mp-import-dialog max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border p-4 shadow-2xl sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="mp-import-title" className="text-base font-bold">Import Output Maker-Pencairan</h2>
                <p className="mt-1 text-xs leading-5">Paste output lengkap yang disalin dari Maker-Pencairan. Parser membaca dapur, tanggal, rekening, kategori, catatan, dan nominal.</p>
              </div>
              <button type="button" disabled={importBusy} onClick={() => { setImportOpen(false); setImportConfirmOpen(false) }} className="mp-import-close rounded-lg px-3 py-1.5 text-xs font-semibold">Tutup</button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" disabled={importBusy} onClick={() => { setImportMode('insert'); setImportConfirmOpen(false) }} className={'mp-import-mode rounded-lg border px-3 py-2.5 text-left text-xs font-semibold' + (importMode === 'insert' ? ' is-active' : '')}>
                Import Baru
                <span className="mt-1 block text-[10px] font-normal opacity-75">Hanya tanggal yang belum memiliki snapshot aktif.</span>
              </button>
              <button type="button" disabled={importBusy} onClick={() => { setImportMode('replace'); setImportConfirmOpen(false) }} className={'mp-import-mode rounded-lg border px-3 py-2.5 text-left text-xs font-semibold' + (importMode === 'replace' ? ' is-active' : '')}>
                Replace Data
                <span className="mt-1 block text-[10px] font-normal opacity-75">Ganti seluruh snapshot aktif untuk setiap dapur dan tanggal yang dipaste.</span>
              </button>
            </div>

            <label htmlFor="mp-import-output" className="mt-4 mb-1.5 block text-xs font-semibold">Output final akuntan</label>
            <textarea
              id="mp-import-output"
              value={importText}
              onChange={(event) => { setImportText(event.target.value); setImportConfirmOpen(false); setImportMessage('') }}
              disabled={importBusy}
              maxLength={500000}
              placeholder={'Paste output di sini. Contoh:\nCise..., 20-Nov-2026\nRAB : Nama Supplier - BNI / 123456789 · Sayur · 1.000.000\nOPS HARIAN : Koperasi Arutala - BNI / 1985322260 · Gas 12kg (3 tabung) · 270.000'}
              className="mp-import-textarea h-40 w-full resize-y rounded-xl border px-3 py-2.5 text-xs leading-5 outline-none sm:h-48"
            />

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-slate-400">
                {importText.trim() ? importParse.groups.length + ' kelompok terbaca · ' + importParse.errors.length + ' masalah' : 'Parser menerima beberapa dapur dan tanggal dalam satu paste.'}
              </div>
              <button type="button" disabled={importBusy || !importText.trim()} onClick={() => setImportText('')} className="mp-import-close rounded-lg px-3 py-1.5 text-xs">Kosongkan</button>
            </div>

            {importParse.groups.length > 0 && (
              <div className="mp-import-preview mt-3 max-h-52 space-y-2 overflow-auto rounded-xl border p-3">
                <div className="text-xs font-bold">Preview snapshot</div>
                {importParse.groups.map(group => (
                  <div key={group.kitchenId + ':' + group.transactionDate} className="mp-import-preview-group rounded-lg border px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold">{group.kitchenName} · {formatDate(group.transactionDate)}</div>
                      <div className="text-[10px] tabular-nums">{group.lines.length} transaksi</div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {group.categories.map(category => <span key={category.label} className="text-[10px]">{category.label}: {category.count} · Rp {formatNumber(String(category.amount))}</span>)}
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 border-t pt-2 text-[10px]">
                      <span>RAB Rp {formatNumber(String(group.totalRab)) || '0'} · Ops & Insentif Rp {formatNumber(String(group.totalOpsHarian)) || '0'}</span>
                      <strong>Total Rp {formatNumber(String(group.totalOverall)) || '0'}</strong>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {importParse.errors.length > 0 && (
              <div className="mp-import-errors mt-3 max-h-32 overflow-auto rounded-lg border px-3 py-2.5 text-[11px]" role="alert">
                <div className="mb-1 font-bold">Import belum aman. Perbaiki output berikut:</div>
                {importParse.errors.map((item, index) => <div key={index} className="py-0.5">• {item}</div>)}
              </div>
            )}
            {importMessage && <p role="alert" className="mt-3 rounded-lg border border-rose-700/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{importMessage}</p>}

            {importConfirmOpen && (
              <div className="mp-import-confirm mt-3 rounded-xl border px-3 py-3">
                <div className="text-xs font-bold">{importMode === 'replace' ? 'Konfirmasi Replace Data' : 'Konfirmasi Import Baru'}</div>
                <p className="mt-1 text-[11px] leading-5">
                  {importMode === 'replace'
                    ? 'Semua snapshot aktif untuk ' + importParse.groups.length + ' kelompok dapur/tanggal yang dipaste akan dipindahkan ke arsip soft-delete, lalu diganti dengan snapshot final baru. Event timeline lama tidak dihapus permanen.'
                    : 'Snapshot baru akan dibuat hanya untuk tanggal yang belum memiliki data aktif. Bila ada tanggal yang sudah terisi, seluruh batch ditolak tanpa perubahan.'}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" disabled={importBusy} onClick={() => setImportConfirmOpen(false)} className="mp-import-close rounded-lg px-3 py-2 text-xs">Kembali</button>
                  <button type="button" disabled={importBusy} onClick={() => void confirmMakerImport()} className="mp-import-primary rounded-lg px-3 py-2 text-xs font-bold">
                    {importBusy ? 'Menyimpan...' : importMode === 'replace' ? 'Ya, Replace Semua' : 'Ya, Import Baru'}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
              <button type="button" disabled={importBusy} onClick={() => { setImportOpen(false); setImportConfirmOpen(false) }} className="mp-import-close rounded-lg px-3 py-2 text-xs">Batal</button>
              {!importConfirmOpen && (
                <button type="button" disabled={importBusy || importParse.errors.length > 0 || importParse.groups.length === 0} onClick={() => setImportConfirmOpen(true)} className="mp-import-primary rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-40">
                  Periksa & Konfirmasi
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {historySaveOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="mp-history-save-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !historySaveBusy) {
                event.preventDefault()
                setHistorySaveOpen(false)
                return
              }
              if (event.key !== 'Tab') return
              const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
              )).filter(element => element.offsetParent !== null)
              if (!focusable.length) {
                event.preventDefault()
                event.currentTarget.focus()
                return
              }
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
                event.preventDefault()
                first.focus()
              }
            }}
            className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 p-4 shadow-2xl"
          >
            <h3 id="mp-history-save-title" className="text-sm font-bold">Simpan perubahan pencairan</h3>
            <p className="mt-1 text-xs text-slate-400">Kategori perubahan ditentukan otomatis dari data transaksi yang berubah.</p>
            {historyChangeActive && <p className="mt-2 text-xs text-slate-400">Seluruh transaksi dari snapshot sedang diedit di Form Utama.</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button id="mp-history-save-cancel" type="button" disabled={historySaveBusy} onClick={() => setHistorySaveOpen(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Batal</button>
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
            setHistoryAdditionalKeys([])
                      setKitchenId(restoredKitchenId)
            setTransactions([restored])
            setActiveTransactionId(1)
            setHistoryOpen(false)
            setHistorySaveOpen(false)
            persistWorkspace({ kitchenId: restoredKitchenId, activeTransactionId: 1, transactions: [restored] })
            setHistoryMessage('Seluruh snapshot dimuat ke Form Utama. Revisi nominal, aktifkan Tambahan pada baris terkait, atau tambahkan transaksi baru di Form.')
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
