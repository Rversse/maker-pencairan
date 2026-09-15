import { supabase } from '../lib/supabase'

export type MakerMode = 'rab' | 'gas' | 'operasional' | 'lain_lain'

export type MakerKitchen = {
  id: string
  name: string
  is_active: boolean
  include_disbursement: boolean
}

export type MakerAccount = {
  id: string
  name: string
  bank: string
  account_number: string | null
  supplier_id: string | null
  account_category: string | null
}

export type MakerSupplierInfo = {
  id: string
  business_name: string
  owner_name: string | null
  product_type: string | null
  product_types: string[]
}

export type MakerAccountRule = {
  kitchen_id: string
  account_id: string
  flow_type: 'income' | 'expense' | 'neutral'
  accounts: MakerAccount | null
  supplier: MakerSupplierInfo | null
}

export type MakerMasterData = {
  ok: boolean
  kitchens: MakerKitchen[]
  account_rules: MakerAccountRule[]
  operational_accounts: MakerAccount[]
}

export async function getMakerMasterData(): Promise<MakerMasterData> {
  const { data, error } = await supabase.functions.invoke('maker-master-data')

  if (error) {
    throw error
  }

  return data as MakerMasterData
}
