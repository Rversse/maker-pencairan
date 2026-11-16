import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const allowedOrigins = new Set(["https://rversse.github.io","http://localhost:5173","http://localhost:5174","http://127.0.0.1:5173","http://127.0.0.1:5174"]);
const headers = (request: Request): HeadersInit => {
  const origin = request.headers.get("origin");
  return {"Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://rversse.github.io","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin","Content-Type":"application/json","Cache-Control":"no-store"};
};
const respond = (request: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:headers(request)});
const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => { let binary=""; for (const byte of bytes) binary+=String.fromCharCode(byte); return btoa(binary).replaceAll("+","-").replaceAll("/","_").replaceAll("=",""); };
const sha256 = async (value: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
function splitProductTypes(value: string | null) { return value ? value.split(",").map((item)=>item.trim()).filter(Boolean) : []; }
Deno.serve(async (request: Request) => {
  if (request.method==="OPTIONS") return new Response("ok",{headers:headers(request)});
  if (request.method!=="POST") return respond(request,{error:"Method not allowed"},405);
  const auth=request.headers.get("authorization")??"";
  const token=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if (token.length<40||token.length>128) return respond(request,{error:"Unauthorized"},401);
  const url=Deno.env.get("SUPABASE_URL"), serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url||!serviceKey) return respond(request,{error:"Service unavailable"},503);
  const db=createClient(url,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
  try {
    const tokenHash=await sha256(token);
    const {data:session,error:sessionError}=await db.from("maker_sessions").select("id,maker_user_id").eq("token_hash",tokenHash).is("revoked_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
    if (sessionError) return respond(request,{error:"Session service unavailable"},503);
    if (!session) return respond(request,{error:"Unauthorized"},401);
    const {data:profile,error:profileError}=await db.from("maker_profiles").select("user_id,role,is_active").eq("user_id",session.maker_user_id).maybeSingle();
    if (profileError) return respond(request,{error:"Profile service unavailable"},503);
    if (!profile?.is_active) return respond(request,{error:"Forbidden"},403);
    let kitchenIds: string[]|null=null;
    if (profile.role==="accountant") {
      const {data:assignments,error}=await db.from("maker_assignments").select("kitchen_id").eq("maker_user_id",profile.user_id);
      if(error) return respond(request,{error:"Unable to load assignments"},500);
      kitchenIds=(assignments??[]).map((row)=>row.kitchen_id);
      if(kitchenIds.length===0) return respond(request,{ok:true,kitchens:[],account_rules:[],operational_accounts:[],operational_rules:[]});
    } else if(profile.role!=="admin") return respond(request,{error:"Forbidden"},403);
    let kitchensQuery=db.from("kitchens").select("id,name,is_active,include_disbursement").eq("is_active",true).order("name");
    if(kitchenIds) kitchensQuery=kitchensQuery.in("id",kitchenIds);
    const {data:kitchens,error:kitchensError}=await kitchensQuery;
    if(kitchensError) return respond(request,{error:"Unable to load kitchens"},500);
    const allowedKitchenIds=(kitchens??[]).map((row)=>row.id);
    if(allowedKitchenIds.length===0) {
      if(profile.role==="accountant") return respond(request,{error:"Assigned kitchen is inactive or unavailable"},403);
      return respond(request,{ok:true,kitchens:[],account_rules:[],operational_accounts:[],operational_rules:[]});
    }
    const accountRuleSelect = "kitchen_id, account_id, flow_type, accounts(id,name,bank,account_number,supplier_id,account_category)";
    const [rulesResult,suppliersResult,operationalRulesResult,operationalAccountsResult]=await Promise.all([
      db.from("kitchen_account_rules").select(accountRuleSelect).in("kitchen_id",allowedKitchenIds),
      db.from("income_suppliers").select("id,business_name,owner_name,product_type"),
      db.from("kitchen_operational_account_rules").select("id,kitchen_id,rule_type,owner_name,bank,account_number,is_active,mapping_status,target_role").eq("is_active",true).in("kitchen_id",allowedKitchenIds).order("kitchen_id").order("rule_type").order("owner_name"),
      db.from("accounts").select("id,name,bank,account_number,supplier_id,account_category").eq("account_category","holding").order("name")
    ]);
    if(rulesResult.error||suppliersResult.error||operationalRulesResult.error||operationalAccountsResult.error) return respond(request,{error:"Unable to load master data"},500);
    const supplierMap=new Map((suppliersResult.data??[]).map((supplier)=>[supplier.id,supplier]));
    const resolvedRules=(rulesResult.data??[]).map((rule)=>{
      const account=rule.accounts as {id:string;name:string;bank:string|null;account_number:string|null;supplier_id:string|null;account_category:string|null}|null;
      const supplier=account?.supplier_id?supplierMap.get(account.supplier_id)??null:null;
      return {kitchen_id:rule.kitchen_id,account_id:rule.account_id,flow_type:rule.flow_type,accounts:account,supplier:supplier?{id:supplier.id,business_name:supplier.business_name,owner_name:supplier.owner_name,product_type:supplier.product_type,product_types:splitProductTypes(supplier.product_type)}:null};
    });
    const opRules=operationalRulesResult.data??[];
    const allowedHoldingAccounts=profile.role==="admin"?(operationalAccountsResult.data??[]):(operationalAccountsResult.data??[]).filter((account)=>
      opRules.some((rule)=>rule.bank===account.bank&&rule.account_number===account.account_number)
    );
    const {error:touchError}=await db.from("maker_sessions").update({last_seen_at:new Date().toISOString()}).eq("id",session.id);
    if (touchError) return respond(request,{error:"Session service unavailable"},503);
    return respond(request,{ok:true,kitchens:kitchens??[],account_rules:resolvedRules,operational_accounts:allowedHoldingAccounts,operational_rules:opRules});
  } catch { return respond(request,{error:"Request could not be processed"},400); }
});