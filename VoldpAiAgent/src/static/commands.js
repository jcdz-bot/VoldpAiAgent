// ── Slash commands ──────────────────────────────────────────────────────────
// Built-in commands intercepted before send(). Each command runs locally
// (no round-trip to the agent) and shows feedback via toast or local message.

const COMMANDS=[
  // noEcho:true = action-only commands that don't produce a chat response.
  // Commands without noEcho get a user message echoed to the chat (#840).
  {name:'help',      desc:t('cmd_help'),             fn:cmdHelp},
  {name:'clear',     desc:t('cmd_clear'),         fn:cmdClear,     noEcho:true},
  {name:'compress',  desc:t('cmd_compress'),       fn:cmdCompress, arg:'[focus topic]', noEcho:true},
  {name:'compact',   desc:t('cmd_compact_alias'),       fn:cmdCompact, noEcho:true},
  {name:'model',     desc:t('cmd_model'),  fn:cmdModel,     arg:'model_name', subArgs:'models', noEcho:true},
  {name:'workspace', desc:t('cmd_workspace'),            fn:cmdWorkspace, arg:'name',           noEcho:true},
  {name:'terminal',  desc:t('cmd_terminal'),             fn:cmdTerminal,                        noEcho:true},
  {name:'new',       desc:t('cmd_new'),            fn:cmdNew,       noEcho:true},
  {name:'usage',     desc:t('cmd_usage'),   fn:cmdUsage,     noEcho:true},
  {name:'theme',     desc:t('cmd_theme'), fn:cmdTheme, arg:'name',  noEcho:true},
  {name:'personality', desc:t('cmd_personality'), fn:cmdPersonality, arg:'name', subArgs:'personalities'},
  {name:'skills',    desc:t('cmd_skills'),   fn:cmdSkills,   arg:'query'},
  {name:'use',       desc:t('cmd_use'),      fn:cmdUse,      arg:'skill-name', subArgs:'skills', noEcho:true},
  {name:'stop',      desc:t('cmd_stop'),     fn:cmdStop,      noEcho:true},
  {name:'goal',      desc:t('cmd_goal'),     fn:cmdGoal,      arg:'[status|pause|resume|clear|text]', subArgs:['status','pause','resume','clear']},
  {name:'queue',     desc:t('cmd_queue'),    fn:cmdQueue,     arg:'message', noEcho:true},
  {name:'interrupt', desc:t('cmd_interrupt'), fn:cmdInterrupt, arg:'message', noEcho:true},
  {name:'steer',     desc:t('cmd_steer'),    fn:cmdSteer,     arg:'message', noEcho:true},
  {name:'title',     desc:t('cmd_title'),    fn:cmdTitle,    arg:'[title]'},
  {name:'retry',     desc:t('cmd_retry'),    fn:cmdRetry,     noEcho:true},
  {name:'undo',      desc:t('cmd_undo'),     fn:cmdUndo,      noEcho:true},
  {name:'btw',       desc:t('cmd_btw'),      fn:cmdBtw,       arg:'question', noEcho:true},
  {name:'background',desc:t('cmd_background'),fn:cmdBackground,arg:'prompt',  noEcho:true},
  {name:'status',    desc:t('cmd_status'),   fn:cmdStatus},
  {name:'voice',     desc:t('cmd_voice'),    fn:cmdVoice,     noEcho:true},
  {name:'reasoning', desc:t('cmd_reasoning'), fn:cmdReasoning, arg:'show|hide|none|minimal|low|medium|high|xhigh', subArgs:['show','hide','none','minimal','low','medium','high','xhigh'], noEcho:true},
  {name:'yolo', desc:t('cmd_yolo'), fn:cmdYolo, noEcho:true},
  {name:'branch', desc:t('cmd_branch'), fn:cmdBranch, arg:'[name]', noEcho:true},
  {name:'teleport', desc:t('cmd_teleport'), fn:cmdTeleport, noEcho:true},
  // Claude Code mode CLI commands
  {name:'commit',       desc:t('cmd_commit'),        fn:cmdCommit,       noEcho:true},
  {name:'commit-push-pr',desc:t('cmd_commit_push_pr'),fn:cmdCommitPushPr, noEcho:true},
  {name:'review',       desc:t('cmd_review'),       fn:cmdReview,       noEcho:true},
  {name:'bughunter',    desc:t('cmd_bughunter'),    fn:cmdBughunter,    noEcho:true},
  {name:'security-review',desc:t('cmd_security_review'),fn:cmdSecurityReview, noEcho:true},
  {name:'init',         desc:t('cmd_init'),         fn:cmdInit,         noEcho:true},
  {name:'generate-agent', desc:t('cmd_generate_agent'), fn:cmdGenerateAgent, arg:'description', noEcho:true},
];

const SLASH_SUBARG_SOURCES={
  model:{desc:t('cmd_model'), subArgs:'models'},
  personality:{desc:t('cmd_personality'), subArgs:'personalities'},
};

// 对来自 /api/commands 的已知 agent 命令提供本地化描述
const AGENT_COMMAND_I18N={
  'reload-mcp':'cmd_reload_mcp',
  'reload_mcp':'cmd_reload_mcp',
  'reload-skills':'cmd_reload_skills',
  'reload_skills':'cmd_reload_skills',
  'codex-runtime':'cmd_codex_runtime',
  'codex_runtime':'cmd_codex_runtime',
};

function parseCommand(text){
  if(!text.startsWith('/'))return null;
  const parts=text.slice(1).split(/\s+/);
  const name=parts[0].toLowerCase();
  const args=parts.slice(1).join(' ').trim();
  return {name,args};
}

function executeCommand(text){
  const parsed=parseCommand(text);
  if(!parsed)return null;
  const cmd=COMMANDS.find(c=>c.name===parsed.name);
  if(!cmd)return null;
  // A handler may return `false` to opt out of interception — e.g. /reasoning
  // with an effort level falls through so the agent's own handler sees it,
  // preserving the pre-existing pass-through behaviour for that subcommand.
  if(cmd.fn(parsed.args)===false)return null;
  // Return noEcho flag so send() knows whether to echo the command as a user message (#840).
  return {noEcho:!!cmd.noEcho};
}

function getMatchingCommands(prefix){
  const q=prefix.toLowerCase();
  const matches=COMMANDS.filter(c=>c.name.startsWith(q)).map(c=>({...c,source:'builtin'}));
  const seen=new Set(matches.map(c=>c.name));
  const reserved=_getReservedSlashCommandSlugs();
  for(const [name, spec] of Object.entries(SLASH_SUBARG_SOURCES)){
    if(!name.startsWith(q)||seen.has(name))continue;
    matches.push({
      name,
      desc:spec.desc,
      arg:'name',
      source:'subarg-command',
    });
    seen.add(name);
  }
  // Include agent/plugin commands from /api/commands metadata
  for(const cmd of (_agentCommandCache||[])){
    const name=String(cmd&&cmd.name||'').toLowerCase();
    if(!name.startsWith(q)||seen.has(name))continue;
    if(cmd.cli_only)continue;
    const i18nKey=AGENT_COMMAND_I18N[name];
    const desc=i18nKey?t(i18nKey):String(cmd&&cmd.description||'').trim()||'Agent command';
    matches.push({
      name,
      desc,
      source:cmd.category==='Plugin'?'plugin':'agent',
    });
    seen.add(name);
  }
  if(_agentCommandCacheReady){
    for(const bundle of _bundleCommandCache){
      if(!bundle.name.startsWith(q)||seen.has(bundle.name)||reserved.has(bundle.name))continue;
      matches.push(bundle);
      seen.add(bundle.name);
    }
  }
  // 技能型斜杠命令已移除 — 直接输入 /<skill-name> 不会激活技能，改用 /use <skill-name>
  return matches;
}

let _forcedSkillDirectivePending=null;
let _slashModelCache=null;
let _slashModelCachePromise=null;
let _slashPersonalityCache=null;
let _slashPersonalityCachePromise=null;
let _bundleCommandCache=[];
let _bundleCommandLoadPromise=null;
let _bundleCommandCacheReady=false;
let _slashSkillCache=null;
let _slashSkillCachePromise=null;
let _agentCommandCache=null;
let _agentCommandCachePromise=null;

// Invalidate the /api/models slash-suggestion cache. Called by panels.js
// after a provider is added or removed so the next /model autocomplete
// rebuilds from a fresh /api/models response (#1539). Returning a function
// rather than letting callers poke the module-local lets/promises directly
// keeps the cache shape encapsulated to this module.
function _invalidateSlashModelCache(){
  _slashModelCache=null;
  _slashModelCachePromise=null;
}
// Expose on window when available. Guarded by typeof so the module is
// importable in headless test contexts (vm.runInContext) that don't
// define a window global — see tests/test_cli_only_slash_commands.py.
if(typeof window!=='undefined'){
  window._invalidateSlashModelCache=_invalidateSlashModelCache;
  window.invalidateSlashSkillCaches=invalidateSlashSkillCaches;
}

function _normalizeSlashSubArg(value){
  return String(value||'').trim();
}

function _getSlashModelSubArgsFromDom(){
  const sel=$('modelSelect');
  if(!sel) return [];
  const values=[];
  for(const opt of Array.from(sel.options||[])){
    const value=_normalizeSlashSubArg(opt.value||opt.textContent||'');
    if(value) values.push(value);
  }
  return Array.from(new Set(values)).sort((a,b)=>a.localeCompare(b));
}

async function _loadSlashModelSubArgs(force=false){
  const domValues=_getSlashModelSubArgsFromDom();
  if(domValues.length&&!force){
    _slashModelCache=domValues;
    return domValues;
  }
  if(_slashModelCache&&!force) return _slashModelCache;
  if(_slashModelCachePromise&&!force) return _slashModelCachePromise;
  _slashModelCachePromise=(async()=>{
    try{
      const data=await api('/api/models');
      const values=[];
      for(const group of (data&&data.groups)||[]){
        for(const model of (group&&group.models)||[]){
          const id=_normalizeSlashSubArg(model&&model.id);
          if(id) values.push(id);
        }
        // Include extra_models (the catalog tail that doesn't render as
        // <option> entries when the picker is capped) so /model autocomplete
        // covers the full catalog. The trimming is purely a dropdown
        // scannability concern — the slash command exists precisely so
        // power users can reach any model by typing its name. #1567.
        for(const model of (group&&group.extra_models)||[]){
          const id=_normalizeSlashSubArg(model&&model.id);
          if(id) values.push(id);
        }
      }
      const deduped=Array.from(new Set(values)).sort((a,b)=>a.localeCompare(b));
      _slashModelCache=deduped;
      return deduped;
    }catch(_){
      _slashModelCache=domValues;
      return domValues;
    }finally{
      _slashModelCachePromise=null;
    }
  })();
  return _slashModelCachePromise;
}

async function _loadSlashPersonalitySubArgs(force=false){
  if(_slashPersonalityCache&&!force) return _slashPersonalityCache;
  if(_slashPersonalityCachePromise&&!force) return _slashPersonalityCachePromise;
  _slashPersonalityCachePromise=(async()=>{
    try{
      const data=await api('/api/personalities');
      const values=['none'];
      for(const p of (data&&data.personalities)||[]){
        const name=_normalizeSlashSubArg(p&&p.name);
        if(name) values.push(name);
      }
      const deduped=Array.from(new Set(values)).sort((a,b)=>a.localeCompare(b));
      _slashPersonalityCache=deduped;
      return deduped;
    }catch(_){
      _slashPersonalityCache=['none'];
      return _slashPersonalityCache;
    }finally{
      _slashPersonalityCachePromise=null;
    }
  })();
  return _slashPersonalityCachePromise;
}

async function _loadSlashSkillSubArgs(force=false){
  if(_slashSkillCache&&!force) return _slashSkillCache;
  if(_slashSkillCachePromise&&!force) return _slashSkillCachePromise;
  _slashSkillCachePromise=(async()=>{
    try{
      const data=await api('/api/skills');
      const values=[];
      for(const skill of (data&&data.skills)||[]){
        const name=_normalizeSlashSubArg(skill&&skill.name);
        if(name) values.push(name);
      }
      const deduped=Array.from(new Set(values)).sort((a,b)=>a.localeCompare(b));
      _slashSkillCache=deduped;
      return deduped;
    }catch(_){
      _slashSkillCache=null;
      return [];
    }finally{
      _slashSkillCachePromise=null;
    }
  })();
  return _slashSkillCachePromise;
}

function invalidateSlashSkillCaches(){
  _slashSkillCache=null;
  _slashSkillCachePromise=null;
  _skillCommandCache=[];
  _skillCommandCacheReady=false;
  _skillCommandLoadPromise=null;
}

function _getSlashSubArgOptions(spec){
  if(Array.isArray(spec)) return Promise.resolve(spec.slice());
  if(spec==='models') return _loadSlashModelSubArgs();
  if(spec==='personalities') return _loadSlashPersonalitySubArgs();
  if(spec==='skills') return _loadSlashSkillSubArgs();
  return Promise.resolve([]);
}

let _agentCommandCacheReady=false;
async function loadAgentCommandMetadata(force=false){
  if(_agentCommandCacheReady&&!force)return _agentCommandCache||[];
  if(_agentCommandCachePromise&&!force)return _agentCommandCachePromise;
  _agentCommandCachePromise=(async()=>{
    try{
      const data=await api('/api/commands');
      _agentCommandCache=Array.isArray(data&&data.commands)?data.commands:[];
    }catch(_){
      _agentCommandCache=[];
    }finally{
      _agentCommandCacheReady=true;
      _agentCommandCachePromise=null;
    }
    return _agentCommandCache;
  })();
  return _agentCommandCachePromise;
}

async function getAgentCommandMetadata(name){
  const needle=String(name||'').trim().toLowerCase();
  if(!needle) return null;
  const commands=await loadAgentCommandMetadata();
  return commands.find(cmd=>{
    if(String(cmd&&cmd.name||'').toLowerCase()===needle) return true;
    return Array.isArray(cmd&&cmd.aliases)&&cmd.aliases.some(a=>String(a||'').toLowerCase()===needle);
  })||null;
}

function cliOnlyCommandResponse(cmdName, meta){
  const name=String((meta&&meta.name)||cmdName||'').trim();
  const desc=String((meta&&meta.description)||'').trim();
  const detail=desc?`\n\n${desc}`:'';
  let extra='';
  if(name==='browser'){
    extra='\n\nBrowser tools in WebUI must be configured server-side with the agent/browser environment. Once configured, ask the model to use browser tools directly; `/browser` itself only works in `hermes chat`.';
  }
  return `\`/${name}\` is a Hermes CLI-only command and cannot run inside the WebUI.${detail}${extra}`;
}

async function executeAgentCommand(text,_meta){
  return _runAgentCommandTransport(text,_meta);
}

async function executeAgentPluginCommand(text,_meta){
  return _runAgentCommandTransport(text,_meta);
}

async function _runAgentCommandTransport(text,_meta){
  const command=String(text||'').trim();
  if(!command) throw new Error('command is required');
  const data=await api('/api/commands/exec',{
    method:'POST',
    body:JSON.stringify({command})
  });
  const output=String(data&&data.output||'(no output)');
  // /reload-mcp 执行后刷新前端 MCP 工具清单，让用户立即看到新发现的工具
  const base=command.replace(/^\//,'').split(/\s+/)[0].toLowerCase();
  if(base==='reload-mcp'||base==='reload_mcp'){
    try{
      if(typeof loadMcpTools==='function') loadMcpTools();
      if(typeof loadMcpServers==='function') loadMcpServers();
    }catch(_){}
  }
  // /reload-skills 执行后刷新前端技能缓存，让用户立即看到新加载的技能
  if(base==='reload-skills'||base==='reload_skills'){
    try{
      if(typeof window!=='undefined'&&typeof window.invalidateSlashSkillCaches==='function') window.invalidateSlashSkillCaches();
      if(typeof loadSkills==='function') loadSkills();
    }catch(_){}
  }
  return output;
}

async function resolveBundleCommand(text,_meta){
  const command=String(text||'').trim();
  if(!command) throw new Error('command is required');
  return api('/api/commands/bundles/resolve',{
    method:'POST',
    body:JSON.stringify({command})
  });
}

function _parseSlashAutocomplete(text){
  if(!text.startsWith('/')||text.indexOf('\n')!==-1) return null;
  const raw=text.slice(1);
  const hasSpace=/\s/.test(raw);
  const parts=raw.split(/\s+/);
  const cmdName=(parts[0]||'').toLowerCase();
  const command=COMMANDS.find(c=>c.name===cmdName);
  const subArgSource=(command&&command.subArgs)?command:SLASH_SUBARG_SOURCES[cmdName];
  if(!hasSpace||!subArgSource){
    return {kind:'commands', query:raw};
  }
  const argText=raw.slice(cmdName.length).replace(/^\s+/,'');
  return {kind:'subargs', command:{name:cmdName, desc:subArgSource.desc, subArgs:subArgSource.subArgs}, query:argText.toLowerCase(), rawQuery:argText};
}

async function getSlashAutocompleteMatches(text){
  const parsed=_parseSlashAutocomplete(text);
  if(!parsed) return [];
  if(parsed.kind==='commands') return getMatchingCommands(parsed.query);
  const options=await _getSlashSubArgOptions(parsed.command.subArgs);
  return options
    .filter(opt=>String(opt).toLowerCase().startsWith(parsed.query))
    .map(opt=>({
      name:parsed.command.name,
      value:String(opt),
      desc:parsed.command.desc,
      source:'subarg',
      parent:parsed.command.name,
    }));
}

function _findComposerPathToken(text,cursor){
  const value=String(text||'');
  const rawCursor=Number(cursor);
  const pos=Number.isFinite(rawCursor)?Math.max(0,Math.min(rawCursor,value.length)):value.length;
  let start=pos;
  while(start>0&&!/\s/.test(value.charAt(start-1))) start-=1;
  let end=pos;
  while(end<value.length&&!/\s/.test(value.charAt(end))) end+=1;
  const prefix=value.slice(start,pos);
  if(!prefix.startsWith('~/')) return null;
  return {start,end,prefix};
}

async function getComposerPathAutocompleteMatches(text,cursor){
  const token=_findComposerPathToken(text,cursor);
  if(!token||typeof api!=='function') return [];
  const qs=new URLSearchParams({prefix:token.prefix}).toString();
  const data=await api(`/api/workspaces/suggest?${qs}`);
  const needle=token.prefix.toLowerCase();
  return ((data&&data.suggestions)||[])
    .map(path=>String(path||''))
    .filter(path=>path&&path.toLowerCase().startsWith(needle))
    .map(path=>({
      name:path,
      value:path,
      desc:'Workspace path',
      source:'path',
      tokenStart:token.start,
      tokenEnd:token.end,
    }));
}

function _compressionAnchorMessageKey(m){
  if(!m||!m.role||m.role==='tool') return null;
  let content='';
  try{
    content=typeof msgContent==='function' ? String(msgContent(m)||'') : String(m.content||'');
  }catch(_){
    content=String(m.content||'');
  }
  const norm=content.replace(/\s+/g,' ').trim().slice(0,160);
  const ts=m._ts||m.timestamp||null;
  const attachments=Array.isArray(m.attachments)?m.attachments.length:0;
  if(!norm && !attachments && !ts) return null;
  return {role:String(m.role||''), ts, text:norm, attachments};
}

// ── Command handlers ────────────────────────────────────────────────────────

function cmdHelp(){
  const lines=COMMANDS.map(c=>{
    const usage=c.arg ? (String(c.arg).startsWith('[') ? ` ${c.arg}` : ` <${c.arg}>`) : '';
    return `  /${c.name}${usage} — ${c.desc}`;
  });
  const msg={role:'assistant',content:t('available_commands')+'\n'+lines.join('\n')};
  S.messages.push(msg);
  renderMessages();
  showToast(t('type_slash'));
}

function cmdClear(){
  if(!S.session)return;
  S.messages=[];S.toolCalls=[];
  clearLiveToolCards();
  if(typeof clearCompressionUi==='function') clearCompressionUi();
  renderMessages();
  $('emptyState').style.display='';
  showToast(t('conversation_cleared'));
}

// Find the best matching model <option> for a slash-command query.
// Returns an exact id/label match if present, otherwise the shortest option
// whose value or label contains the query. Preferring the shortest match keeps
// a specific query like "mimo-v2.5" from being shadowed by a longer variant
// such as "mimo-v2.5-pro". See issue #3368.
//
// #3368 follow-up: a COMPLETE versioned query (ends in a digit, e.g.
// "mimo-v2.5") must not match a variant/tier suffix (e.g. "mimo-v2.5-pro") via
// substring — that silently upgrades the user to a different (paid) tier they
// did not ask for. Such a candidate is only accepted when the query also
// matches the option's visible label as a *whole word*, or when the extra text
// continues a version number. Otherwise the longer tier is rejected here and
// surfaced as a suggestion instead.
function _looksLikeVersionedModel(query){
  // e.g. "mimo-v2.5", "gpt-5.5", "claude-opus-4.6" — ends in a digit.
  return /\d$/.test(String(query||''));
}
// Build the full /model candidate set from the catalog groups returned by
// /api/models: featured `models` PLUS the truncated `extra_models` tail. Large
// provider catalogs (e.g. a Nous Portal subscription with >25 models) only
// render a "featured" subset as <option> entries — the rest live in
// extra_models and never become <select> options (see _build_nous_featured_set
// in api/config.py). The slash command exists precisely so power users can reach
// ANY catalog model by name, the same way the CLI/autocomplete can, so /model
// must resolve against this full list — not just the rendered picker options.
// Falls back to the live <select> options when the catalog fetch failed.
// Each entry mimics the <option> shape (value + textContent) so it can be passed
// straight to _bestModelMatch / _nearestModelSuggestion. Also returns a
// value->provider_id map so an extras-only winner can be injected with the right
// provider. (#3368)
function _buildModelCandidates(sel,groups){
  const options=[];
  const providerMap={};
  if(Array.isArray(groups)&&groups.length){
    for(const g of groups){
      const pid=(g&&g.provider_id)||'';
      const push=m=>{
        if(!m||!m.id) return;
        options.push({value:m.id,textContent:m.label||m.id});
        if(pid&&!(m.id in providerMap)) providerMap[m.id]=pid;
      };
      for(const m of (Array.isArray(g.models)?g.models:[])) push(m);
      for(const m of (Array.isArray(g.extra_models)?g.extra_models:[])) push(m);
    }
  }
  if(!options.length&&sel){
    for(const o of Array.from(sel.options||[])) options.push({value:o.value,textContent:o.textContent});
  }
  return {options,providerMap};
}
function _bestModelMatch(options,query){
  let best=null;
  const versioned=_looksLikeVersionedModel(query);
  for(const opt of options){
    const value=opt.value.toLowerCase();
    const text=opt.textContent.toLowerCase();
    if(value===query||text===query) return opt.value;
    if(value.includes(query)||text.includes(query)){
      if(versioned){
        // Reject a longer variant where the query is immediately followed by a
        // tier/variant suffix ("-pro", "-flash", " pro", etc.) rather than a
        // version continuation. Tested on the option value (canonical id).
        const idx=value.indexOf(query);
        const after=idx>=0?value.charAt(idx+query.length):'';
        // after === '' → query is a suffix of value (exact-ish, allow)
        // after is a digit or '.' → version continuation (allow, e.g. v2 → v2.5)
        // after is '-' or other → variant/tier suffix (reject)
        if(after && after!=='.' && !/\d/.test(after)) continue;
      }
      if(best===null||opt.value.length<best.length) best=opt.value;
    }
  }
  return best;
}

// When a versioned query has no clean match, find the closest catalog option
// (a longer variant that the query is a prefix of) to offer as a suggestion,
// e.g. "mimo-v2.5" → "mimo-v2.5-pro". Returns the suggested option value, or ''.
function _nearestModelSuggestion(options,query){
  let suggestion='';
  for(const opt of options){
    const value=opt.value.toLowerCase();
    if(value.includes(query)){
      const cand=opt.value;
      if(!suggestion||cand.length<suggestion.length) suggestion=cand;
    }
  }
  return suggestion;
}

async function cmdModel(args){
  if(!args){showToast(t('model_usage'));return;}
  const sel=$('modelSelect');
  if(!sel)return;
  let q=args.toLowerCase();
  // Fetch /api/models once: it carries both the alias map AND the full catalog
  // groups (featured `models` + truncated `extra_models`). Resolve aliases, then
  // build the full candidate set so /model can reach ANY catalog model by name —
  // not just the subset rendered as <option> entries. On large provider catalogs
  // (e.g. a Nous Portal subscription) the picker only renders ~25 "featured"
  // models; the rest live in extra_models and are absent from sel.options. The
  // CLI resolves against the full catalog, so /model must too. (#3368)
  let modelsData=null;
  try {
    modelsData=await api('/api/models');
    if(modelsData){
      const aliases=modelsData.aliases||{};
      for(const [alias,modelId] of Object.entries(aliases)){
        if(alias.toLowerCase()===q){
          q=modelId.toLowerCase(); // resolve alias to real model id e.g. "deepseek/deepseek-v4-flash"
          break;
        }
      }
    }
  } catch(_){/* non-critical, fall through to fuzzy match */}
  const {options:candidates,providerMap}=_buildModelCandidates(sel,modelsData&&modelsData.groups);
  // First: try exact match within active provider's optgroup.
  // Use _findModelInDropdown (ui.js) which supports preferredProviderId.
  const preferred=(S&&S.session&&S.session.model_provider)||window._activeProvider||null;
  let match=(typeof _findModelInDropdown==='function')?_findModelInDropdown(q,sel,preferred):null;
  // Fallback: fuzzy match across the FULL catalog (featured + extras), so an
  // exact bare model living in the extras tail (e.g. "mimo-v2.5" alongside the
  // featured "mimo-v2.5-pro") still wins — exact/shortest-match in _bestModelMatch.
  if(!match){
    match=_bestModelMatch(candidates,q);
  }
  // Fallback: if q has provider/ prefix (e.g. "deepseek/deepseek-v4-flash"),
  // try the bare model name (which is how options appear for the active provider)
  if(!match && q.includes('/')){
    const bare=q.slice(q.lastIndexOf('/')+1);
    match=_bestModelMatch(candidates,bare);
    // #3368: a versioned slash-qualified query whose only near catalog entry is a
    // rejected tier variant (e.g. "xiaomi/mimo-v2.5" when only "xiaomi/mimo-v2.5-pro"
    // exists) must NOT silently direct-update to the invalid name — fall through to
    // the no-match/"did you mean?" toast instead. The cross-provider direct-update
    // path below is only for genuinely off-catalog providers with no near variant.
    const nearSuggestion=_nearestModelSuggestion(candidates,q)||_nearestModelSuggestion(candidates,bare);
    const versionedNoSnap=_looksLikeVersionedModel(bare)&&nearSuggestion;
    // Cross-provider fallback: if still no match, the model is from a
    // different provider not in the dropdown. Call /api/session/update directly.
    if(!match && !versionedNoSnap && S&&S.session&&S.session.session_id){
      const provider=q.slice(0,q.indexOf('/'));
      try{
        await api('/api/session/update',{
          method:'POST',
          body:JSON.stringify({
            session_id:S.session.session_id,
            model:q,
            model_provider:provider,
          }),
        });
        S.session.model=q;
        S.session.model_provider=provider;
        if(typeof syncTopbar==='function') syncTopbar();
        showToast(t('switched_to')+q);
        return;
      }catch(_){/* fall through to "no model match" */}
    }
  }
  if(!match){
    // #3368: when a complete versioned name (e.g. "mimo-v2.5") doesn't match
    // because only a longer tier variant exists ("mimo-v2.5-pro"), don't snap
    // to it — say no-match and suggest the near variant so the user can opt in.
    // no_model_match already ends with an opening quote, so close it with args+".
    let msg=t('no_model_match')+`${args}"`;
    const suggestion=_nearestModelSuggestion(candidates,q);
    if(suggestion){
      // model_did_you_mean is a placeholder template; t() invokes it with the
      // suggestion as its arg. (Calling t() without the arg renders "undefined".)
      msg+=t('model_did_you_mean', suggestion);
    }
    showToast(msg);
    return;
  }
  // The winning model may live in the extras tail (not a rendered <option>), so
  // a bare `sel.value=match` would silently no-op. Inject the option with its
  // provider before selecting so onchange() persists the correct model+provider
  // end-to-end. _ensureModelOptionInDropdown reuses the existing option when one
  // is already rendered. (#3368)
  const hasOption=Array.from(sel.options||[]).some(o=>o.value===match);
  if(!hasOption && typeof _ensureModelOptionInDropdown==='function'){
    _ensureModelOptionInDropdown(match,sel,providerMap[match]||null);
  }else{
    sel.value=match;
  }
  await sel.onchange();
  showToast(t('switched_to')+match);
}

async function cmdWorkspace(args){
  if(!args){showToast(t('workspace_usage'));return;}
  try{
    const data=await api('/api/workspaces');
    const q=args.toLowerCase();
    const ws=(data.workspaces||[]).find(w=>
      (w.name||'').toLowerCase().includes(q)||w.path.toLowerCase().includes(q)
    );
    if(!ws){showToast(t('no_workspace_match')+`"${args}"`);return;}
    if(typeof switchToWorkspace==='function') await switchToWorkspace(ws.path, ws.name||ws.path);
    else showToast(t('switched_workspace')+(ws.name||ws.path));
  }catch(e){showToast(t('workspace_switch_failed')+e.message);}
}

async function cmdTerminal(){
  let data=null;
  try{
    data=await api('/api/workspaces');
    if(typeof syncTerminalBackendState==='function') syncTerminalBackendState(data);
    if(data&&data.terminal_remote_backend){
      const msg=typeof _terminalRemoteBackendUnsupportedMessage==='function'
        ? _terminalRemoteBackendUnsupportedMessage()
        : 'Embedded terminal is only supported for local terminal backends.';
      showToast(msg,3200,'warning');
      if(typeof syncTerminalButton==='function') syncTerminalButton();
      return;
    }
  }catch(_){}
  if(!S.session&&typeof newSession==='function'){
    if(!S._profileSwitchWorkspace&&!S._profileDefaultWorkspace){
      const first=(data&&data.workspaces||[])[0];
      S._profileSwitchWorkspace=(data&&data.last)||(first&&first.path)||null;
    }
    await newSession();
    if(typeof renderSessionList==='function') await renderSessionList();
  }
  if(!S.session||!S.session.workspace){
    showToast(t('terminal_no_workspace_title'),2600,'warning');
    if(typeof syncTerminalButton==='function') syncTerminalButton();
    return;
  }
  if(typeof toggleComposerTerminal==='function') await toggleComposerTerminal(true);
}

async function cmdNew(){
  if(typeof clearCompressionUi==='function') clearCompressionUi();
  await newSession();
  await renderSessionList();
  $('msg').focus();
  showToast(t('new_session'));
}

function _manualCompressionVisibleMessages(){
  return (S.messages||[]).filter(m=>{
    if(!m||!m.role||m.role==='tool') return false;
    if(m.role==='assistant'){
      const hasTc=Array.isArray(m.tool_calls)&&m.tool_calls.length>0;
      const hasTu=Array.isArray(m.content)&&m.content.some(p=>p&&p.type==='tool_use');
      if(hasTc||hasTu|| (typeof _messageHasReasoningPayload==='function' && _messageHasReasoningPayload(m))) return true;
    }
    return typeof msgContent==='function' ? !!msgContent(m) || !!m.attachments?.length : !!m.content || !!m.attachments?.length;
  });
}

function _manualCompressionSleep(ms){
  return new Promise(resolve=>setTimeout(resolve, ms));
}

async function _pollManualCompressionResult(sid){
  let delay=700;
  while(true){
    const data=await api(`/api/session/compress/status?session_id=${encodeURIComponent(sid)}`);
    if(data&&data.status==='done') return data;
    if(data&&data.status==='error'){
      const err=new Error(data.error||'Compression failed');
      err.status=data.error_status||400;
      throw err;
    }
    if(data&&data.status==='idle') throw new Error('Compression job is no longer available');
    await _manualCompressionSleep(delay);
    delay=Math.min(2000, delay+300);
  }
}

async function _applyManualCompressionResult(data, focusTopic, visibleCount, commandText){
  if(data&&data.session){
    const currentSid=S.session&&S.session.session_id;
    if(data.session.session_id&&data.session.session_id!==currentSid){
      await loadSession(data.session.session_id);
    }else{
      S.session=data.session;
      S.messages=data.session.messages||[];
      S.toolCalls=data.session.tool_calls||[];
      // 同步分页状态，避免旧会话的 _messagesTruncated/_oldestIdx 遗留到新会话
      if(typeof _messagesTruncated!=='undefined') _messagesTruncated=!!(S.session&&S.session._messages_truncated);
      if(typeof _oldestIdx!=='undefined') _oldestIdx=(S.session&&S.session._messages_offset)||0;
      clearLiveToolCards();
      try{localStorage.setItem('voldp-ai-agent-session',S.session.session_id);}catch(_){}
      if(typeof _setActiveSessionUrl==='function') _setActiveSessionUrl(S.session.session_id);
      syncTopbar();
      renderMessages();
      await renderSessionList();
      updateQueueBadge(S.session.session_id);
    }
  }
  // 手动压缩完成后重置当前上下文用量、累加压缩次数并刷新指示器
  if(S.session){
    // 后端 Rg_ZhiXingYaSuo 已在 DB 自增并返回新值（N+1），仅当后端未返回 session 时才本地 +1
    if(!data||!data.session){
      S.session.compression_count=(Number(S.session.compression_count)||0)+1;
    }
    S.session._lastCompressedAt=Math.floor(Date.now()/1000);
    if(!S.lastUsage) S.lastUsage={};
    S.lastUsage.last_prompt_tokens=0;
    S.lastUsage.input_tokens=0;
    S.lastUsage.output_tokens=0;
    S.lastUsage.compression_count=S.session.compression_count;
    S.session.last_usage=S.lastUsage;
    if(typeof _syncCtxIndicator==='function') _syncCtxIndicator(S.lastUsage);
  }
  const summary=data&&data.summary;
  if(typeof setCompressionUi==='function'&&S.session){
    const referenceMsg=(S.messages||[]).find(m=>typeof _isContextCompactionMessage==='function'&&_isContextCompactionMessage(m));
    const messageRef=referenceMsg?msgContent(referenceMsg)||String(referenceMsg.content||''):'';
    const summaryRef=summary&&typeof summary.reference_message==='string' ? String(summary.reference_message||'').trim() : '';
    // Prefer the persisted compaction handoff when it already exists in session state.
    // The short summary fallback is only for environments where that message is unavailable.
    const referenceText=messageRef || summaryRef;
    const effectiveFocus=(data&&data.focus_topic)||focusTopic||'';
    setCompressionUi({
      sessionId:S.session.session_id,
      phase:'done',
      focusTopic:effectiveFocus,
      commandText:effectiveFocus?`/compress ${effectiveFocus}`:(commandText||'/compress'),
      beforeCount:visibleCount,
      summary:summary||null,
      referenceText,
      anchorVisibleIdx: data?.session?.compression_anchor_visible_idx,
      anchorMessageKey: data?.session?.compression_anchor_message_key||null,
    });
  }
  if(typeof setComposerStatus==='function') setComposerStatus('');
  renderMessages();
  if(typeof _setCompressionSessionLock==='function') _setCompressionSessionLock(null);
}

async function resumeManualCompressionForSession(sid){
  if(!sid) return;
  try{
    const status=await api(`/api/session/compress/status?session_id=${encodeURIComponent(sid)}`);
    if(!status||status.status!=='running') return;
    const visibleMessages=_manualCompressionVisibleMessages();
    const visibleCount=visibleMessages.length;
    const anchorMessageKey=_compressionAnchorMessageKey(visibleMessages[visibleMessages.length-1]||null);
    if(typeof setBusy==='function') setBusy(true);
    if(typeof setComposerStatus==='function') setComposerStatus(t('compressing'));
    if(typeof setCompressionUi==='function'){
      setCompressionUi({
        sessionId:sid,
        phase:'running',
        focusTopic:status.focus_topic||'',
        commandText:status.focus_topic?`/compress ${status.focus_topic}`:'/compress',
        beforeCount:visibleCount,
        anchorVisibleIdx:Math.max(0, visibleCount-1),
        anchorMessageKey,
      });
    }
    renderMessages();
    const done=await _pollManualCompressionResult(sid);
    if(!S.session||S.session.session_id!==sid) return;
    await _applyManualCompressionResult(done, status.focus_topic||'', visibleCount, status.focus_topic?`/compress ${status.focus_topic}`:'/compress');
  }catch(e){
    // No active compression job or transient server error — not a real failure.
    // 404: route missed or session gone; 5xx: backend exception during status check.
    if(e&&(!e.status||e.status===404||e.status>=500)) return;
    if(S.session&&S.session.session_id===sid&&typeof setCompressionUi==='function'){
      const visibleMessages=_manualCompressionVisibleMessages();
      setCompressionUi({
        sessionId:sid,
        phase:'error',
        focusTopic:'',
        commandText:'/compress',
        beforeCount:visibleMessages.length,
        errorText:`Compression failed: ${e.message}`,
        anchorVisibleIdx:Math.max(0, visibleMessages.length-1),
        anchorMessageKey:null,
      });
      renderMessages();
    }
  }finally{
    if(S.session&&S.session.session_id===sid){
      if(typeof _setCompressionSessionLock==='function') _setCompressionSessionLock(null);
      if(typeof setBusy==='function') setBusy(false);
      if(typeof setComposerStatus==='function') setComposerStatus('');
    }
  }
}

async function _runManualCompression(focusTopic){
  if(!S.session){showToast(t('no_active_session'));return;}
  let visibleCount=0;
  try{
    const sid=S.session.session_id;
    // Preflight: verify the viewed session still exists before compressing.
    // This avoids a confusing "not found" toast when the UI is stale.
    try{
      const live=await api(`/api/session?session_id=${encodeURIComponent(sid)}`);
      if(!live||!live.session||live.session.session_id!==sid){
        throw new Error('session no longer available');
      }
      S.session=live.session;
      S.messages=live.session.messages||[];
      S.toolCalls=live.session.tool_calls||[];
      if(typeof _messagesTruncated!=='undefined') _messagesTruncated=false;
    }catch(preflightErr){
      if(typeof clearCompressionUi==='function') clearCompressionUi();
      if(typeof _setCompressionSessionLock==='function') _setCompressionSessionLock(null);
      if(typeof setBusy==='function') setBusy(false);
      if(typeof setComposerStatus==='function') setComposerStatus('');
      renderMessages();
      showToast('Compression failed: '+(preflightErr.message||'session no longer available'));
      return;
    }
    if(typeof setBusy==='function') setBusy(true);
    const body={session_id:sid};
    if(focusTopic) body.focus_topic=focusTopic;
    const visibleMessages=_manualCompressionVisibleMessages();
    visibleCount=visibleMessages.length;
    const anchorVisibleIdx=Math.max(0, visibleCount - 1);
    const anchorMessageKey=_compressionAnchorMessageKey(visibleMessages[visibleMessages.length-1]||null);
    const commandText=focusTopic?`/compress ${focusTopic}`:'/compress';
    if(typeof setCompressionUi==='function'){
      setCompressionUi({
        sessionId:S.session.session_id,
        phase:'running',
        focusTopic:focusTopic||'',
        commandText,
        beforeCount:visibleCount,
        anchorVisibleIdx,
        anchorMessageKey,
      });
    }
    if(typeof setComposerStatus==='function') setComposerStatus(t('compressing'));
    renderMessages();
    const started=await api('/api/session/compress/start',{method:'POST',body:JSON.stringify(body)});
    if(started&&started.status==='error'){
      const err=new Error(started.error||'Compression failed');
      err.status=started.error_status||400;
      throw err;
    }
    const data=(started&&started.status==='done')?started:await _pollManualCompressionResult(sid);
    await _applyManualCompressionResult(data, focusTopic, visibleCount, commandText);
  }catch(e){
    if(typeof setCompressionUi==='function'){
      const currentSid=S.session&&S.session.session_id;
      setCompressionUi({
        sessionId:currentSid||'',
        phase:'error',
        focusTopic:(focusTopic||'').trim(),
        commandText:focusTopic?`/compress ${focusTopic}`:'/compress',
        beforeCount:(S.messages||[]).filter(m=>m&&m.role&&m.role!=='tool').length,
        errorText:`Compression failed: ${e.message}`,
        anchorVisibleIdx: Math.max(0, visibleCount - 1),
        anchorMessageKey:null,
      });
    }
    if(typeof _setCompressionSessionLock==='function') _setCompressionSessionLock(null);
    if(typeof setBusy==='function') setBusy(false);
    if(typeof setComposerStatus==='function') setComposerStatus('');
    renderMessages();
    showToast('Compression failed: '+e.message);
    return;
  }
  if(typeof setBusy==='function') setBusy(false);
}

async function cmdCompress(args){
  await _runManualCompression((args||'').trim());
}

async function cmdCompact(args){
  await _runManualCompression((args||'').trim());
}

async function cmdUsage(){
  const next=!window._showTokenUsage;
  window._showTokenUsage=next;
  try{
    await api('/api/settings',{method:'POST',body:JSON.stringify({show_token_usage:next})});
  }catch(e){}
  // Update the settings checkbox if the panel is open
  const cb=$('settingsShowTokenUsage');
  if(cb) cb.checked=next;
  renderMessages();
  showToast(next?t('token_usage_on'):t('token_usage_off'));
}

async function cmdTheme(args){
  const themes=['system','dark','light'];
  const skins=(_SKINS||[]).map(s=>(s.value||s.name).toLowerCase());
  const legacyThemes=Object.keys(_LEGACY_THEME_MAP||{});
  const val=(args||'').toLowerCase().trim();
  // Check if it's a theme
  if(themes.includes(val)||legacyThemes.includes(val)){
    const appearance=_normalizeAppearance(
      val,
      legacyThemes.includes(val)?null:localStorage.getItem('hermes-skin')
    );
    localStorage.setItem('hermes-theme',appearance.theme);
    localStorage.setItem('hermes-skin',appearance.skin);
    _applyTheme(appearance.theme);
    _applySkin(appearance.skin);
    try{await api('/api/settings',{method:'POST',body:JSON.stringify({theme:appearance.theme,skin:appearance.skin})});}catch(e){}
    const sel=$('settingsTheme');
    if(sel)sel.value=appearance.theme;
    const skinSel=$('settingsSkin');
    if(skinSel)skinSel.value=appearance.skin;
    if(typeof _syncThemePicker==='function') _syncThemePicker(appearance.theme);
    if(typeof _syncSkinPicker==='function') _syncSkinPicker(appearance.skin);
    showToast(t('theme_set')+appearance.theme+(legacyThemes.includes(val)?` + ${appearance.skin}`:''));
    return;
  }
  // Check if it's a skin
  if(skins.includes(val)){
    const appearance=_normalizeAppearance(localStorage.getItem('hermes-theme'),val);
    localStorage.setItem('hermes-theme',appearance.theme);
    localStorage.setItem('hermes-skin',appearance.skin);
    _applyTheme(appearance.theme);
    _applySkin(appearance.skin);
    try{await api('/api/settings',{method:'POST',body:JSON.stringify({theme:appearance.theme,skin:appearance.skin})});}catch(e){}
    const sel=$('settingsSkin');
    if(sel)sel.value=appearance.skin;
    const themeSel=$('settingsTheme');
    if(themeSel)themeSel.value=appearance.theme;
    if(typeof _syncThemePicker==='function') _syncThemePicker(appearance.theme);
    if(typeof _syncSkinPicker==='function') _syncSkinPicker(appearance.skin);
    showToast(t('theme_set')+appearance.skin);
    return;
  }
  showToast(t('theme_usage')+themes.join('|')+' | '+skins.join('|')+' | legacy:'+legacyThemes.join('|'));
}

async function cmdSkills(args){
  try{
    const data = await api('/api/skills');
    let skills = data.skills || [];
    if(args){
      const q = args.toLowerCase();
      skills = skills.filter(s =>
        (s.name||'').toLowerCase().includes(q) ||
        (s.description||'').toLowerCase().includes(q) ||
        (s.category||'').toLowerCase().includes(q)
      );
    }
    if(!skills.length){
      const msg = {role:'assistant', content: args ? `No skills matching "${args}".` : 'No skills found.'};
      S.messages.push(msg); renderMessages(); return;
    }
    // Group by category
    const byCategory = {};
    skills.forEach(s => {
      const cat = s.category || 'General';
      if(!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(s);
    });
    const lines = [];
    for(const [cat, items] of Object.entries(byCategory).sort()){
      lines.push(`**${cat}**`);
      items.forEach(s => {
        const desc = s.description ? ` — ${s.description.slice(0,80)}${s.description.length>80?'...':''}` : '';
        lines.push(`  \`${s.name}\`${desc}`);
      });
      lines.push('');
    }
    const header = args
      ? `Skills matching "${args}" (${skills.length}):\n\n`
      : `Available skills (${skills.length}):\n\n`;
    S.messages.push({role:'assistant', content: header + lines.join('\n')});
    renderMessages();
    showToast(t('type_slash'));
  }catch(e){
    showToast('Failed to load skills: '+e.message);
  }
}

async function cmdUse(args){
  if(!args){
    S.messages.push({role:'assistant',content:'Usage: `/use <skill-name>` — forces the agent to consult that skill before its next response.'});
    renderMessages();
    return;
  }
  let resolve;
  const pending = {sessionId:S.session&&S.session.session_id||null,promise:null};
  pending.promise = new Promise(r => { resolve = r; });
  _forcedSkillDirectivePending = pending;
  const isCurrentSession = () => !pending.sessionId || (S.session&&S.session.session_id)===pending.sessionId;
  try{
    const data = await api('/api/skills');
    const skills = data.skills || [];
    const match = skills.find(s => (s.name||'').toLowerCase() === args.toLowerCase());
    if(!match){
      resolve(null);
      if(_forcedSkillDirectivePending===pending)_forcedSkillDirectivePending = null;
      if(isCurrentSession()){
        const msg = {role:'assistant', content:`No skill named \`${args}\`. Use \`/skills\` to see available skills.`};
        S.messages.push(msg); renderMessages();
      }
      return;
    }
    const detail = await api(`/api/skills/content?name=${encodeURIComponent(match.name)}`);
    const skillContent = detail&&typeof detail.content==='string' ? detail.content.trim() : '';
    if(!skillContent) throw new Error(`Skill \`${match.name}\` has no readable content.`);
    const directive = `[USER OVERRIDE] You MUST follow the skill '${match.name}' content provided below before responding to the next message.`;
    resolve({name:match.name,directive,content:skillContent});
    if(isCurrentSession()){
      S.messages.push({role:'assistant', content:`Next turn: skill \`${match.name}\` will be forced.`});
      renderMessages();
    }
    showToast(`Skill \`${match.name}\` will be used for next turn.`);
  }catch(e){
    resolve(null);
    if(_forcedSkillDirectivePending===pending)_forcedSkillDirectivePending = null;
    showToast('Failed to load skills: '+e.message);
  }
}

async function cmdPersonality(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  if(!args){
    // List available personalities
    try{
      const data=await api('/api/personalities');
      if(!data.personalities||!data.personalities.length){
        showToast(t('no_personalities'));
        return;
      }
      const list=data.personalities.map(p=>`  **${p.name}**${p.description?' — '+p.description:''}`).join('\n');
      S.messages.push({role:'assistant',content:t('available_personalities')+'\n\n'+list+t('personality_switch_hint')});
      renderMessages();
    }catch(e){showToast(t('personalities_load_failed'));}
    return;
  }
  const name=args.trim();
  if(name.toLowerCase()==='none'||name.toLowerCase()==='default'||name.toLowerCase()==='clear'){
    try{
      await api('/api/personality/set',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,name:''})});
      if(S.session) S.session.personality='';
      _emptyStateIntroPersonality=null;
      showToast(t('personality_cleared'));
    }catch(e){showToast(t('failed_colon')+e.message);}
    return;
  }
  try{
    const res=await api('/api/personality/set',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,name})});
    if(S.session) S.session.personality=name;
    _emptyStateIntroPersonality=null;
    S.messages.push({role:'assistant',content:t('personality_set')+`**${name}**`});
    renderMessages();
    showToast(t('personality_set')+name);
  }catch(e){showToast(t('failed_colon')+e.message);}
}

async function cmdStop(){
  if(!S.session){showToast(t('no_active_session'));return;}
  if(!S.activeStreamId){showToast(t('no_active_task'));return;}
  if(typeof cancelStream==='function'){await cancelStream();showToast(t('stream_stopped'));}
  else showToast(t('cancel_unavailable'));
}

async function cmdGoal(args){
  if(!S.session){await newSession();await renderSessionList();}
  if(!S.session||!S.session.session_id){showToast(t('no_active_session'));return;}
  const activeSid=S.session.session_id;
  try{
    // 发送完整命令文本（/goal + args），后端 Rg_MuBiaoMingLingZaiHe 依赖 "/goal" 前缀解析子命令
    const goalText = args ? "/goal " + args : "";
    const r=await api('/api/goal',{method:'POST',body:JSON.stringify({
      session_id:activeSid,
      text:goalText,
      workspace:S.session.workspace,
      model:S.session.model||($('modelSelect')&&$('modelSelect').value)||'',
      model_provider:S.session.model_provider||null,
      profile:S.activeProfile||S.session.profile||'default',
    })});
    const msg = (() => {
      const raw = String((r && r.message) || '').trim();
      const key = String((r && r.message_key) || '').trim();
      const mArgs = Array.isArray(r && r.message_args) ? r.message_args : [];
      if (raw.includes('\n')) return raw;
      if (key && typeof t === 'function') {
        const translated = String(t(key, ...mArgs));
        if (translated && translated !== key) return translated;
      }
      return raw;
    })();
    if(msg){
      S.messages.push({role:'assistant',content:msg,_ts:Date.now()/1000,_goalStatus:true,_transient:true});
      renderMessages({preserveScroll:true});
      showToast(msg.split('\n')[0],2600);
    }
    // /api/goal 仅做目标CRUD管理，不启动流。仅当创建新目标时，调用 /api/chat/start 启动流式代理执行。
    const goalCreated = r && r.type === 'goal_created';
    if(!goalCreated)return;
    const goalMessage = (r.data && r.data.text) ? r.data.text : (args||'');
    const chatResp=await api('/api/chat/start',{method:'POST',body:JSON.stringify({
      session_id:activeSid,
      message:goalMessage,
      model:S.session.model||($('modelSelect')&&$('modelSelect').value)||'',
      workspace:S.session.workspace,
      model_provider:S.session.model_provider||null,
      profile:S.activeProfile||S.session.profile||'default',
      work_mode:(typeof _getCurrentWorkMode==='function'?_getCurrentWorkMode():'hermes-agent')||'hermes-agent',
    })});
    if(!chatResp||!chatResp.stream_id)return;
    S.toolCalls=[];
    if(typeof clearLiveToolCards==='function')clearLiveToolCards();
    appendThinking();setBusy(true);
    setComposerStatus(t('goal_working_toward'));
    S.activeStreamId=chatResp.stream_id;
    if(S.session&&S.session.session_id===activeSid){
      S.session.active_stream_id=chatResp.stream_id;
      if(typeof chatResp.pending_started_at==='number')S.session.pending_started_at=chatResp.pending_started_at;
      if(chatResp.effective_model)S.session.model=chatResp.effective_model;
      if(chatResp.effective_model_provider)S.session.model_provider=chatResp.effective_model_provider;
    }
    INFLIGHT[activeSid]={messages:[...S.messages],uploaded:[],toolCalls:[]};
    if(typeof markInflight==='function')markInflight(activeSid,chatResp.stream_id);
    if(typeof saveInflightState==='function')saveInflightState(activeSid,{streamId:chatResp.stream_id,messages:INFLIGHT[activeSid].messages,uploaded:[],toolCalls:[]});
    startApprovalPolling(activeSid);
    startClarifyPolling(activeSid);
    if(typeof _fetchYoloState==='function')_fetchYoloState(activeSid);
    attachLiveStream(activeSid,chatResp.stream_id,[]);
    if(typeof renderSessionList==='function')void renderSessionList();
  }catch(e){
    const err=String((e&&e.message)||e||'Goal command failed');
    S.messages.push({role:'assistant',content:`**Goal command failed:** ${err}`,_ts:Date.now()/1000,_error:true});
    renderMessages({preserveScroll:true});
    showToast(err,3000);
  }
}

// ── Busy-input mode commands ──────────────────────────────────────────────
// These commands let users override the default busy_input_mode setting for a
// specific message.  They are only meaningful while the agent is running.

/**
 * /queue <message> — Explicitly queue a message for the next turn.
 * Works regardless of the busy_input_mode setting.
 */
async function cmdQueue(args){
  const msg=(args||'').trim();
  if(!msg){showToast(t('cmd_queue_no_msg'));return;}
  // If nothing is running, /queue <msg> just sends like a normal message
  if(!S.busy){
    const inp=$('msg');
    if(inp){inp.value=msg;}
    if(typeof send==='function'){await send();}
    return;
  }
  if(!S.session){showToast(t('no_active_session'));return;}
  queueSessionMessage(S.session.session_id,{text:msg,files:[...S.pendingFiles],model:S.session&&S.session.model||($('modelSelect')&&$('modelSelect').value)||'',profile:S.activeProfile||'default'});
  updateQueueBadge(S.session.session_id);
  S.pendingFiles=[];renderTray();
  showToast(t('cmd_queue_confirm'),2000);
}

/**
 * /interrupt <message> — Cancel the current turn and send a new message.
 * Calls cancelStream() then queues the message so the drain picks it up.
 */
async function cmdInterrupt(args){
  const msg=(args||'').trim();
  if(!msg){showToast(t('cmd_interrupt_no_msg'));return;}
  // If nothing is running, /interrupt <msg> just sends like a normal message
  if(!S.busy||!S.activeStreamId){
    const inp=$('msg');
    if(inp){inp.value=msg;}
    if(typeof send==='function'){await send();}
    return;
  }
  if(!S.session){showToast(t('no_active_session'));return;}
  // Queue the message first (before cancel sets busy=false and drains)
  queueSessionMessage(S.session.session_id,{text:msg,files:[...S.pendingFiles],model:S.session&&S.session.model||($('modelSelect')&&$('modelSelect').value)||'',profile:S.activeProfile||'default'});
  updateQueueBadge(S.session.session_id);
  S.pendingFiles=[];renderTray();
  // Cancel the active stream; setBusy(false) will drain the queue
  if(typeof cancelStream==='function'){await cancelStream();}
  showToast(t('cmd_interrupt_confirm'),2000);
}

/**
 * /steer <message> — Inject a steering hint mid-task without interrupting.
 *
 * Calls POST /api/chat/steer which looks up the cached AIAgent for this
 * session and calls agent.steer(text). The agent's run loop appends the
 * steer text to the next tool-result message so the model sees it on its
 * next iteration — same pathway as the CLI's /steer command.
 *
 * Falls back to interrupt mode when the agent isn't running, isn't cached,
 * or doesn't support steer (older hermes-agent versions).
 */
async function cmdSteer(args){
  const msg=(args||'').trim();
  if(!msg){showToast(t('cmd_steer_no_msg'));return;}
  // If nothing is running, /steer <msg> just sends like a normal message
  if(!S.busy||!S.activeStreamId){
    const inp=$('msg');
    if(inp){inp.value=msg;}
    if(typeof send==='function'){await send();}
    return;
  }
  if(!S.session){showToast(t('no_active_session'));return;}
  await _trySteer(msg, /*explicitSteer=*/true);
}

/**
 * Shared implementation for /steer and the busy_input_mode='steer' path.
 *
 * Tries the real steer endpoint first. On any non-accept response (no cached
 * agent, agent lacks steer, stream dead, etc.) falls back to interrupt+queue:
 * queues the message and cancels the stream so the drain re-sends it.
 *
 * @param {string} msg - The steer text.
 * @param {boolean} explicitSteer - True if the user explicitly invoked /steer
 *   (vs the busy-mode auto-fallback). Affects toast wording only.
 */
function _showSteerIndicator(text){
  const inner=document.getElementById('msgInner');
  if(!inner) return;
  // Remove any existing steer indicator
  const old=inner.querySelector('.steer-indicator');
  if(old) old.remove();
  const el=document.createElement('div');
  el.className='steer-indicator';
  const badge=document.createElement('span');
  badge.className='steer-badge';
  badge.textContent='Steer';
  const body=document.createElement('span');
  body.className='steer-body';
  body.textContent=text.length>120?text.slice(0,117)+'…':text;
  el.appendChild(badge);
  el.appendChild(body);
  inner.appendChild(el);
  if(typeof scrollToBottom==='function') scrollToBottom();
}

async function _trySteer(msg, explicitSteer){
  let result=null;
  try{
    result=await api('/api/chat/steer',{
      method:'POST',
      body:JSON.stringify({session_id:S.session.session_id,text:msg}),
    });
  }catch(e){
    // Network or server error — fall back to interrupt
    result={accepted:false, fallback:'network_error'};
  }
  if(result&&result.accepted){
    // Show a transient steer indicator in the chat (NOT in S.messages — it must
    // survive the done event's S.messages=d.session.messages replacement).
    // The indicator self-removes when the turn completes (done/cancel/error
    // all call renderMessages which rebuilds msgInner).
    _showSteerIndicator(msg);
    showToast(t('cmd_steer_delivered'),2500);
    return;
  }
  // Fall back to interrupt: queue the message + cancel the stream so the
  // drain in setBusy(false) re-sends it as a fresh turn.
  queueSessionMessage(S.session.session_id,{text:msg,files:[...S.pendingFiles],model:S.session&&S.session.model||($('modelSelect')&&$('modelSelect').value)||'',profile:S.activeProfile||'default'});
  updateQueueBadge(S.session.session_id);
  S.pendingFiles=[];renderTray();
  if(typeof cancelStream==='function'){await cancelStream();}
  // Toast wording differs based on why we're falling back so the user
  // understands what just happened.
  const reason=(result&&result.fallback)||'unknown';
  if(explicitSteer){
    showToast(t('cmd_steer_fallback'),2500);
  } else if(reason==='no_cached_agent'||reason==='not_running'||reason==='stream_dead'){
    // Busy mode hit the steer path before the agent was ready —
    // interrupt is the natural fallback, no need to call out steer.
    showToast(t('busy_interrupt_confirm'),2000);
  } else {
    showToast(t('busy_steer_fallback'),2500);
  }
}

async function cmdTitle(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  const name=(args||'').trim();
  if(!name){
    S.messages.push({role:'assistant',content:`${t('title_current')}: **${S.session.title||t('untitled')}**\n\n${t('title_change_hint')}`});
    renderMessages();return;
  }
  try{
    const r=await api('/api/session/rename',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,title:name})});
    if(r&&r.error){showToast(r.error);return;}
    S.session.title=(r&&r.session&&r.session.title)||name;
    if(typeof syncTopbar==='function')syncTopbar();
    if(typeof renderSessionList==='function')renderSessionList();
    showToast(`${t('title_set')} "${S.session.title}"`);
    S.messages.push({role:'assistant',content:`${t('title_set')} **${S.session.title}**`});
    renderMessages();
  }catch(e){showToast(t('failed_colon')+e.message);}
}
async function cmdRetry(){
  if(!S.session){showToast(t('no_active_session'));return;}
  if(S.session.is_cli_session){showToast(t('cmd_webui_only_session'));return;}
  const activeSid=S.session.session_id;
  try{
    const r=await api('/api/session/retry',{method:'POST',body:JSON.stringify({session_id:activeSid})});
    if(r&&r.error){showToast(r.error);return;}
    if(!S.session||S.session.session_id!==activeSid)return;
    const data=await api('/api/session?session_id='+encodeURIComponent(activeSid));
    if(data&&data.session){S.messages=data.session.messages||[];S.toolCalls=[];if(typeof clearLiveToolCards==='function')clearLiveToolCards();if(typeof _messagesTruncated!=='undefined')_messagesTruncated=false;renderMessages();}
    $('msg').value=r.last_user_text||'';if(typeof autoResize==='function')autoResize();await send();
  }catch(e){showToast(t('retry_failed')+e.message);}
}
async function cmdUndo(){
  if(!S.session){showToast(t('no_active_session'));return;}
  if(S.session.is_cli_session){showToast(t('cmd_webui_only_session'));return;}
  const activeSid=S.session.session_id;
  try{
    const r=await api('/api/session/undo',{method:'POST',body:JSON.stringify({session_id:activeSid})});
    if(r&&r.error){showToast(r.error);return;}
    if(!S.session||S.session.session_id!==activeSid)return;
    const data=await api('/api/session?session_id='+encodeURIComponent(activeSid));
    if(data&&data.session){S.messages=data.session.messages||[];S.toolCalls=[];if(typeof clearLiveToolCards==='function')clearLiveToolCards();if(typeof _messagesTruncated!=='undefined')_messagesTruncated=false;renderMessages();}
    showToast(`↩ ${t('undid_n_messages')} ${r.removed_count} ${t('undid_messages_suffix')}`);
  }catch(e){showToast(t('undo_failed')+e.message);}
}
async function undoLastExchange(){await cmdUndo();}
async function cmdBtw(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  const question=(args||'').trim();
  if(!question){showToast(t('cmd_btw_usage'));return;}
  showToast(t('btw_asking'));
  const activeSid=S.session.session_id;
  try{
    const r=await api('/api/btw',{method:'POST',body:JSON.stringify({session_id:activeSid,question})});
    if(r&&r.error){showToast(r.error);return;}
    // Connect to the ephemeral SSE stream
    const streamId=r.stream_id;
    const parentSid=r.parent_session_id;
    if(typeof attachBtwStream==='function') attachBtwStream(parentSid,streamId,question);
  }catch(e){showToast(t('btw_failed')+e.message);}
}
async function cmdBackground(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  const prompt=(args||'').trim();
  if(!prompt){showToast(t('cmd_background_usage'));return;}
  showToast(t('bg_running'));
  const activeSid=S.session.session_id;
  try{
    const r=await api('/api/background',{method:'POST',body:JSON.stringify({session_id:activeSid,prompt})});
    if(r&&r.error){showToast(r.error);return;}
    // Show background badge and start polling
    if(typeof showBackgroundBadge==='function') showBackgroundBadge(r.task_id);
    if(typeof startBackgroundPolling==='function') startBackgroundPolling(activeSid,r.task_id,prompt);
  }catch(e){showToast(t('bg_failed')+e.message);}
}
function _formatStatusTimestamp(value){
  if(value===undefined||value===null||value==='') return t('status_unknown');
  let date;
  if(typeof value==='number') date=new Date(value < 1000000000000 ? value*1000 : value);
  else date=new Date(value);
  if(Number.isNaN(date.getTime())) return t('status_unknown');
  return date.toLocaleString();
}
function _formatStatusTokens(s){
  const lastUsage=(typeof S!=='undefined'&&(S.lastUsage||s.last_usage))||{};
  const input=Number(s.input_tokens??lastUsage.input_tokens??0)||0;
  const output=Number(s.output_tokens??lastUsage.output_tokens??0)||0;
  const total=Number(s.total_tokens??lastUsage.total_tokens??(input+output))||0;
  const cost=Number(s.estimated_cost??lastUsage.estimated_cost??0)||0;
  if(!total&&!cost) return t('status_no_tokens');
  const fmtNum=n=>Number(n||0).toLocaleString();
  return `${fmtNum(input)} in / ${fmtNum(output)} out${cost?` (~$${cost.toFixed(4)})`:''}`;
}
function _statusProviderForSession(s){
  if(s.model_provider) return String(s.model_provider);
  if(window._activeProvider) return String(window._activeProvider);
  const model=String(s.model||'');
  return model.includes('/') ? model.split('/')[0] : '';
}
function _statusCardFromSession(s){
  const provider=_statusProviderForSession(s);
  const model=s.model||(($('modelSelect')&&$('modelSelect').value)||t('usage_default_model'));
  const running=!!(s.active_stream_id||S.activeStreamId||S.busy);
  const profile=s.profile||S.activeProfile||'default';
  const workspace=s.workspace||S.currentDir||t('status_unknown');
  const rows=[
    {label:t('status_session_id'), value:s.session_id||t('status_unknown')},
    {label:t('status_title'), value:s.title||t('untitled')},
    {label:t('status_model'), value:model},
    {label:t('status_provider'), value:provider||t('status_unknown')},
    {label:t('status_profile'), value:profile},
    {label:t('status_workspace'), value:workspace},
    {label:t('status_personality'), value:s.personality||t('usage_personality_none')},
    {label:t('status_started'), value:_formatStatusTimestamp(s.created_at)},
    {label:t('status_updated'), value:_formatStatusTimestamp(s.updated_at||s.last_message_at)},
    {label:t('status_tokens'), value:_formatStatusTokens(s)},
    {label:t('status_messages'), value:String(s.message_count??(S.messages||[]).filter(m=>m&&m.role&&m.role!=='tool').length)},
    {label:t('status_agent_running'), value:running?t('status_yes'):t('status_no')},
  ];
  return {
    title:t('status_heading'),
    subtitle:t('status_ephemeral'),
    sessionId:s.session_id||'',
    rows,
  };
}
function cmdStatus(){
  if(!S.session){showToast(t('no_active_session'));return;}
  S.messages.push({
    role:'assistant',
    content:'',
    _ephemeral:true,
    _statusCard:_statusCardFromSession(S.session),
    _ts:Date.now()/1000,
  });
  renderMessages();
}
function cmdReasoning(args){
  const arg=(args||'').trim().toLowerCase();
  const BRAIN='\uD83E\uDDE0';
  // Matches hermes_constants.VALID_REASONING_EFFORTS + 'none' (CLI parity).
  // Keep this WebUI effort list in sync with hermes-agent#29248.
  const EFFORTS=['none','minimal','low','medium','high','xhigh'];
  // Shared status renderer used by the no-args branch and as a fallback.
  function _fmtStatus(st){
    const vis=(st && st.show_reasoning===false)?'off':'on';
    const eff=(st && st.reasoning_effort)||'default';
    return BRAIN+' Reasoning effort: '+eff+' \u00B7 display: '+vis
      +'  |  /reasoning show|hide|none|minimal|low|medium|high|xhigh';
  }
  if(!arg){
    // Status — read from the same config.yaml keys the CLI uses.
    const q=(typeof _reasoningEffortQuery==='function')?_reasoningEffortQuery():'';
    api('/api/reasoning'+q).then(function(st){showToast(_fmtStatus(st));})
      .catch(function(){showToast(BRAIN+' /reasoning — status unavailable');});
    return true;
  }
  if(arg==='show'||arg==='on'||arg==='hide'||arg==='off'){
    const on=(arg==='show'||arg==='on');
    // Update the UI render gate immediately for responsiveness.
    window._showThinking=on;
    if(!on&&typeof removeThinking==='function') removeThinking();
    if(typeof renderMessages==='function') renderMessages();
    // Persist via /api/reasoning → config.yaml display.show_reasoning
    // (CLI reads the same key).  Also mirror into WebUI settings.json
    // show_thinking so boot.js picks it up on reload without hitting
    // /api/reasoning on every page load.
    api('/api/reasoning',{method:'POST',body:JSON.stringify({display:arg})}).catch(function(){});
    api('/api/settings',{method:'POST',body:JSON.stringify({show_thinking:on})}).catch(function(){});
    showToast(BRAIN+' Thinking blocks: '+(on?'on':'off')+' (saved)');
    return true;
  }
  if(EFFORTS.includes(arg)){
    // Persist via /api/reasoning → config.yaml agent.reasoning_effort.
    // Takes effect on the NEXT session/turn (agent re-reads config at
    // construction time), matching CLI semantics where `/reasoning high`
    // also forces an agent re-init.
    api('/api/reasoning',{method:'POST',body:JSON.stringify({effort:arg})})
      .then(function(st){
        const eff=(st && st.reasoning_effort)||arg;
        showToast(BRAIN+' Reasoning effort: '+eff+' (saved; applies to next turn)');
        if(typeof _applyReasoningChip==='function') _applyReasoningChip(eff, st||{});
      })
      .catch(function(e){
        showToast(BRAIN+' Failed to set effort: '+(e && e.message ? e.message : arg));
      });
    return true;
  }
  showToast('Unknown argument: '+arg+' \u2014 use show|hide|'+EFFORTS.join('|'));
  return true;
}
function cmdVoice(){
  const mic=document.getElementById('btnMic');
  if(mic&&mic.style.display!=='none'&&!mic.disabled){try{mic.click();return;}catch(_){}}
  showToast(t('cmd_voice_use_mic'));
}

// ── YOLO mode toggle ──
// Session-scoped: skips all approval prompts for the current session.
// Toggles on/off; state is not persisted across page reloads.
async function cmdYolo(){
  const sid=S.session&&S.session.session_id;
  if(!sid){showToast(t('yolo_no_session'));return;}
  try{
    // Check current state first to toggle
    const status=await api('/api/session/yolo?session_id='+encodeURIComponent(sid));
    const enable=!status.yolo_enabled;
    await api('/api/session/yolo',{
      method:'POST',
      body:JSON.stringify({session_id:sid,enabled:enable}),
    });
    _yoloEnabled=enable;
    _updateYoloPill();
    showToast(enable?t('yolo_enabled'):t('yolo_disabled'));
    if(enable){
      // Dismiss any visible approval card
      hideApprovalCard(true);
    }
  }catch(e){showToast('YOLO: '+e.message);}
}

// ── Branch / fork command ──
// Forks the current conversation into a new session (#465).
// /branch           → full history copy
// /branch My Name   → full history copy with custom title
async function cmdBranch(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  const customTitle=(args||'').trim()||null;
  try{
    const data=await api('/api/session/branch',{
      method:'POST',
      body:JSON.stringify({
        session_id:S.session.session_id,
        title:customTitle||undefined,
      }),
    });
    if(data&&data.session_id){
      await loadSession(data.session_id);
      if(typeof renderSessionList==='function') await renderSessionList();
      showToast(t('branch_forked'));
    }
  }catch(e){showToast(t('branch_failed')+e.message);}
}

// ── /teleport: 会话传送 ──────────────────────────────────────────────────
// 导出当前会话的恢复链接和CLI恢复命令，支持在本地终端和Web界面间无缝迁移。
// 恢复链接会自动复制到剪贴板。
async function cmdTeleport(args){
  if(!S.session){showToast(t('no_active_session'));return;}
  const sid=S.session.session_id;
  // 构建Web恢复链接
  const restoreUrl=window.location.origin+window.location.pathname+'?session='+encodeURIComponent(sid);
  // 构建CLI恢复命令
  const restoreCmd='hermes -r '+sid;
  // 构建显示内容
  const lines=[
    '**'+t('teleport_title')+'**',
    '',
    '**'+t('teleport_web_label')+'**',
    '`'+restoreUrl+'`',
    '',
    '**'+t('teleport_cli_label')+'**',
    '`'+restoreCmd+'`',
    '',
    '**'+t('teleport_session_id')+'** `'+sid+'`',
    '',
    t('teleport_hint'),
  ];
  S.messages.push({
    role:'assistant',
    content:lines.join('\n'),
    _ephemeral:true,
    _ts:Date.now()/1000,
  });
  renderMessages();
  // 自动复制恢复链接到剪贴板
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(restoreUrl).then(()=>{
      showToast(t('teleport_copied'));
    }).catch(()=>{});
  }
}

// ── Fork from a specific message point ──
// Called from the "Fork from here" button on message hover actions.
// msgIdx is 1-based within the currently loaded tail window (rawIdx+1).
// When the session is truncated (_oldestIdx > 0), msgIdx alone would be
// a local-window count, but the backend expects an absolute message count
// from the beginning of the full transcript.  We capture the absolute
// count (_oldestIdx + msgIdx) BEFORE awaiting _ensureAllMessagesLoaded,
// which resets _oldestIdx to 0 after its wholesale replace.  See #2184.
async function forkFromMessage(msgIdx){
  if(!S.session||S.busy)return;
  const initialSid = S.session.session_id;
  // Capture the absolute keep_count before any async work that may
  // reset _oldestIdx.  _oldestIdx is 0 when the full transcript is
  // already loaded, so short/already-full sessions send msgIdx unchanged.
  const absoluteKeepCount = _oldestIdx + msgIdx;
  // Ensure the full transcript is loaded so the forked session renders
  // correctly and subsequent operations see the complete history.
  if(typeof _ensureAllMessagesLoaded==='function'){
    await _ensureAllMessagesLoaded();
  }
  if(!S.session || S.session.session_id !== initialSid) return;
  try{
    const data=await api('/api/session/branch',{
      method:'POST',
      body:JSON.stringify({
        session_id:initialSid,
        keep_count:absoluteKeepCount,
      }),
    });
    if(data&&data.session_id){
      await loadSession(data.session_id);
      if(typeof _ensureAllMessagesLoaded==='function') await _ensureAllMessagesLoaded();
      if(typeof renderSessionList==='function') await renderSessionList();
      showToast(t('branch_forked'));
    }
  }catch(e){showToast(t('branch_failed')+e.message);}
}

let _skillCommandCache=[];
let _skillCommandLoadPromise=null;
let _skillCommandCacheReady=false;
function _skillCommandSlug(name){
  const raw=String(name||'').trim().toLowerCase();
  if(!raw)return'';
  return raw.replace(/[\s_]+/g,'-').replace(/[^a-z0-9-]/g,'').replace(/-{2,}/g,'-').replace(/^-+|-+$/g,'');
}
function _getReservedSlashCommandSlugs(){
  const reserved=new Set(COMMANDS.map(c=>String(c&&c.name||'').trim().toLowerCase()).filter(Boolean));
  for(const cmd of (_agentCommandCache||[])){
    const names=[cmd.name].concat(Array.isArray(cmd&&cmd.aliases)?cmd.aliases:[]);
    for(const name of names){
      const slug=_skillCommandSlug(name);
      if(slug) reserved.add(slug);
    }
  }
  return reserved;
}
function _buildSkillCommandEntry(skill){
  const skillName=String(skill&&skill.name||'').trim();
  const slug=_skillCommandSlug(skillName);
  if(!slug)return null;
  if(_getReservedSlashCommandSlugs().has(slug)) return null;
  return{name:slug,desc:String(skill&&skill.description||'').trim()||t('slash_skill_desc'),source:'skill',skillName};
}
function _buildBundleCommandEntry(bundle){
  const slug=_skillCommandSlug(bundle&&bundle.name);
  if(!slug)return null;
  if(_getReservedSlashCommandSlugs().has(slug)) return null;
  const skillCount=Number(bundle&&bundle.skill_count||0);
  const rawDesc=String(bundle&&bundle.description||'').trim()||'Skill bundle';
  const i18nKey='bundle_desc_'+String(bundle&&bundle.name||'').replace(/-/g,'_');
  const desc=(typeof t==='function'&&t(i18nKey)!==i18nKey)?t(i18nKey):rawDesc;
  return{
    name:slug,
    desc,
    source:'bundle',
    skillCount:Number.isFinite(skillCount)?skillCount:0,
  };
}
async function loadSkillCommands(force=false){
  if(_skillCommandCacheReady&&!force)return _skillCommandCache;
  if(_skillCommandLoadPromise&&!force)return _skillCommandLoadPromise;
  _skillCommandLoadPromise=(async()=>{
    try{
      const data=await api('/api/skills');
      const deduped=new Map();
      for(const skill of (data&&data.skills)||[]){const entry=_buildSkillCommandEntry(skill);if(entry&&!deduped.has(entry.name))deduped.set(entry.name,entry);}
      _skillCommandCache=Array.from(deduped.values()).sort((a,b)=>a.name.localeCompare(b.name));
    }catch(_){_skillCommandCache=[];}
    finally{_skillCommandCacheReady=true;_skillCommandLoadPromise=null;}
    return _skillCommandCache;
  })();
  return _skillCommandLoadPromise;
}
async function loadBundleCommands(force=false){
  if(_bundleCommandCacheReady&&!force)return _bundleCommandCache;
  if(_bundleCommandLoadPromise&&!force)return _bundleCommandLoadPromise;
  _bundleCommandLoadPromise=(async()=>{
    try{
      await loadAgentCommandMetadata();
      const data=await api('/api/commands/bundles');
      const deduped=new Map();
      for(const bundle of (data&&data.bundles)||[]){const entry=_buildBundleCommandEntry(bundle);if(entry&&!deduped.has(entry.name))deduped.set(entry.name,entry);}
      _bundleCommandCache=Array.from(deduped.values()).sort((a,b)=>a.name.localeCompare(b.name));
    }catch(_){_bundleCommandCache=[];}
    finally{_bundleCommandCacheReady=true;_bundleCommandLoadPromise=null;}
    return _bundleCommandCache;
  })();
  return _bundleCommandLoadPromise;
}
async function getBundleCommandMetadata(name){
  const needle=String(name||'').trim().toLowerCase();
  if(!needle) return null;
  const bundles=await loadBundleCommands();
  return bundles.find(bundle=>String(bundle&&bundle.name||'').toLowerCase()===needle)||null;
}
function refreshSlashCommandDropdown(){
  const ta=$('msg');if(!ta)return;
  const text=ta.value||'';
  if(!text.startsWith('/')||text.indexOf('\n')!==-1){hideCmdDropdown();return;}
  getSlashAutocompleteMatches(text).then(matches=>{
    if(($('msg').value||'')!==text) return;
    if(matches.length)showCmdDropdown(matches);else hideCmdDropdown();
  });
}
function ensureSkillCommandsLoadedForAutocomplete(){
  // 技能型斜杠命令已移除 — 不再为自动补全加载技能列表
  if(!_bundleCommandCacheReady&&!_bundleCommandLoadPromise){
    loadBundleCommands().then(()=>{refreshSlashCommandDropdown();});
  }
  // Also preload agent/plugin command metadata for autocomplete
  if(!_agentCommandCacheReady&&!_agentCommandCachePromise){
    loadAgentCommandMetadata().then(()=>{refreshSlashCommandDropdown();});
  }
}

// ── Autocomplete dropdown ───────────────────────────────────────────────────

let _cmdSelectedIdx=-1;

function showCmdDropdown(matches){
  const dd=$('cmdDropdown');
  if(!dd)return;
  dd.innerHTML='';
  _cmdSelectedIdx=matches.length?0:-1;
  for(let i=0;i<matches.length;i++){
    const c=matches[i];
    const el=document.createElement('div');
    el.className='cmd-item';
    if(i===_cmdSelectedIdx) el.classList.add('selected');
    el.dataset.idx=i;
    const isSubArg=c.source==='subarg';
    const isPath=c.source==='path';
    const usage=(!isSubArg&&c.arg)?` <span class="cmd-item-arg">${esc(c.arg)}</span>`:'';
    const badge=c.source==='bundle'
      ? ' <span class="cmd-item-badge">Bundle</span>'
      : '';
    if(isPath) el.classList.add('cmd-item-path');
    const nameHtml=isPath
      ? `<div class="cmd-item-name"><span class="cmd-item-path-value">${esc(c.value)}</span></div>`
      : isSubArg
      ? `<div class="cmd-item-name"><span class="cmd-item-parent">/${esc(c.parent)}</span> <span class="cmd-item-subarg">${esc(c.value)}</span></div>`
      : `<div class="cmd-item-name">/${esc(c.name)}${usage}${badge}</div>`;
    const descHtml=`<div class="cmd-item-desc">${esc(c.desc)}</div>`;
    el.innerHTML=`${nameHtml}${descHtml}`;
    el.onmousedown=(e)=>{
      e.preventDefault();
      if(isPath){
        const ta=$('msg');
        if(!ta){hideCmdDropdown();return;}
        const start=Number.isFinite(Number(c.tokenStart))?Number(c.tokenStart):ta.selectionStart;
        const end=Number.isFinite(Number(c.tokenEnd))?Number(c.tokenEnd):ta.selectionEnd;
        const nextPath=String(c.value||'').endsWith('/')?String(c.value||''):`${String(c.value||'')}/`;
        const current=String(ta.value||'');
        const safeStart=Math.max(0,Math.min(start,current.length));
        const safeEnd=Math.max(safeStart,Math.min(end,current.length));
        ta.value=current.slice(0,safeStart)+nextPath+current.slice(safeEnd);
        const pos=safeStart+nextPath.length;
        ta.focus();
        ta.setSelectionRange(pos,pos);
        ta.dispatchEvent(new Event('input',{bubbles:true}));
        hideCmdDropdown();
        return;
      }
      const nextValue=isSubArg?('/'+c.parent+' '+c.value):('/'+c.name+(c.arg?' ':''));
      $('msg').value=nextValue;
      $('msg').focus();
      if(!isSubArg&&c.source!=='skill'&&c.source!=='bundle'&&nextValue.endsWith(' ')&&typeof getSlashAutocompleteMatches==='function'){
        getSlashAutocompleteMatches(nextValue).then(matches=>{
          if(($('msg').value||'')!==nextValue) return;
          if(matches.length) showCmdDropdown(matches);
          else hideCmdDropdown();
        });
      }else{
        hideCmdDropdown();
      }
    };
    dd.appendChild(el);
  }
  dd.classList.add('open');
}

function hideCmdDropdown(){
  const dd=$('cmdDropdown');
  if(dd)dd.classList.remove('open');
  _cmdSelectedIdx=-1;
}

function navigateCmdDropdown(dir){
  const dd=$('cmdDropdown');
  if(!dd)return;
  const items=dd.querySelectorAll('.cmd-item');
  if(!items.length)return;
  items.forEach(el=>el.classList.remove('selected'));
  _cmdSelectedIdx+=dir;
  if(_cmdSelectedIdx<0)_cmdSelectedIdx=items.length-1;
  if(_cmdSelectedIdx>=items.length)_cmdSelectedIdx=0;
  items[_cmdSelectedIdx].classList.add('selected');
  // Scroll the newly highlighted item into view so it stays visible when the
  // dropdown overflows and the user navigates with keyboard (#838).
  items[_cmdSelectedIdx].scrollIntoView({block:'nearest'});
}

function selectCmdDropdownItem(){
  const dd=$('cmdDropdown');
  if(!dd)return;
  const items=dd.querySelectorAll('.cmd-item');
  if(_cmdSelectedIdx>=0&&_cmdSelectedIdx<items.length){
    items[_cmdSelectedIdx].onmousedown({preventDefault:()=>{}});
  } else if(items.length===1){
    items[0].onmousedown({preventDefault:()=>{}});
  }
  hideCmdDropdown();
}

// ── Handler aliases (for test-discoverable command registration) ──────────────
// The COMMANDS array above is the authoritative dispatch table. These aliases
// allow tooling and tests to discover command handlers by name independently.
const HANDLERS = {};
HANDLERS.skills = cmdSkills;

// ── Claude Code mode CLI commands ──────────────────────────────────────────
// These commands inject specific prompts that guide the AI through structured
// workflows (git commit, code review, security audit, project init, etc.).
// They leverage the existing tool set (terminal, read_file, grep, etc.) and
// are available in any mode but are most useful in Claude Code mode.

/**
 * Helper: send a prompt to the AI as if the user typed it.
 * Follows the same flow as cmdGoal — calls /api/chat/start and attaches the SSE stream.
 */
async function _sendPromptToAgent(prompt, displayText) {
  if (!S.session) { await newSession(); await renderSessionList(); }
  if (!S.session || !S.session.session_id) { showToast(t('no_active_session')); return false; }
  const activeSid = S.session.session_id;
  try {
    const _modelState = (typeof _chatPayloadModelState === 'function') ? _chatPayloadModelState() : {model: S.session.model || '', model_provider: S.session.model_provider || null};
    const startData = await api('/api/chat/start', {method: 'POST', body: JSON.stringify({
      session_id: activeSid,
      message: prompt,
      model: _modelState.model || (S.session.model || ($('modelSelect') && $('modelSelect').value) || ''),
      workspace: S.session.workspace,
      model_provider: _modelState.model_provider || S.session.model_provider || null,
      profile: S.activeProfile || S.session.profile || 'default',
      work_mode: (typeof _getCurrentWorkMode === 'function' ? _getCurrentWorkMode() : 'hermes-agent') || 'hermes-agent',
    })});
    if (!startData || !startData.stream_id) return false;
    // Show the command as a user message
    S.messages.push({role: 'user', content: displayText, _ts: Date.now() / 1000});
    renderMessages();
    S.toolCalls = [];
    if (typeof clearLiveToolCards === 'function') clearLiveToolCards();
    if (typeof appendThinking === 'function') appendThinking();
    setBusy(true);
    S.activeStreamId = startData.stream_id;
    if (S.session && S.session.session_id === activeSid) {
      S.session.active_stream_id = startData.stream_id;
      if (typeof startData.pending_started_at === 'number') S.session.pending_started_at = startData.pending_started_at;
      if (startData.effective_model) S.session.model = startData.effective_model;
      if (startData.effective_model_provider) S.session.model_provider = startData.effective_model_provider;
    }
    INFLIGHT[activeSid] = {messages: [...S.messages], uploaded: [], toolCalls: []};
    if (typeof markInflight === 'function') markInflight(activeSid, startData.stream_id);
    if (typeof saveInflightState === 'function') saveInflightState(activeSid, {streamId: startData.stream_id, messages: INFLIGHT[activeSid].messages, uploaded: [], toolCalls: []});
    if (typeof startApprovalPolling === 'function') startApprovalPolling(activeSid);
    if (typeof startClarifyPolling === 'function') startClarifyPolling(activeSid);
    if (typeof _fetchYoloState === 'function') _fetchYoloState(activeSid);
    if (typeof attachLiveStream === 'function') attachLiveStream(activeSid, startData.stream_id, []);
    if (typeof renderSessionList === 'function') void renderSessionList();
    return true;
  } catch (e) {
    const err = String((e && e.message) || e || 'Command failed');
    S.messages.push({role: 'assistant', content: `**Command failed:** ${err}`, _ts: Date.now() / 1000, _error: true});
    renderMessages({preserveScroll: true});
    showToast(err, 3000);
    return false;
  }
}

/** /commit — AI analyzes git diff and creates a commit with a generated message. */
async function cmdCommit(args) {
  const extra = (args || '').trim();
  const prompt = `Analyze the current git changes and create a commit.

**Steps:**
1. Run \`git status\` to see what files have changed
2. Run \`git diff\` and \`git diff --cached\` to review all changes
3. Generate a concise, descriptive commit message following conventional commits format (type(scope): description)
4. Stage all relevant files with \`git add\` (or specific files if appropriate)
5. Commit with the generated message using a heredoc:
   \`git commit -m "$(cat <<'EOF'\n<commit message>\nEOF\n)"\`

**Git Safety Protocol:**
- NEVER update git config
- NEVER use --no-verify or skip hooks
- NEVER force push
- Do NOT commit files that likely contain secrets (.env, credentials.json, etc.)
- If there are no changes to commit, inform the user${extra ? `\n\n**Additional instructions from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/commit' + (extra ? ' ' + extra : ''));
}

/** /commit-push-pr — Full flow: branch → commit → push → create/update PR. */
async function cmdCommitPushPr(args) {
  const extra = (args || '').trim();
  const prompt = `Execute the full git workflow: create branch → commit → push → create/update PR.

**Steps:**
1. Run \`git status\` and \`git diff\` to review changes
2. If not already on a feature branch, create one:
   - Generate a branch name from the changes (e.g., \`feat/add-login-form\`)
   - Run \`git checkout -b <branch-name>\`
3. Stage all relevant files: \`git add\`
4. Generate a commit message and commit (same rules as /commit)
5. Push the branch: \`git push -u origin <branch-name>\`
6. Create a Pull Request using \`gh pr create\` with:
   - A clear title summarizing the changes
   - A description with: Summary, Changes, Test Plan
   - If a PR already exists for this branch, update it with \`gh pr edit\`

**Git Safety Protocol:**
- NEVER update git config
- NEVER use --no-verify, --force, or skip hooks
- NEVER force push to main/master
- Do NOT commit files with secrets (.env, credentials.json, etc.)
- If \`gh\` CLI is not available, inform the user${extra ? `\n\n**Additional instructions from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/commit-push-pr' + (extra ? ' ' + extra : ''));
}

/** /review — AI-driven code review of the current diff or PR. */
async function cmdReview(args) {
  const extra = (args || '').trim();
  const prompt = `Perform a thorough code review of the current changes.

**Steps:**
1. Run \`git status\` and \`git diff\` to see all uncommitted changes
2. If there's an active PR, use \`gh pr view\` and \`gh pr diff\` to get PR details
3. Review the changes focusing on:
   - **Correctness**: Logic errors, edge cases, off-by-one errors
   - **Project conventions**: Naming, structure, patterns consistency
   - **Performance**: N+1 queries, unnecessary allocations, hot paths
   - **Test coverage**: Are new code paths tested?
   - **Security**: Input validation, auth checks, injection risks
4. Provide a structured review:
   - **Summary**: Overall assessment
   - **Issues Found**: Listed by severity (Critical/Warning/Suggestion)
   - **Positive Aspects**: What was done well
   - **Recommendations**: Actionable improvements

Be constructive and specific. Reference file names and line numbers.${extra ? `\n\n**Focus area from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/review' + (extra ? ' ' + extra : ''));
}

/** /bughunter — AI analyzes the codebase for potential bugs. */
async function cmdBughunter(args) {
  const extra = (args || '').trim();
  const prompt = `Hunt for bugs in the current codebase. Act as an expert bug hunter.

**Steps:**
1. Run \`git status\` and \`git diff\` to see recent changes (focus on these first)
2. If no recent changes, use \`grep\` and \`read_file\` to explore the codebase
3. Look for these categories of bugs:
   - **Null/undefined access**: Unchecked returns, optional chaining gaps
   - **Resource leaks**: Unclosed files, connections, goroutines
   - **Race conditions**: Shared state without locks, concurrent access
   - **Error handling**: Swallowed errors, missing error checks
   - **Logic errors**: Off-by-one, wrong comparisons, inverted conditions
   - **Security**: SQL injection, path traversal, XSS, command injection
   - **Memory issues**: Unbounded growth, circular references, large allocations
4. For each bug found, provide:
   - **Location**: File and line number
   - **Severity**: Critical / High / Medium / Low
   - **Description**: What's wrong and why it's a bug
   - **Suggested fix**: How to fix it (with code snippet if helpful)

Focus on real bugs, not style issues. Minimize false positives.${extra ? `\n\n**Focus area from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/bughunter' + (extra ? ' ' + extra : ''));
}

/** /security-review — Security-focused code review. */
async function cmdSecurityReview(args) {
  const extra = (args || '').trim();
  const prompt = `Perform a security code review. Act as a senior security engineer.

**Methodology:**
1. **Context Research**: Run \`git diff\` and \`git log\` to understand recent changes. Use \`grep\` to find security-sensitive patterns (auth, crypto, SQL, file ops, eval).
2. **Comparative Analysis**: Review the diff against the codebase context.

**Review Categories:**
- **Input Validation**: SQL injection, command injection, XXE, template injection, NoSQL injection, path traversal
- **Authentication & Authorization**: Missing auth checks, privilege escalation, session management
- **Cryptography & Secrets**: Hardcoded secrets, weak algorithms, key management, TLS issues
- **Injection & Code Execution**: eval(), dynamic SQL, deserialization, SSRF
- **Data Exposure**: Sensitive data in logs, error messages, API responses

**Rules:**
- Only report issues with >80% confidence — minimize false positives
- Exclude DoS, disk-based key storage, and rate-limiting issues
- For each finding: Location, Severity (Critical/High/Medium/Low), Description, Remediation

**Output Format:**
\`\`\`
## Security Review Summary
[Overall assessment]

## Findings

### [Severity] Title
- **Location**: file:line
- **Description**: ...
- **Remediation**: ...
\`\`\`${extra ? `\n\n**Focus area from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/security-review' + (extra ? ' ' + extra : ''));
}

/** /init — Detect project build commands, test framework, linter, formatter. */
async function cmdInit(args) {
  const extra = (args || '').trim();
  const prompt = `Analyze the current project and create a CLAUDE.md file with project-specific guidance.

**Steps:**
1. **Detect project type**: Look for manifest files:
   - \`package.json\` (Node.js/JavaScript/TypeScript)
   - \`go.mod\` (Go)
   - \`requirements.txt\` / \`pyproject.toml\` / \`setup.py\` (Python)
   - \`Cargo.toml\` (Rust)
   - \`pom.xml\` / \`build.gradle\` (Java)
   - \`.csproj\` / \`.sln\` (.NET)
   - \`*.wsv\` (火山程序)

2. **Detect build commands**: Read manifest files to find:
   - Build: \`npm run build\`, \`go build\`, \`pip install\`, \`cargo build\`, etc.
   - Run/Dev: \`npm start\`, \`go run\`, \`python main.py\`, etc.

3. **Detect test framework**: Look for test configs and patterns:
   - Jest/Vitest/Mocha (JS), pytest (Python), \`go test\` (Go), cargo test (Rust)
   - Read test scripts in package.json or CI configs

4. **Detect linter**: Check for config files:
   - ESLint (\`.eslintrc*\`), Ruff (\`ruff.toml\`), golangci-lint (\`.golangci.yml\`), Clippy (Rust)

5. **Detect formatter**: Check for:
   - Prettier (\`.prettierrc*\`), Black (\`pyproject.toml\`), gofmt, rustfmt (\`rustfmt.toml\`)

6. **Read existing docs**: Check for README.md, existing CLAUDE.md, .cursor/rules, AGENTS.md

7. **Create CLAUDE.md**: Write a concise project guide with:
   \`\`\`markdown
   # Project: [name]

   ## Build & Run
   - Build: \`[command]\`
   - Dev: \`[command]\`

   ## Testing
   - Run tests: \`[command]\`

   ## Linting & Formatting
   - Lint: \`[command]\`
   - Format: \`[command]\`

   ## Project Structure
   [Brief description of key directories]

   ## Conventions
   [Coding conventions discovered from the codebase]
   \`\`\`

**Important**: Only include information that would help an AI assistant work with this codebase. Each line must pass the test: "Would removing this cause the AI to make mistakes?"${extra ? `\n\n**Additional instructions from user:** ${extra}` : ''}`;
  await _sendPromptToAgent(prompt, '/init' + (extra ? ' ' + extra : ''));
}

/** /generate-agent — Generate a custom agent configuration from a description. */
async function cmdGenerateAgent(args) {
  const description = (args || '').trim();
  if (!description) {
    showToast(t('cmd_generate_agent') + ' — usage: /generate-agent <description>');
    return false;
  }
  const prompt = `Generate a custom agent configuration based on the user's description. The agent must follow the schema below strictly.

**User description:** ${description}

**Output a single JSON object** (no markdown fences, no extra prose) with exactly these fields:

\`\`\`json
{
  "identifier": "<lowercase-alphanumeric-with-hyphens, 2-4 words, e.g. 'code-reviewer' or 'test-writer'>",
  "whenToUse": "Use this agent when <scenario>. Examples: <example 1>; <example 2>",
  "systemPrompt": "You are <role>. <responsibilities>. <constraints>. <tone>."
}
\`\`\`

**Rules:**
1. \`identifier\` MUST be lowercase, contain only letters, digits, and hyphens, and consist of 2-4 words separated by hyphens.
2. \`whenToUse\` MUST start with the exact phrase "Use this agent when" and MUST include at least two concrete usage examples.
3. \`systemPrompt\` MUST be written in the second person ("You are..."), describe the agent's role, responsibilities, constraints, and tone.
4. The configuration MUST be directly usable as a custom agent — no placeholders, no TODOs.
5. Output ONLY the JSON object, nothing else.`;
  await _sendPromptToAgent(prompt, '/generate-agent ' + description);
}
