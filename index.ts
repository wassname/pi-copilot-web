import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { searchWithCopilot, isCopilotAvailable } from "./copilot-search.ts";

export default function(pi: ExtensionAPI){

  pi.registerTool({
    name: "copilot_search",
    label: "Copilot Web Search",
    description: "Search the web via GitHub Copilot (reuses github-copilot OAuth from /login github-copilot). Uses Copilot's hosted web_search (gpt-5.6 terra/sol). Returns answer + sources. Use for current info, docs, release notes.",
    parameters: Type.Object({
      query: Type.String({description:"Search query"}),
      queries: Type.Optional(Type.Array(Type.String(), {description:"Batch queries (1-5, run sequentially)"})),
      numResults: Type.Optional(Type.Number({description:"Results per query, default 5, max 20"})),
      recencyFilter: Type.Optional(Type.Union([Type.Literal("day"),Type.Literal("week"),Type.Literal("month"),Type.Literal("year")], {description:"Recency"})),
      domainFilter: Type.Optional(Type.Array(Type.String(), {description:"Limit to domains, prefix - to exclude"})),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string,unknown>>>{
      const queries = (params as any).queries?.length ? (params as any).queries as string[] : [(params as any).query as string];
      const clean = queries.map(q=>String(q).trim()).filter(Boolean);
      if (!clean.length) return {content:[{type:"text", text:"Error: query required"}], details:{error:true}};
      if (!(await isCopilotAvailable(ctx))){
        return {content:[{type:"text", text:"GitHub Copilot not logged in. Run /login github-copilot (choose GitHub Copilot) or set COPILOT_GITHUB_TOKEN"}], details:{error:"auth"}};
      }
      onUpdate?.({content:[{type:"text", text:`Searching Copilot for "${clean[0].slice(0,80)}"${clean.length>1?` +${clean.length-1} more`:""}...`}], details:{streaming:true}});
      try {
        const allResults: Array<{query:string, answer:string, results:any[]}> = [];
        const errors: string[]=[];
        for (const q of clean.slice(0,5)){
          try {
            const r = await searchWithCopilot(q, {numResults:(params as any).numResults, recencyFilter:(params as any).recencyFilter, domainFilter:(params as any).domainFilter, signal}, ctx);
            allResults.push({query:q, answer:r.answer, results:r.results});
            onUpdate?.({content:[{type:"text", text: r.answer.slice(0,800)}], details:{streaming:true, query:q}});
          } catch(e){
            errors.push(`${q}: ${e instanceof Error?e.message:String(e)}`);
            allResults.push({query:q, answer:`Error: ${e instanceof Error?e.message:String(e)}`, results:[]});
          }
          if(signal.aborted) break;
        }
        let out="";
        for(const {query, answer, results} of allResults){
          if(clean.length>1) out+=`## Query: "${query}"\n\n`;
          out+= answer + "\n\n";
          if(results.length) out+= `Sources:\n` + results.map((r,i)=> `${i+1}. ${r.title}\n   ${r.url}`).join("\n\n") + "\n\n";
        }
        if(errors.length) out+= `\n---\nErrors: ${errors.join("; ")}`;
        return {content:[{type:"text", text: out.trim() || "No results"}], details:{tool:"copilot_search", queries: clean, allResults, errors}};
      } catch(e){
        const msg = e instanceof Error? e.message: String(e);
        return {content:[{type:"text", text:`Copilot search failed: ${msg}`}], details:{error:msg}};
      }
    },
    renderCall(args, theme){
      const q = (args as any).query || (args as any).queries?.[0] || "…";
      return new Text(`${theme.fg("toolTitle", theme.bold("copilot_search"))} ${theme.fg("accent", String(q).slice(0,80))}`,0,0);
    },
    renderResult(result, opts, theme){
      const text = result.content.filter(p=>p.type==="text").map(p=>p.text).join("\n");
      if(!opts.expanded) {
        const firstLine = text.split("\n")[0]||"";
        return new Text(theme.fg("toolOutput", firstLine.slice(0,200)),0,0);
      }
      const isErr = Boolean((result.details as any)?.error);
      return new Text(theme.fg(isErr?"error":"toolOutput", text),0,0);
    }
  });

  // Also register as web_search alias if no other web_search exists (pi-web-search style fallback)
  // We keep copilot_search primary to avoid colliding with pi-web-access/pi-web-search.

  pi.registerCommand("copilot-search-status", {
    description: "Check GitHub Copilot web_search status",
    async handler(args, ctx){
      const avail = await isCopilotAvailable(ctx);
      if(!avail){ ctx.ui.notify("GitHub Copilot not logged in. Run /login github-copilot","warning"); return; }
      // try to resolve model
      const all = (ctx.modelRegistry as any).getAll?.() ?? [];
      const copilotModels = all.filter((m:any)=> m.provider==="github-copilot");
      ctx.ui.notify(`Copilot OK: ${copilotModels.length} models (e.g. ${copilotModels.slice(0,3).map((m:any)=>m.id).join(", ")}) - try copilot_search`, "info");
    }
  });
}
