# pi-copilot-web

Minimal GitHub Copilot `web_search` for Pi. Reuses the `github-copilot` OAuth token from `pi` (`/login github-copilot`) - no extra API keys.

- `copilot_search({query, queries, numResults, recencyFilter, domainFilter})` -> answer + `Sources:` with citations
- Picks best `github-copilot/openai-responses` model (`gpt-5.6-terra` > `sol` > `luna` > others) that has credentials
- Base URL derived from token `proxy-ep=proxy.individual.githubcopilot.com` -> `https://api.individual.githubcopilot.com` (enterprise supported via stored `baseUrl`)
- Request: `POST {baseUrl}/responses` with `tools:[{type:"web_search"}]`, `tool_choice:"required"`, stream SSE, parse `url_citation` + `web_search_call.action.sources` (same parser as `nicobailon/pi-web-access`)

## Install

```bash
# local
cp -r pi-copilot-web ~/.pi/agent/extensions/
# or via pi install
pi install /home/code/pi-copilot-web
```

Login once:

```
# inside pi
/login github-copilot
```

Free plan (`free_engaged_oss_quota`) works - tested with 2k completions/50 chats limits, `gpt-5.6-terra` succeeds.

## Use

```
copilot_search({"query":"github copilot free plan limits 2025"})
copilot_search({"queries":["typescript 5.7 release","rust 1.82 release"],"domainFilter":["github.com"]})
copilot_search({"query":"openai gpt-5 release","recencyFilter":"month","numResults":8})
```

Also: `/copilot-search-status` to check auth.

## How it mirrors pi-web-access/pi-codex-search/ttttmr

- Auth: `ctx.modelRegistry.getApiKeyAndHeaders(model)` loop over `github-copilot` models (like `ttttmr/src/api.ts:getAuth` + `Leechael/src/pi-auth.ts:resolveCodexAccountId`)
- Headers: merges `model.headers` (Copilot's `User-Agent: GitHubCopilotChat/0.35.0` etc) + `Authorization: Bearer <token>`
- SSE parsing: copied from `pi-web-access/openai-search.ts:parseOpenAIResponse/extractAnswer/extractSearchResults`
- Tool shape: same as `Leechael/pi-codex-search` but single `copilot_search` instead of `codex_search`

## Free tier notes

Free `free_engaged_oss_quota` token has `availableModelIds` including `gpt-5.6-terra/luna/sol` etc. Each `copilot_search` counts as one chat request (of 50/month). Avoid batching >5 queries at once.

