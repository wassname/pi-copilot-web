/**
 * Minimal GitHub Copilot web_search - reuses pi's github-copilot OAuth
 * Pattern: copy from ttttmr/pi-web-search + nicobailon/pi-web-access openai-search.ts
 * but auth source is github-copilot provider's openai-responses models
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SearchResult { title: string; url: string; snippet: string; }
export interface SearchResponse { answer: string; results: SearchResult[]; }

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: "day"|"week"|"month"|"year";
  domainFilter?: string[];
  signal?: AbortSignal;
}

const COPILOT_PROVIDER = "github-copilot";
const TIMEOUT_MS = 60_000;

function trimTrailingSlash(s: string){ return s.replace(/\/+$/,""); }

function getBaseUrlFromToken(token: string, fallback: string): string {
  const m = token.match(/proxy-ep=([^;]+)/);
  if (!m) return fallback;
  const proxyHost = m[1].toLowerCase();
  // proxy.individual.githubcopilot.com -> api.individual.githubcopilot.com
  if (!proxyHost.startsWith("proxy.")) return fallback;
  return `https://${proxyHost.replace(/^proxy\./,"api.")}`;
}

function resolveCopilotBaseUrl(token: string|undefined, modelBaseUrl: string, authBaseUrl?: string): string {
  if (authBaseUrl && authBaseUrl.trim()) return trimTrailingSlash(authBaseUrl);
  if (token) {
    const derived = getBaseUrlFromToken(token, "");
    if (derived) return derived;
  }
  return trimTrailingSlash(modelBaseUrl);
}

function resolveResponsesUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/responses`;
}

export async function resolveCopilotAuth(ctx: ExtensionContext, signal?: AbortSignal){
  // Try every github-copilot openai-responses model that has credentials
  let models: any[] = [];
  try { models = ctx.modelRegistry.getAll().filter((m:any)=> m.provider===COPILOT_PROVIDER && m.api==="openai-responses"); } catch {}
  // prefer terra > sol > luna > others
  const pref = (id:string)=> id.includes("terra") ? 0 : id.includes("sol") ? 1 : id.includes("luna") ? 2 : 10;
  models.sort((a,b)=> pref(a.id)-pref(b.id) || b.id.localeCompare(a.id, undefined,{numeric:true}));

  for (const model of models){
    try {
      const r: any = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (r.ok && r.apiKey) {
        return { model, apiKey: r.apiKey as string, headers: (r.headers??{}) as Record<string,string>, baseUrl: (r.baseUrl as string|undefined) ?? model.baseUrl };
      }
    } catch {}
  }
  // fallback env
  if (process.env.COPILOT_GITHUB_TOKEN) {
    const m = models[0];
    if (m) return { model:m, apiKey: process.env.COPILOT_GITHUB_TOKEN, headers:{}, baseUrl: m.baseUrl };
  }
  return undefined;
}

export async function isCopilotAvailable(ctx: ExtensionContext): Promise<boolean>{
  const a = await resolveCopilotAuth(ctx);
  return !!a;
}

function buildInstructions(options: SearchOptions): string {
  const lines = ["Search the web and return a concise answer grounded only in the web results.", "Include clickable source citations when possible."];
  if (options.recencyFilter) {
    const labels: Record<string,string> = {day:"past 24 hours",week:"past week",month:"past month",year:"past year"};
    lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
  }
  if (typeof options.numResults==="number" && options.numResults>0) lines.push(`Prefer around ${Math.min(Math.floor(options.numResults),20)} distinct sources.`);
  if (options.domainFilter?.length) {
    const includes = options.domainFilter.filter(d=>!d.startsWith("-"));
    const excludes = options.domainFilter.filter(d=>d.startsWith("-")).map(d=>d.slice(1));
    if (includes.length) lines.push(`Only use sources from: ${includes.join(", ")}.`);
    if (excludes.length) lines.push(`Do not use sources from: ${excludes.join(", ")}.`);
  }
  return lines.join(" ");
}

function normalizeDomain(value: string): string|null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("-")) input=input.slice(1).trim();
  try { const u = input.includes("://") ? new URL(input) : new URL(`https://${input}`); input=u.hostname; } catch { input=input.split("/")[0]?.split(":")[0]??""; }
  input=input.replace(/^\.+|\.+$/g,"");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}
function normalizeDomainFilters(domainFilter: string[]|undefined){
  if (!domainFilter?.length) return null;
  const allowed:string[]=[], blocked:string[]=[];
  for(const raw of domainFilter){
    const d=normalizeDomain(raw); if(!d) continue;
    const target = raw.trim().startsWith("-") ? blocked : allowed;
    if(!target.includes(d)) target.push(d);
  }
  return allowed.length||blocked.length ? { ...(allowed.length?{allowed_domains:allowed.slice(0,100)}:{}), ...(blocked.length?{blocked_domains:block.slice(0,100)}:{} )} : null;
}

// ---- OpenAI responses SSE parsing (copied from pi-web-access/openai-search.ts, simplified) ----
function isWebSearchCall(item:any){ return !!item && typeof item==="object" && item.type==="web_search_call"; }
async function parseOpenAIResponse(res: Response){
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")){
    try {
      const parsed = JSON.parse(trimmed);
      const payload = Array.isArray(parsed) ? {output:parsed} : (parsed && typeof parsed==="object" ? parsed as Record<string,unknown> : {output:[]});
      const output = Array.isArray((payload as any).output) ? (payload as any).output : [];
      return {payload, webSearchCallSeen: output.some(isWebSearchCall)};
    } catch(e){ const m=e instanceof Error?e.message:String(e); throw new Error(`OpenAI API returned invalid JSON: ${m}`); }
  }
  const outputItems: unknown[]=[]; let completed: Record<string,unknown>|null=null; let seen=false;
  for(const line of text.split("\n")){
    if(!line.startsWith("data: ")) continue;
    const data=line.slice(6).trim(); if(!data||data==="[DONE]") continue;
    try{
      const p=JSON.parse(data) as Record<string,unknown>;
      if(typeof p.type==="string" && (p.type as string).startsWith("response.web_search_call")) seen=true;
      if(p.type==="response.output_item.done" && (p as any).item){ outputItems.push((p as any).item); seen ||= isWebSearchCall((p as any).item); }
      if((p.type==="response.done"||p.type==="response.completed") && (p as any).response && typeof (p as any).response==="object") completed=(p as any).response as Record<string,unknown>;
    } catch {}
  }
  if(completed){ const out=Array.isArray((completed as any).output)?(completed as any).output:[]; const payload= out.length? completed: {...completed, output:outputItems}; return {payload, webSearchCallSeen: seen||out.some(isWebSearchCall)}; }
  if(outputItems.length) return {payload:{output:outputItems}, webSearchCallSeen: seen||outputItems.some(isWebSearchCall)};
  throw new Error("OpenAI API returned no parseable response output");
}
function cleanUrl(u:string){ try{ const url=new URL(u); if(url.searchParams.get("utm_source")==="openai") url.searchParams.delete("utm_source"); return url.toString(); } catch{ return u.replace(/[?&]utm_source=openai$/,""); } }
function snippetAround(text:string, start:unknown, end:unknown){
  if(typeof start!=="number"||typeof end!=="number"||!text) return "";
  const s=Math.max(0,start-100), e=Math.min(text.length, end+100);
  const sn=text.slice(s,e).replace(/\[([^\]]*)\]\([^)]*\)/g,"$1").trim();
  return sn.length>300? sn.slice(0,297)+"...":sn;
}
function addResult(results:SearchResult[], seen:Set<string>, url:unknown, title:unknown, snippet=""){
  if(typeof url!=="string"||!url.trim()) return;
  const cu=cleanUrl(url); if(seen.has(cu)) return; seen.add(cu);
  results.push({title: typeof title==="string"&&title.trim()?title:cu, url:cu, snippet});
}
function extractSearchResults(output: unknown[], numResults: number|undefined): SearchResult[]{
  const results:SearchResult[]=[]; const seen=new Set<string>();
  for(const item of output){
    if(!item||typeof item!=="object"||(item as any).type!=="message") continue;
    const content=(item as any).content; if(!Array.isArray(content)) continue;
    for(const part of content){
      if(!part||typeof part!=="object") continue;
      const text=typeof (part as any).text==="string"?(part as any).text:"";
      const ann=(part as any).annotations; if(!Array.isArray(ann)) continue;
      for(const a of ann){
        if(!a||typeof a!=="object"||(a as any).type!=="url_citation") continue;
        addResult(results, seen, (a as any).url, (a as any).title, snippetAround(text,(a as any).start_index,(a as any).end_index));
      }
    }
  }
  for(const item of output){
    if(!item||typeof item!=="object"||(item as any).type!=="web_search_call") continue;
    const v=item as any; const actionSources=v.action&&typeof v.action==="object"?v.action.sources:undefined;
    const groups=[actionSources, v.sources, v.results];
    for(const g of groups){
      if(!Array.isArray(g)) continue;
      for(const s of g){
        if(!s||typeof s!=="object") continue;
        const r=s as Record<string,unknown>;
        addResult(results, seen, r.url??r.source_website_url, r.title??r.caption);
      }
    }
  }
  if(typeof numResults==="number"&&numResults>0) return results.slice(0, Math.min(Math.floor(numResults),20));
  return results;
}
function extractAnswer(output: unknown[]): string{
  const parts:string[]=[];
  for(const item of output){
    if(!item||typeof item!=="object"||(item as any).type!=="message") continue;
    const c=(item as any).content; if(!Array.isArray(c)) continue;
    for(const p of c){
      if(!p||typeof p!=="object") continue;
      const t=(p as any).text; if(typeof t==="string"&&t.trim()) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

export async function searchWithCopilot(query: string, options: SearchOptions={}, ctx: ExtensionContext): Promise<SearchResponse>{
  const auth = await resolveCopilotAuth(ctx, options.signal);
  if(!auth) throw new Error("GitHub Copilot web search unavailable. Run /login github-copilot or set COPILOT_GITHUB_TOKEN");
  const baseUrl = resolveCopilotBaseUrl(auth.apiKey, auth.model.baseUrl, auth.baseUrl);
  const url = resolveResponsesUrl(baseUrl);
  const instructions = buildInstructions(options);
  const domainFilters = normalizeDomainFilters(options.domainFilter);
  const webSearchTool: Record<string,unknown> = {type:"web_search"};
  if(domainFilters) (webSearchTool as any).filters=domainFilters;

  const headers: Record<string,string> = {...(auth.model.headers??{} as any), ...auth.headers, Authorization:`Bearer ${auth.apiKey}`, "Content-Type":"application/json", "OpenAI-Beta":"responses=experimental"};

  const body = {
    model: auth.model.id,
    instructions,
    input: [{role:"user", content:[{type:"input_text", text:query}]}],
    tools: [webSearchTool],
    include: ["web_search_call.action.sources"],
    store:false, stream:true, tool_choice:"required" as const, parallel_tool_calls:true,
  };

  const ac = options.signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), options.signal]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {method:"POST", headers, body: JSON.stringify(body), signal: ac});
  if(!res.ok){
    const t = await res.text();
    throw new Error(`Copilot API error ${res.status}: ${t.slice(0,500)}`);
  }
  const parsed = await parseOpenAIResponse(res);
  const output = Array.isArray((parsed.payload as any).output) ? (parsed.payload as any).output : [];
  if(!parsed.webSearchCallSeen) throw new Error("Copilot web_search returned no web_search_call (model may not support web_search)");
  const answer = extractAnswer(output);
  const results = extractSearchResults(output, options.numResults);
  if(!answer && !results.length) throw new Error("Copilot web_search returned no answer or sources");
  return {answer, results};
}
