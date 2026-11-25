import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import policy from "./policy_rules.json";

// Demo-only identity: one secret maps to one synthetic employee.
type AppEnv = { DB: D1Database; MCP_API_KEY: string; RESEND_API_KEY: string; FINANCE_EMAIL: string; SENDER_EMAIL: string; DEMO_EMPLOYEE_ID: string };
const text = z.string().trim().min(1).max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(s + "T00:00:00Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s; }, "Invalid calendar date");
const category = z.enum(["transportation", "client_meal", "office_supplies"]);
const receipt = z.object({ merchant: text, receipt_number: text.nullish(), transaction_date: date, amount_sar: z.number().positive().max(100000).refine(n => Math.abs(n*100-Math.round(n*100)) < 0.000001, "Use at most two decimal places"), currency: z.literal("SAR") }).strict();
const claim = receipt.extend({ expense_category: category, business_purpose: text, client_name: text.nullish(), project_name: text.nullish(), destination: text.nullish(), attendees: z.array(text).max(30).optional(), employee_confirmed: z.literal(true) }).strict();
const reason = z.enum(["POTENTIAL_DUPLICATE", "TRANSACTION_LIMIT_EXCEEDED", "MONTHLY_LIMIT_EXCEEDED"]);
const escalation = claim.extend({ reason_code: reason }).strict();
const filters = z.object({ claim_id: text.optional(), expense_category: category.optional(), status: z.enum(["PENDING_APPROVAL", "APPROVED", "PAID", "REJECTED", "CANCELLED"]).optional(), from_date: date.optional(), to_date: date.optional() }).strict();
type Receipt = z.infer<typeof receipt>; type Claim = z.infer<typeof claim>;
const normalize = (s: string) => s.trim().toLowerCase();
const minor = (r: Receipt) => Math.round(r.amount_sar * 100);
const key = (r: Receipt) => r.receipt_number ? [normalize(r.merchant), normalize(r.receipt_number), r.transaction_date, minor(r), r.currency].join("|") : null;
const today = () => new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Riyadh", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const resultSchema = z.object({ status: z.enum(["SUCCESS", "ERROR"]), code: z.string().min(1), message: z.string().min(1), data: z.record(z.string(), z.unknown()).optional() });
function out(status: "SUCCESS"|"ERROR", code: string, message: string, data?: Record<string,unknown>) { const value = resultSchema.parse({status,code,message,data}); return {content:[{type:"text" as const,text:JSON.stringify(value)}], ...(status === "ERROR" ? {isError:true} : {})}; }
const ok = (code: string, message: string, data?: Record<string,unknown>) => out("SUCCESS",code,message,data);
const err = (code: string, message: string, data?: Record<string,unknown>) => out("ERROR",code,message,data);
function validPolicy(r: Receipt) { const now = today(); return now >= policy.effective_from && now <= policy.valid_until && r.transaction_date >= policy.effective_from && r.transaction_date <= now && r.transaction_date <= policy.valid_until; }
function missing(c: Claim) { const m: string[]=[]; for(const field of policy.categories[c.expense_category].required) { if(field === "destination" && !c.destination) m.push(field); else if(field === "client_or_project" && !c.client_name && !c.project_name) m.push("client_name or project_name"); else if(field === "client_name" && !c.client_name) m.push(field); else if(field === "attendees" && (!c.attendees || new Set(c.attendees.map(normalize)).size < 2)) m.push("at least two distinct attendees"); else if(!["destination","client_or_project","client_name","attendees"].includes(field)) throw Error("Unsupported policy requirement"); } return m; }
const support = (c: Claim) => JSON.stringify({ ...(c.destination ? {destination:c.destination}:{}), ...(c.attendees ? {attendees:c.attendees}:{}) });
// Same exact identifier, or same merchant/date/amount/currency with ambiguous or different reference: conservative review.
const matchSql = `(r.transaction_key = ? OR (lower(trim(r.merchant)) = ? AND r.transaction_date = ? AND r.amount_minor_units = ? AND r.currency = ?))`;
const matchArgs = (r: Receipt) => [key(r),normalize(r.merchant),r.transaction_date,minor(r),r.currency] as const;
type Match = {receipt_id:string; transaction_key:string|null; claim_id:string|null; claim_employee:string|null; claim_status:string|null; escalation_id:string|null; escalation_employee:string|null; notification_status:string|null};
async function lookup(env:AppEnv,r:Receipt) { const x=await env.DB.prepare(`SELECT r.receipt_id,r.transaction_key,c.claim_id,c.employee_id AS claim_employee,c.status AS claim_status,e.escalation_id,e.employee_id AS escalation_employee,e.notification_status FROM receipts r LEFT JOIN expense_claims c ON c.receipt_id=r.receipt_id LEFT JOIN escalations e ON e.receipt_id=r.receipt_id AND e.review_status='OPEN' WHERE ${matchSql}`).bind(...matchArgs(r)).all<Match>(); return x.results; }
function classify(rows:Match[],r:Receipt,employee:string) { const exact=rows.filter(x=>key(r)!==null && x.transaction_key===key(r)); const claimed=exact.find(x=>x.claim_id); if(claimed) return {code:"ALREADY_CLAIMED",data:claimed.claim_employee===employee?{claim_id:claimed.claim_id,claim_status:claimed.claim_status}:undefined}; const open=exact.find(x=>x.escalation_id); if(open) return {code:"UNDER_REVIEW",data:open.escalation_employee===employee?{escalation_id:open.escalation_id,notification_status:open.notification_status}:undefined}; if(exact.length) return {code:"PREVIOUSLY_RECORDED",data:undefined}; if(rows.length) return {code:"POTENTIAL_DUPLICATE",data:undefined}; return {code:"NO_MATCH",data:undefined}; }
const sumSql = `SELECT COALESCE(SUM(r.amount_minor_units),0) AS spent FROM expense_claims c JOIN receipts r ON r.receipt_id=c.receipt_id WHERE c.employee_id=? AND c.expense_category=? AND substr(r.transaction_date,1,7)=? AND c.status IN ('PENDING_APPROVAL','APPROVED','PAID')`;
async function spent(env:AppEnv,c:Claim) { const row=await env.DB.prepare(sumSql).bind(env.DEMO_EMPLOYEE_ID,c.expense_category,c.transaction_date.slice(0,7)).first<{spent:number}>(); if(!row || !Number.isSafeInteger(row.spent)) throw Error("Invalid spend result"); return row.spent; }
function financial(c:Claim, previous:number) {const p=policy.categories[c.expense_category]; if(minor(c)>p.transaction_limit_minor) return "TRANSACTION_LIMIT_EXCEEDED"; if(previous+minor(c)>p.monthly_limit_minor) return "MONTHLY_LIMIT_EXCEEDED"; return null;}
function insertReceipt(env:AppEnv,r:Receipt,rid:string) { return env.DB.prepare(`INSERT INTO receipts(receipt_id,merchant,receipt_number,transaction_date,amount_minor_units,currency,transaction_key) VALUES(?,?,?,?,?,?,?)`).bind(rid,r.merchant,r.receipt_number??null,r.transaction_date,minor(r),r.currency,key(r)); }
function guard(fn:()=>Promise<ReturnType<typeof out>>) { return fn().catch(()=>err("SERVICE_ERROR","Operation could not be verified. Do not assume success or retry a write blindly; check receipt status first.")); }
function createServer(env:AppEnv) {
 const server=new McpServer({name:"ExpenseFlow MCP",version:"1.0.0"});
 server.registerTool("get_claims",{description:"Read only: retrieve the authenticated demo employee's claims. Never accepts employee ID. Optional filters use ISO dates. No match is not an error.",inputSchema:filters},async f=>guard(async()=>{
  if(f.from_date && f.to_date && f.from_date>f.to_date) return err("INVALID_INPUT","Start date must precede end date.");
  const where=["employee_id = ?"], args: string[]=[env.DEMO_EMPLOYEE_ID];
  for(const [col,val] of [["claim_id",f.claim_id],["expense_category",f.expense_category],["status",f.status]] as const) if(val){where.push(`${col} = ?`);args.push(val);}
  if(f.from_date){where.push("transaction_date >= ?");args.push(f.from_date);} if(f.to_date){where.push("transaction_date <= ?");args.push(f.to_date);}
  const rows=(await env.DB.prepare(`SELECT claim_id,merchant,transaction_date,amount_sar,expense_category,status FROM demo_claims WHERE ${where.join(" AND ")} ORDER BY transaction_date DESC LIMIT 51`).bind(...args).all()).results;
  const checked=z.array(z.object({claim_id:z.string(),merchant:z.string(),transaction_date:date,amount_sar:z.number(),expense_category:category,status:z.string()})).parse(rows);
  return ok(checked.length?"CLAIMS_FOUND":"NO_RECORDS",checked.length?"Claims retrieved.":"No matching claims for the current employee.",{claims:checked.slice(0,50),truncated:checked.length>50});
 }));
 server.registerTool("check_duplicate",{description:"Read only: check receipt metadata against previous claims and open Finance reviews. Do not invent receipt numbers. NO_MATCH is the only result permitting ordinary submission, subject to all other checks.",inputSchema:receipt},async r=>guard(async()=>{if(r.transaction_date>today())return err("INVALID_INPUT","Receipt date is in the future.");const x=classify(await lookup(env,r),r,env.DEMO_EMPLOYEE_ID);return ok(x.code,"Receipt verification completed.",x.data);}));
 server.registerTool("create_claim",{description:"Write: create exactly one pending approval claim after employee explicitly confirms the displayed receipt and business declaration. Never fabricate confirmation. Backend rechecks policy, spending and receipt history. Requires all relevant supporting details. Does not approve or pay.",inputSchema:claim},async c=>guard(async()=>{
  if(!validPolicy(c))return err("POLICY_OR_DATE_INVALID","Receipt date or policy effective period is invalid. No claim created.");
  const m=missing(c);if(m.length)return err("MISSING_FIELD","Required business information missing.",{fields:m});
  const x=classify(await lookup(env,c),c,env.DEMO_EMPLOYEE_ID);if(x.code!=="NO_MATCH")return err(x.code,"Receipt is not eligible for a new ordinary claim.",x.data);
  const previous=await spent(env,c), violation=financial(c,previous), p=policy.categories[c.expense_category];
  if(violation)return err(violation,"Financial limit exceeded; no claim created.",{previous_sar:previous/100,projected_sar:(previous+minor(c))/100,monthly_limit_sar:p.monthly_limit_minor/100,transaction_limit_sar:p.transaction_limit_minor/100});
  const rid=id("R"), cid=id("CL"), timestamp=new Date().toISOString();
  // In one atomic D1 batch: enforce receipt matching and spending again at write time.
  // A failed guard produces NULL for the NOT NULL primary key, rolling back both inserts.
  await env.DB.batch([insertReceipt(env,c,rid),env.DB.prepare(`INSERT INTO expense_claims(claim_id,receipt_id,employee_id,expense_category,business_purpose,client_name,project_name,supporting_details,employee_declaration,employee_confirmed_at,monthly_spend_at_submission_minor_units,policy_version,status) VALUES(CASE WHEN NOT EXISTS(SELECT 1 FROM receipts r WHERE r.receipt_id<>? AND ${matchSql}) AND (${sumSql.replace(" AS spent","")})+?<=? THEN ? ELSE NULL END,?,?,?,?,?,?,?,1,?,(${sumSql.replace(" AS spent","")})+?,?,'PENDING_APPROVAL')`).bind(rid,...matchArgs(c),env.DEMO_EMPLOYEE_ID,c.expense_category,c.transaction_date.slice(0,7),minor(c),p.monthly_limit_minor,cid,rid,env.DEMO_EMPLOYEE_ID,c.expense_category,c.business_purpose,c.client_name??null,c.project_name??null,support(c),timestamp,env.DEMO_EMPLOYEE_ID,c.expense_category,c.transaction_date.slice(0,7),minor(c),policy.version)]);
  return ok("CLAIM_CREATED","Claim registered; pending Finance approval.",{claim_id:cid,receipt_id:rid,claim_status:"PENDING_APPROVAL",amount_sar:c.amount_sar,policy_version:policy.version});
 }));
 server.registerTool("escalate_case",{description:"Write: after explicit employee confirmation, register one Finance review case for a verified potential duplicate or permitted financial limit exception. Sends a real email to configured demo mailbox. Does not create a reimbursement claim.",inputSchema:escalation},async c=>guard(async()=>{
  if(!validPolicy(c))return err("POLICY_OR_DATE_INVALID","Receipt date or policy effective period invalid.");const m=missing(c);if(m.length)return err("MISSING_FIELD","Required information missing.",{fields:m});
  const rows=await lookup(env,c), x=classify(rows,c,env.DEMO_EMPLOYEE_ID);
  const existing=rows.find(r=>r.escalation_id && r.escalation_employee===env.DEMO_EMPLOYEE_ID && (key(c)===null || r.transaction_key===null || r.transaction_key===key(c)));
  if(existing)return ok("EXISTING_ESCALATION","A matching open review already exists; no new email was sent.",{escalation_id:existing.escalation_id,notification_status:existing.notification_status});
  if(x.code==="ALREADY_CLAIMED"||x.code==="UNDER_REVIEW"||x.code==="PREVIOUSLY_RECORDED")return err(x.code,"No new case created for this already recorded exact receipt.",x.data);
  const actual=x.code==="POTENTIAL_DUPLICATE"?"POTENTIAL_DUPLICATE":financial(c,await spent(env,c));
  if(!actual||actual!==c.reason_code||!policy.exceptions_allowed.includes(actual))return err("INVALID_ESCALATION_REASON","Backend did not verify the requested exception.");
  const rid=id("R"), eid=id("ESC");
  await env.DB.batch([insertReceipt(env,c,rid),env.DB.prepare(`INSERT INTO escalations(escalation_id,receipt_id,employee_id,expense_category,business_purpose,client_name,project_name,supporting_details,reason_code,description,review_status,notification_status,policy_version) VALUES(CASE WHEN NOT EXISTS(SELECT 1 FROM escalations e JOIN receipts r ON r.receipt_id=e.receipt_id WHERE e.employee_id=? AND e.review_status='OPEN' AND ${matchSql} AND (r.transaction_key IS NULL OR ? IS NULL OR r.transaction_key=?)) AND NOT EXISTS(SELECT 1 FROM expense_claims c JOIN receipts r ON r.receipt_id=c.receipt_id WHERE r.transaction_key=?) THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?,'OPEN','PENDING',?)`).bind(env.DEMO_EMPLOYEE_ID,...matchArgs(c),key(c),key(c),key(c),eid,rid,env.DEMO_EMPLOYEE_ID,c.expense_category,c.business_purpose,c.client_name??null,c.project_name??null,support(c),actual,`Verified exception: ${actual}`,policy.version)]);
  let notification:"ACCEPTED"|"FAILED"|"UNKNOWN"="UNKNOWN", emailId:string|null=null;
  try {if(!env.RESEND_API_KEY||!env.FINANCE_EMAIL||!env.SENDER_EMAIL){notification="FAILED";}else{const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":eid},body:JSON.stringify({from:env.SENDER_EMAIL,to:[env.FINANCE_EMAIL],subject:`[${eid}] ExpenseFlow Finance review`,text:`Demo Finance review\nCase: ${eid}\nEmployee: ${env.DEMO_EMPLOYEE_ID}\nMerchant: ${c.merchant}\nDate: ${c.transaction_date}\nAmount: SAR ${c.amount_sar}\nCategory: ${c.expense_category}\nReason: ${actual}\nBusiness purpose: ${c.business_purpose}\nClient: ${c.client_name??"Not provided"}\nProject: ${c.project_name??"Not provided"}\nNo reimbursement claim was created.`}),signal:AbortSignal.timeout(10000)});if(response.ok){const parsed=z.object({id:z.string().min(1)}).safeParse(await response.json());if(parsed.success){emailId=parsed.data.id;notification="ACCEPTED";}}else if(response.status>=400&&response.status<500&&response.status!==408&&response.status!==409&&response.status!==429)notification="FAILED";}}
  catch {notification="UNKNOWN";}
  try {await env.DB.prepare("UPDATE escalations SET notification_status=?,email_message_id=?,notification_updated_at=? WHERE escalation_id=?").bind(notification,emailId,new Date().toISOString(),eid).run();}catch{return ok("ESCALATION_CREATED_NOTIFICATION_UNVERIFIED","Case recorded; notification status could not be persisted. Do not resend automatically.",{escalation_id:eid,review_status:"OPEN",notification_status:"UNKNOWN"});}
  return ok("ESCALATION_CREATED",notification==="ACCEPTED"?"Case recorded and email accepted by provider; delivery not yet verified.":"Case recorded; email not confirmed. Do not create another case.",{escalation_id:eid,review_status:"OPEN",notification_status:notification,email_message_id:emailId});
 }));
 return server;
}
export default { async fetch(request:Request,env:AppEnv,ctx:ExecutionContext) {
  if(new URL(request.url).pathname!=="/mcp")return new Response("Not found",{status:404});
  if(!env.MCP_API_KEY||request.headers.get("X-API-Key")!==env.MCP_API_KEY)return new Response("Unauthorized",{status:401});
  if(!env.DB||!env.DEMO_EMPLOYEE_ID)return new Response("Configuration unavailable",{status:503});
  return createMcpHandler(()=>createServer(env))(request,env,ctx);
}} satisfies ExportedHandler<AppEnv>;
