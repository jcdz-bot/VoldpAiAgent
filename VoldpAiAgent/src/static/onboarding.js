const ONBOARDING={status:null,step:0,steps:['system','setup','workspace','password','finish'],form:{provider:'openrouter',workspace:'',model:'',password:'',apiKey:'',baseUrl:'',displayName:'',apiFormat:'openai_chat',authStrategy:'api_key',defaultModel:'',supportsVision:false,supportsVoice:false,modelMapping:'',modelContextWindows:'',notes:'',presetId:''},active:false,probe:{status:'idle',error:null,detail:'',models:null,probedKey:''},presets:[],_presetLoaded:false};

// ── Onboarding base-URL probe (#1499) ───────────────────────────────────────
// Probes <base_url>/models so the wizard can validate the configured endpoint
// before persisting AND populate the model dropdown from the live catalog.
// Probe state lives on ONBOARDING.probe; the dropdown render and the
// nextOnboardingStep gate both consult it.

let _onboardingProbeTimer=null;

function _onboardingProbeKey(provider,baseUrl,apiKey){
  return `${provider||''}|${(baseUrl||'').trim().replace(/\/+$/,'')}|${apiKey||''}`;
}

function _setOnboardingProbeState(patch){
  ONBOARDING.probe={...ONBOARDING.probe,...patch};
  // Re-render body so probe status / model dropdown reflect new state.
  _renderOnboardingBody();
}

async function _runOnboardingProbe({force=false}={}){
  const provider=ONBOARDING.form.provider;
  const cat=_getOnboardingSetupProvider(provider);
  if(!cat||!cat.requires_base_url){
    _setOnboardingProbeState({status:'idle',error:null,detail:'',models:null,probedKey:''});
    return ONBOARDING.probe;
  }
  const baseUrl=(ONBOARDING.form.baseUrl||'').trim();
  if(!baseUrl){
    _setOnboardingProbeState({status:'idle',error:null,detail:'',models:null,probedKey:''});
    return ONBOARDING.probe;
  }
  const apiKey=(ONBOARDING.form.apiKey||'').trim();
  const key=_onboardingProbeKey(provider,baseUrl,apiKey);
  if(!force&&ONBOARDING.probe.probedKey===key&&ONBOARDING.probe.status!=='probing'){
    return ONBOARDING.probe;
  }
  _setOnboardingProbeState({status:'probing',error:null,detail:'',probedKey:key});
  try{
    const res=await api('/api/onboarding/probe',{method:'POST',body:JSON.stringify({provider,base_url:baseUrl,api_key:apiKey||undefined,api_format:ONBOARDING.form.apiFormat||undefined})});
    if(res&&res.ok){
      _setOnboardingProbeState({status:'ok',error:null,detail:'',models:Array.isArray(res.models)?res.models:[],probedKey:key});
      // If the user hasn't picked a model yet (or their pick is no longer in
      // the list), default to the first probed model so Continue isn't blocked
      // on an empty selection.
      const stillPresent=ONBOARDING.form.model&&(res.models||[]).some(m=>m.id===ONBOARDING.form.model);
      if(!stillPresent&&(res.models||[]).length>0){
        ONBOARDING.form.model=res.models[0].id;
        _renderOnboardingBody();
      }
    }else{
      const err=(res&&res.error)||'unreachable';
      const detail=(res&&res.detail)||'';
      _setOnboardingProbeState({status:'error',error:err,detail,models:null,probedKey:key});
    }
  }catch(e){
    _setOnboardingProbeState({status:'error',error:'unreachable',detail:(e&&e.message)||String(e),models:null,probedKey:key});
  }
  return ONBOARDING.probe;
}

function _scheduleOnboardingProbe(){
  if(_onboardingProbeTimer)clearTimeout(_onboardingProbeTimer);
  _onboardingProbeTimer=setTimeout(()=>{_runOnboardingProbe();},400);
}

function _onboardingProbeMessage(probe){
  if(!probe||probe.status==='idle')return '';
  if(probe.status==='probing')return t('onboarding_probe_probing')||'Testing connection…';
  if(probe.status==='ok'){
    const n=(probe.models||[]).length;
    const tmpl=t('onboarding_probe_ok')||'Connected. {n} model(s) available.';
    return tmpl.replace('{n}',String(n));
  }
  // status === 'error'
  const errKey='onboarding_probe_error_'+probe.error;
  const localized=t(errKey);
  // i18n.js's `t()` returns the key itself when missing — fall back to a generic message.
  const heading=(localized&&localized!==errKey)?localized:(t('onboarding_probe_error_generic')||'Could not reach the configured base URL.');
  const detail=probe.detail?` (${probe.detail})`:'';
  return heading+detail;
}

function _getOnboardingSetupProviders(){
  return (((ONBOARDING.status||{}).setup||{}).providers)||[];
}

function _getOnboardingSetupProvider(id){
  return _getOnboardingSetupProviders().find(p=>p.id===id)||null;
}

function _getOnboardingSetupCategories(){
  return (((ONBOARDING.status||{}).setup||{}).categories)||[];
}

/** Render the provider <select> with <optgroup> per category. */
function _renderProviderSelectOptions(selectedId){
  const providers=_getOnboardingSetupProviders();
  const categories=_getOnboardingSetupCategories();
  const provMap={};
  providers.forEach(p=>{provMap[p.id]=p;});
  if(!categories.length){
    // Fallback: flat list when no categories are available.
    return providers.map(p=>`<option value="${esc(p.id)}">${esc(p.label)}${p.quick?' — '+esc(t('onboarding_quick_setup_badge')):''}</option>`).join('');
  }
  return categories.map(cat=>{
    const opts=cat.providers.map(pid=>{
      const p=provMap[pid];
      if(!p)return '';
      return `<option value="${esc(p.id)}"${p.id===selectedId?' selected':''}>${esc(p.label)}${p.quick?' — '+esc(t('onboarding_quick_setup_badge')):''}</option>`;
    }).join('');
    return `<optgroup label="${esc(t('provider_category_'+cat.id)||cat.label)}">${opts}</optgroup>`;
  }).join('');
}

function _getOnboardingCurrentSetup(){
  return (((ONBOARDING.status||{}).setup||{}).current)||{};
}

function _onboardingStepMeta(key){
  return ({
    system:{title:t('onboarding_step_system_title'),desc:t('onboarding_step_system_desc')},
    setup:{title:t('onboarding_step_setup_title'),desc:t('onboarding_step_setup_desc')},
    workspace:{title:t('onboarding_step_workspace_title'),desc:t('onboarding_step_workspace_desc')},
    password:{title:t('onboarding_step_password_title'),desc:t('onboarding_step_password_desc')},
    finish:{title:t('onboarding_step_finish_title'),desc:t('onboarding_step_finish_desc')}
  })[key];
}

function _renderOnboardingSteps(){
  const wrap=$('onboardingSteps');
  if(!wrap)return;
  wrap.innerHTML='';
  ONBOARDING.steps.forEach((key,idx)=>{
    const meta=_onboardingStepMeta(key);
    const item=document.createElement('div');
    item.className='onboarding-step'+(idx===ONBOARDING.step?' active':idx<ONBOARDING.step?' done':'');
    item.innerHTML=`<div class="onboarding-step-index">${idx+1}</div><div><div class="onboarding-step-title">${meta.title}</div><div class="onboarding-step-desc">${meta.desc}</div></div>`;
    wrap.appendChild(item);
  });
}

function _setOnboardingNotice(msg,kind='info'){
  const el=$('onboardingNotice');
  if(!el)return;
  if(!msg){el.style.display='none';el.textContent='';el.className='onboarding-status';return;}
  el.style.display='block';
  el.className='onboarding-status '+kind;
  el.textContent=msg;
}

function _getOnboardingWorkspaceChoices(){
  const items=((ONBOARDING.status||{}).workspaces||{}).items||[];
  return items.length?items:[{name:'Home',path:ONBOARDING.form.workspace||''}];
}

function _getOnboardingProviderModelChoices(){
  const provider=_getOnboardingSetupProvider(ONBOARDING.form.provider);
  // Probe-discovered models (#1499) take precedence over the static catalog
  // for providers with requires_base_url=True.  The catalog ships an empty
  // list for self-hosted providers (lmstudio, ollama, custom) — without the
  // probe the user had nothing to pick from.
  if(provider&&provider.requires_base_url&&ONBOARDING.probe&&ONBOARDING.probe.status==='ok'&&Array.isArray(ONBOARDING.probe.models)&&ONBOARDING.probe.models.length){
    return ONBOARDING.probe.models;
  }
  return provider?(provider.models||[]):[];
}

function _renderOnboardingBaseUrlField(showBaseUrl){
  // Renders the base_url input PLUS the probe status banner / Test button
  // when the active provider has requires_base_url=True (#1499).  Returns
  // the empty string when the active provider does not require a base URL,
  // so the existing call sites can continue to template-interpolate this in
  // place of the previous inline `<label …>` snippet.
  if(!showBaseUrl)return '';
  const probe=ONBOARDING.probe||{status:'idle'};
  const msg=_onboardingProbeMessage(probe);
  let banner='';
  if(msg){
    const cls={ok:'onboarding-probe-ok',probing:'onboarding-probe-probing',error:'onboarding-probe-error'}[probe.status]||'';
    banner=`<p class="onboarding-copy onboarding-probe-banner ${cls}">${esc(msg)}</p>`;
  }
  const testBtnLabel=t('onboarding_probe_test_button')||'Test connection';
  const testBtnDisabled=(probe.status==='probing')?'disabled':'';
  return `<label class="onboarding-field"><span>${t('onboarding_base_url_label')}</span><input id="onboardingBaseUrlInput" value="${esc(ONBOARDING.form.baseUrl||'')}" placeholder="${t('onboarding_base_url_placeholder')}" oninput="ONBOARDING.form.baseUrl=this.value;_scheduleOnboardingProbe()" onblur="_runOnboardingProbe()"></label><div class="onboarding-probe-row"><button type="button" class="onboarding-probe-btn" ${testBtnDisabled} onclick="_runOnboardingProbe({force:true})">${esc(testBtnLabel)}</button></div>${banner}`;
}

function _renderOnboardingApiKeyField(){
  // Renders the API-key input.  For providers flagged `key_optional` in the
  // setup catalog (lmstudio, ollama, custom — typically self-hosted servers
  // that run keyless by default), the field shows an "(optional)" hint and
  // empty input is accepted on Continue.  Pre-#1499-third-sub-bug-fix the
  // wizard required a non-empty string here even for keyless installs, which
  // forced users to type random gibberish to clear onboarding.
  const provider=_getOnboardingSetupProvider(ONBOARDING.form.provider);
  const keyOptional=!!(provider&&provider.key_optional);
  const labelKey=keyOptional?'onboarding_api_key_label_optional':'onboarding_api_key_label';
  const placeholderKey=keyOptional?'onboarding_api_key_placeholder_optional':'onboarding_api_key_placeholder';
  const helpHtml=keyOptional?`<p class="onboarding-copy onboarding-api-key-help">${esc(t('onboarding_api_key_help_keyless')||'')}</p>`:'';
  return `<label class="onboarding-field" id="onboardingApiKeyField"><span>${t(labelKey)}</span><input id="onboardingApiKeyInput" type="password" value="${esc(ONBOARDING.form.apiKey||'')}" placeholder="${t(placeholderKey)}" oninput="ONBOARDING.form.apiKey=this.value" onblur="_runOnboardingProbe()"></label>${helpHtml}`;
}

function _getOnboardingSelectedModel(){
  return ONBOARDING.form.model||'';
}

function _renderOnboardingModelField(){
  const choices=_getOnboardingProviderModelChoices();
  if(ONBOARDING.form.provider==='custom' || choices.length===0){
    return `<label class="onboarding-field"><span>${t('onboarding_model_label')}</span><input id="onboardingModelInput" value="${esc(_getOnboardingSelectedModel())}" placeholder="${t('onboarding_custom_model_placeholder')}" oninput="ONBOARDING.form.model=this.value"></label><p class="onboarding-copy">${t('onboarding_custom_model_help')}</p>`;
  }
  const options=choices.map(m=>`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  return `<label class="onboarding-field"><span>${t('onboarding_model_label')}</span><select id="onboardingModelSelect" onchange="ONBOARDING.form.model=this.value">${options}</select></label><p class="onboarding-copy">${t('onboarding_workspace_help')}</p>`;
}

function _renderOnboardingProviderOAuthField(provider){
  if(!provider||provider.oauth_provider!=='anthropic')return '';
  return `<div class="onboarding-oauth-card onboarding-oauth-pending" style="margin-top:12px">
    <div class="onboarding-oauth-icon">🔑</div>
    <div style="flex:1">
      <strong>Use Claude Code OAuth instead</strong>
      <p style="margin-top:6px;color:var(--muted);font-size:13px"><strong>Claude Code subscription credentials are not the same as an Anthropic API key.</strong> Use this path only when you want Hermes to use Claude Code credentials already available on the server, or start a short polling flow while you complete <code>claude setup-token</code> on the host.</p>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="sm-btn" id="anthropicOAuthBtn" onclick="startAnthropicOAuth()" type="button">Login with Claude Code</button></div>
      <div id="anthropicOAuthFlow" style="display:none;margin-top:12px"></div>
    </div>
  </div>`;
}

function _providerStatusLabel(system){
  if(system.chat_ready) return t('onboarding_check_provider_ready');
  if(system.provider_configured) return t('onboarding_check_provider_partial');
  return t('onboarding_check_provider_pending');
}

function _renderOnboardingBody(){
  const body=$('onboardingBody');
  if(!body||!ONBOARDING.status)return;
  const key=ONBOARDING.steps[ONBOARDING.step];
  const system=ONBOARDING.status.system||{};
  const settings=ONBOARDING.status.settings||{};
  const setup=ONBOARDING.status.setup||{};
  const nextBtn=$('onboardingNextBtn');
  const backBtn=$('onboardingBackBtn');
  if(backBtn) backBtn.style.display=ONBOARDING.step>0?'':'none';
  if(nextBtn) nextBtn.textContent=key==='finish'?t('onboarding_open'):t('onboarding_continue');

  if(key==='system'){
    const hermesOk=system.hermes_found&&system.imports_ok;
    const setupOk=!!system.chat_ready;
    _setOnboardingNotice(system.provider_note|| (setupOk?t('onboarding_notice_system_ready'):t('onboarding_notice_system_unavailable')),setupOk?'success':(hermesOk?'info':'warn'));
    body.innerHTML=`
      <div class="onboarding-panel-grid">
        <div class="onboarding-check ${hermesOk?'ok':'warn'}"><strong>${t('onboarding_check_agent')}</strong><span>${hermesOk?t('onboarding_check_agent_ready'):t('onboarding_check_agent_missing')}</span></div>
        <div class="onboarding-check ${(setupOk?'ok':system.provider_configured?'warn':'muted')}"><strong>${t('onboarding_check_provider')}</strong><span>${_providerStatusLabel(system)}</span></div>
        <div class="onboarding-check ${(settings.password_enabled?'ok':'muted')}"><strong>${t('onboarding_check_password')}</strong><span>${settings.password_enabled?t('onboarding_check_password_enabled'):t('onboarding_check_password_disabled')}</span></div>
      </div>
      <div class="onboarding-copy">
        <p><strong>${t('onboarding_config_file')}</strong> ${esc(system.config_path||t('onboarding_unknown'))}</p>
        <p><strong>${t('onboarding_env_file')}</strong> ${esc(system.env_path||t('onboarding_unknown'))}</p>
        <p>${esc(system.provider_note||'')}</p>
        ${system.current_provider?`<p><strong>${t('onboarding_current_provider')}</strong> ${esc(system.current_provider)}${system.current_model?` — ${esc(system.current_model)}`:''}</p>`:''}
        ${system.current_base_url?`<p><strong>${t('onboarding_base_url_label')}</strong> ${esc(system.current_base_url)}</p>`:''}
        ${system.missing_modules&&system.missing_modules.length?`<p><strong>${t('onboarding_missing_imports')}</strong> ${esc(system.missing_modules.join(', '))}</p>`:''}
      </div>`;
    return;
  }

  if(key==='setup'){
    const selectedId=ONBOARDING.form.provider;
    const groupedOptions=_renderProviderSelectOptions(selectedId);
    const provider=_getOnboardingSetupProvider(selectedId)||_getOnboardingSetupProviders()[0]||null;
    const showBaseUrl=provider&&provider.requires_base_url;
    const keyHelp=provider
      ? (provider.id==='anthropic'
        ? 'Anthropic API key path: paste an Anthropic Console API key here. This is separate from a Claude Code subscription; use the Claude Code OAuth card if you want subscription credentials instead.'
        : `${t('onboarding_api_key_help_prefix')} ${esc(provider.env_var)}.`)
      : '';

    // OAuth provider path: configured via CLI, no API key input needed.
    const currentIsOauth=!!(ONBOARDING.status.setup||{}).current_is_oauth;
    const currentProviderName=((ONBOARDING.status.setup||{}).current||{}).provider||'';
    if(currentIsOauth){
      const isReady=!!(ONBOARDING.status.system||{}).chat_ready;
      const providerLabel=esc(currentProviderName);
      const codexOauthPendingBody=currentProviderName==='openai-codex'
        ? 'This instance is configured to use <strong>openai-codex</strong>, which uses OAuth rather than an API key. Use the button below to authenticate with ChatGPT, then continue once provider status refreshes.'
        : t('onboarding_oauth_provider_not_ready_body').replace('{provider}',providerLabel);
      if(isReady){
        _setOnboardingNotice(t('onboarding_notice_setup_already_ready'),'success');
        body.innerHTML=`
          <div class="onboarding-oauth-card onboarding-oauth-ready">
            <div class="onboarding-oauth-icon">✓</div>
            <div>
              <strong>${t('onboarding_oauth_provider_ready_title')}</strong>
              <p>${t('onboarding_oauth_provider_ready_body').replace('{provider}',providerLabel)}</p>
            </div>
          </div>
          <p class="onboarding-copy" style="margin-top:20px">${t('onboarding_oauth_switch_hint')}</p>
          <label class="onboarding-field">
            <span>${t('onboarding_provider_label')}</span>
            <select id="onboardingProviderSelect" onchange="syncOnboardingProvider(this.value)">${groupedOptions}</select>
          </label>
          ${_renderOnboardingApiKeyField()}
          ${_renderOnboardingBaseUrlField(showBaseUrl)}
          <p class="onboarding-copy">${keyHelp}</p>`;
      } else {
        _setOnboardingNotice(t('onboarding_notice_setup_required'),'warn');
        body.innerHTML=`
          <div class="onboarding-oauth-card onboarding-oauth-pending">
            <div class="onboarding-oauth-icon">⚠</div>
            <div style="flex:1">
              <strong>${t('onboarding_oauth_provider_not_ready_title')}</strong>
              <p>${codexOauthPendingBody}</p>
              ${currentProviderName==='openai-codex'?`<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="sm-btn" id="codexOAuthBtn" onclick="startCodexOAuth()" type="button">${t('oauth_login_codex')}</button></div><div id="codexOAuthFlow" style="display:none;margin-top:12px"></div>`:''}
            </div>
          </div>
          <p class="onboarding-copy" style="margin-top:20px">${t('onboarding_oauth_switch_hint')}</p>
          <label class="onboarding-field">
            <span>${t('onboarding_provider_label')}</span>
            <select id="onboardingProviderSelect" onchange="syncOnboardingProvider(this.value)">${groupedOptions}</select>
          </label>
          ${_renderOnboardingApiKeyField()}
          ${_renderOnboardingBaseUrlField(showBaseUrl)}
          <p class="onboarding-copy">${keyHelp}</p>`;
      }
      return;
    }

    _setOnboardingNotice(system.chat_ready?t('onboarding_notice_setup_already_ready'):t('onboarding_notice_setup_required'),system.chat_ready?'success':'info');
    body.innerHTML=_renderOnboardingDetailedProviderForm();
    _initOnboardingProviderForm();
    return;
  }

  if(key==='workspace'){
    const workspaceOptions=_getOnboardingWorkspaceChoices().map(ws=>`<option value="${esc(ws.path)}">${esc(ws.name||ws.path)} — ${esc(ws.path)}</option>`).join('');
    _setOnboardingNotice(t('onboarding_notice_workspace'), 'info');
    body.innerHTML=`
      <label class="onboarding-field">
        <span>${t('onboarding_workspace_label')}</span>
        <select id="onboardingWorkspaceSelect" onchange="syncOnboardingWorkspaceSelect(this.value)">${workspaceOptions}</select>
      </label>
      <label class="onboarding-field">
        <span>${t('onboarding_workspace_or_path')}</span>
        <input id="onboardingWorkspaceInput" value="${esc(ONBOARDING.form.workspace||'')}" placeholder="${t('onboarding_workspace_placeholder')}" oninput="ONBOARDING.form.workspace=this.value">
      </label>
      ${_renderOnboardingModelField()}`;
    const wsSel=$('onboardingWorkspaceSelect');
    if(wsSel && ONBOARDING.form.workspace) wsSel.value=ONBOARDING.form.workspace;
    const modelSel=$('onboardingModelSelect');
    if(modelSel && ONBOARDING.form.model) modelSel.value=ONBOARDING.form.model;
    return;
  }

  if(key==='password'){
    _setOnboardingNotice(settings.password_enabled?t('onboarding_notice_password_enabled'):t('onboarding_notice_password_recommended'), settings.password_enabled?'success':'info');
    body.innerHTML=`
      <label class="onboarding-field">
        <span>${t('onboarding_password_label')}</span>
        <input id="onboardingPasswordInput" type="password" value="${esc(ONBOARDING.form.password||'')}" placeholder="${t('onboarding_password_placeholder')}" oninput="ONBOARDING.form.password=this.value">
      </label>
      <p class="onboarding-copy">${t('onboarding_password_help')}</p>`;
    return;
  }

  const provider=_getOnboardingSetupProvider(ONBOARDING.form.provider);
  _setOnboardingNotice(t('onboarding_notice_finish'), 'success');
  body.innerHTML=`
    <div class="onboarding-summary">
      <div><strong>${t('onboarding_provider_label')}</strong><span>${esc((provider&&provider.label)||ONBOARDING.form.provider||t('onboarding_not_set'))}</span></div>
      <div><strong>${t('onboarding_model_label')}</strong><span>${esc(_getOnboardingSelectedModel()||t('onboarding_not_set'))}</span></div>
      <div><strong>${t('onboarding_workspace_label')}</strong><span>${esc(ONBOARDING.form.workspace||t('onboarding_not_set'))}</span></div>
      <div><strong>${t('onboarding_check_password')}</strong><span>${t(_getOnboardingPasswordSummaryKey(settings))}</span></div>
    </div>
    ${ONBOARDING.form.baseUrl?`<p class="onboarding-copy"><strong>${t('onboarding_base_url_label')}</strong> ${esc(ONBOARDING.form.baseUrl)}</p>`:''}
    <p class="onboarding-copy">${t('onboarding_finish_help')}</p>`;
}

function _getOnboardingPasswordSummaryKey(settings){
  const hasExistingPassword=!!(settings&&settings.password_enabled);
  const hasNewPassword=!!((ONBOARDING.form.password||'').trim());
  if(hasNewPassword) return hasExistingPassword?'onboarding_password_will_replace':'onboarding_password_will_enable';
  return hasExistingPassword?'onboarding_password_keep_existing':'onboarding_password_remains_disabled';
}

function syncOnboardingWorkspaceSelect(value){
  ONBOARDING.form.workspace=value;
  const input=$('onboardingWorkspaceInput');
  if(input) input.value=value;
}

// ── 详细提供商设置表单 ───────────────────────────────────────────────────────
// 在onboarding的setup步骤中渲染与"添加提供商"模态框一致的详细字段

function _renderOnboardingDetailedProviderForm(){
  const f=ONBOARDING.form;
  // 预设chips
  const presetChips=ONBOARDING.presets.map(p=>{
    const active=f.presetId===p.id;
    return `<button type="button" class="onboarding-preset-chip${active?' active':''}" data-preset="${esc(p.id)}" onclick="selectOnboardingPreset('${esc(p.id)}')" style="padding:4px 12px;border-radius:999px;border:1px solid ${active?'var(--accent)':'var(--border)'};background:${active?'var(--accent-bg)':'var(--bg-primary)'};color:${active?'var(--accent)':'var(--text)'};font-size:12px;cursor:pointer;transition:all .15s;">${esc(p.name)}</button>`;
  }).join('');
  return `
    <div class="onboarding-detailed-form">
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_preset')}</label>
        <div class="onboarding-preset-chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
          <button type="button" class="onboarding-preset-chip${f.presetId===''?' active':''}" data-preset="" onclick="selectOnboardingPreset('')" style="padding:4px 12px;border-radius:999px;border:1px solid ${f.presetId===''?'var(--accent)':'var(--border)'};background:${f.presetId===''?'var(--accent-bg)':'var(--bg-primary)'};color:${f.presetId===''?'var(--accent)':'var(--text)'};font-size:12px;cursor:pointer;transition:all .15s;">${t('providers_preset_custom')}</button>
          ${presetChips}
        </div>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_name')} <span style="color:var(--error)">*</span></label>
        <input id="onboardingProvName" type="text" value="${esc(f.provider||'')}" placeholder="e.g. deepseek" class="onboarding-input" oninput="ONBOARDING.form.provider=this.value">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_display_name')}</label>
        <input id="onboardingProvDisplayName" type="text" value="${esc(f.displayName||'')}" placeholder="e.g. DeepSeek" class="onboarding-input" oninput="ONBOARDING.form.displayName=this.value">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_base_url')}</label>
        <input id="onboardingProvBaseUrl" type="text" value="${esc(f.baseUrl||'')}" placeholder="https://api.example.com/v1" class="onboarding-input" oninput="ONBOARDING.form.baseUrl=this.value">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_api_key')}</label>
        <input id="onboardingProvApiKey" type="password" value="${esc(f.apiKey||'')}" placeholder="${t('providers_key_placeholder_new')}" class="onboarding-input" oninput="ONBOARDING.form.apiKey=this.value">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_api_format')}</label>
        <select id="onboardingProvApiFormat" class="onboarding-input" onchange="ONBOARDING.form.apiFormat=this.value">
          <option value="openai_chat"${f.apiFormat==='openai_chat'?' selected':''}>${t('providers_option_openai_chat')}</option>
          <option value="anthropic"${f.apiFormat==='anthropic'?' selected':''}>${t('providers_option_anthropic')}</option>
        </select>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_auth_strategy')}</label>
        <select id="onboardingProvAuthStrategy" class="onboarding-input" onchange="ONBOARDING.form.authStrategy=this.value">
          <option value="api_key"${f.authStrategy==='api_key'?' selected':''}>${t('providers_option_api_key')}</option>
          <option value="auth_token"${f.authStrategy==='auth_token'?' selected':''}>${t('providers_option_auth_token')}</option>
          <option value="auth_token_empty_api_key"${f.authStrategy==='auth_token_empty_api_key'?' selected':''}>${t('providers_option_auth_token_empty')}</option>
          <option value="dual_same_token"${f.authStrategy==='dual_same_token'?' selected':''}>${t('providers_option_dual_same')}</option>
          <option value="dual_dummy"${f.authStrategy==='dual_dummy'?' selected':''}>${t('providers_option_dual_dummy')}</option>
        </select>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_default_model')}</label>
        <input id="onboardingProvDefaultModel" type="text" value="${esc(f.defaultModel||'')}" placeholder="e.g. gpt-4o" class="onboarding-input" oninput="ONBOARDING.form.defaultModel=this.value;ONBOARDING.form.model=this.value">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-checkbox">
          <input id="onboardingProvSupportsVision" type="checkbox" ${f.supportsVision?'checked':''} style="width:16px;height:16px;cursor:pointer;" onchange="ONBOARDING.form.supportsVision=this.checked">
          <span>${t('providers_label_supports_vision')}</span>
        </label>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-checkbox">
          <input id="onboardingProvSupportsVoice" type="checkbox" ${f.supportsVoice?'checked':''} style="width:16px;height:16px;cursor:pointer;" onchange="ONBOARDING.form.supportsVoice=this.checked">
          <span>${t('providers_label_supports_voice')}</span>
        </label>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_model_mapping')} <span style="font-size:11px;color:var(--muted);">${t('providers_hint_model_mapping')}</span></label>
        <textarea id="onboardingProvModelMapping" rows="3" placeholder='{"main":"model-name","sonnet":"model-name"}' class="onboarding-input onboarding-input-mono" oninput="ONBOARDING.form.modelMapping=this.value">${esc(f.modelMapping||'')}</textarea>
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_model_context')}</label>
        <div id="onboardingProvModelContextList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="onboardingProvModelContextNewModel" type="text" placeholder="${t('providers_placeholder_model_id')||'model-id'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
          <input id="onboardingProvModelContextNewWindow" type="number" placeholder="${t('providers_placeholder_context_window')||'例如 200000'}" style="width:140px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
          <button type="button" id="onboardingProvModelContextAddBtn" style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;white-space:nowrap;">${t('providers_button_add_model')||'+ 添加'}</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <label style="font-size:12px;color:var(--muted);min-width:120px;">${t('providers_label_fallback_window')||'未知模型兜底窗口'}</label>
          <input id="onboardingProvModelContextFallback" type="number" placeholder="${t('providers_placeholder_fallback_window')||'可选，例如 200000'}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:4px;">${t('providers_hint_model_context_new')||'按每个模型的真实上下文填写，留空则走内置识别或默认 200K。'}</p>
        <input type="hidden" id="onboardingProvModelContext" value="${esc(f.modelContextWindows||'')}">
      </div>
      <div class="onboarding-field-group">
        <label class="onboarding-field-label">${t('providers_label_notes')}</label>
        <input id="onboardingProvNotes" type="text" value="${esc(f.notes||'')}" placeholder="${t('providers_placeholder_notes')}" class="onboarding-input" oninput="ONBOARDING.form.notes=this.value">
      </div>
      <div class="onboarding-field-actions" style="display:flex;gap:8px;margin-top:12px;">
        <button type="button" id="onboardingProvTestBtn" class="sm-btn" onclick="_testOnboardingProvider()" style="border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;">${t('providers_button_test')||'Test'}</button>
      </div>
      <div id="onboardingProvTestResult"></div>
    </div>
  `;
}

function _initOnboardingProviderForm(){
  // 异步加载预设列表
  if(!ONBOARDING._presetLoaded){
    ONBOARDING._presetLoaded=true;
    (async()=>{
      try{
        const data=await api('/api/providers/presets');
        ONBOARDING.presets=data.presets||[];
        _renderOnboardingBody();
      }catch(e){/* ignore */}
    })();
  }
  // 初始化模型上下文窗口动态列表
  _initOnboardingModelContextList();
}

function _initOnboardingModelContextList(){
  const ctxList=$('onboardingProvModelContextList');
  if(!ctxList) return;
  const ctxNewModel=$('onboardingProvModelContextNewModel');
  const ctxNewWindow=$('onboardingProvModelContextNewWindow');
  const ctxAddBtn=$('onboardingProvModelContextAddBtn');
  const ctxFallback=$('onboardingProvModelContextFallback');
  const ctxHidden=$('onboardingProvModelContext');
  if(!ctxList || !ctxAddBtn) return;

  // 解析现有配置
  let ctxMap={};
  let ctxFallbackVal='';
  try{
    const raw=(ONBOARDING.form.modelContextWindows||'').trim();
    if(raw){
      const parsed=JSON.parse(raw);
      if(typeof parsed==='object'){
        for(const k in parsed){
          if(k==='__fallback__'||k==='__default__'||k===''){
            ctxFallbackVal=String(parsed[k]);
          }else{
            ctxMap[k]=String(parsed[k]);
          }
        }
      }
    }
  }catch(_){}
  if(ctxFallbackVal) ctxFallback.value=ctxFallbackVal;

  // 渲染单个模型行
  function _renderRow(modelId, windowSize){
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;';
    const label=document.createElement('span');
    label.style.cssText='font-size:12px;color:var(--text-primary);min-width:180px;word-break:break-all;';
    label.textContent=modelId;
    const input=document.createElement('input');
    input.type='number';
    input.value=windowSize||'';
    input.placeholder=t('providers_placeholder_context_window')||'例如 200000';
    input.style.cssText='flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;';
    input.dataset.modelId=modelId;
    const delBtn=document.createElement('button');
    delBtn.type='button';
    delBtn.textContent='×';
    delBtn.title=t('providers_button_remove_model')||'移除';
    delBtn.style.cssText='padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    delBtn.onclick=()=>{row.remove();};
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(delBtn);
    return row;
  }

  // 初始化已有配置
  ctxList.innerHTML='';
  for(const mid of Object.keys(ctxMap)){
    ctxList.appendChild(_renderRow(mid, ctxMap[mid]));
  }

  // 添加模型按钮
  ctxAddBtn.onclick=()=>{
    const mid=ctxNewModel.value.trim();
    const win=ctxNewWindow.value.trim();
    if(!mid){ showToast(t('providers_error_model_id_required')||'请输入模型 ID'); return; }
    const existing=ctxList.querySelectorAll('input[data-model-id]');
    for(const inp of existing){
      if(inp.dataset.modelId===mid){
        showToast(t('providers_error_model_exists')||'该模型已存在');
        return;
      }
    }
    ctxList.appendChild(_renderRow(mid, win));
    ctxNewModel.value='';
    ctxNewWindow.value='';
    ctxNewModel.focus();
  };
  ctxNewWindow.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();ctxAddBtn.click();}};
  ctxNewModel.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();ctxNewWindow.focus();}};
}

function _syncOnboardingModelContext(){
  const ctxList=$('onboardingProvModelContextList');
  const ctxFallback=$('onboardingProvModelContextFallback');
  if(!ctxList) return;
  const result={};
  const inputs=ctxList.querySelectorAll('input[data-model-id]');
  for(const inp of inputs){
    const mid=inp.dataset.modelId;
    const val=inp.value.trim();
    if(mid && val){
      const num=parseInt(val,10);
      if(!isNaN(num) && num>0) result[mid]=num;
    }
  }
  if(ctxFallback){
    const fb=ctxFallback.value.trim();
    if(fb){
      const num=parseInt(fb,10);
      if(!isNaN(num) && num>0) result['__fallback__']=num;
    }
  }
  ONBOARDING.form.modelContextWindows=Object.keys(result).length>0?JSON.stringify(result):'';
}

function selectOnboardingPreset(presetId){
  ONBOARDING.form.presetId=presetId;
  const pr=ONBOARDING.presets.find(x=>x.id===presetId);
  if(pr&&presetId!==''){
    ONBOARDING.form.provider=pr.id||ONBOARDING.form.provider;
    ONBOARDING.form.displayName=pr.name||'';
    ONBOARDING.form.baseUrl=pr.base_url||'';
    ONBOARDING.form.apiFormat=pr.api_format||'openai_chat';
    ONBOARDING.form.authStrategy=pr.auth_strategy||'api_key';
    if(pr.default_models&&pr.default_models.main){
      ONBOARDING.form.defaultModel=pr.default_models.main;
      ONBOARDING.form.model=pr.default_models.main;
      ONBOARDING.form.modelMapping=JSON.stringify(pr.default_models);
    }
    if(pr.model_context_windows){
      try{ONBOARDING.form.modelContextWindows=JSON.stringify(pr.model_context_windows);}catch(_){}
    }
  }
  _renderOnboardingBody();
}

// 根据供应商返回的模型列表智能生成 main/sonnet/haiku/opus 映射
// 规则：按模型名关键字匹配角色，未匹配到的角色回退到第一个模型
function _buildModelMappingFromList(models){
  if(!Array.isArray(models)||!models.length) return null;
  const ids=[];
  for(const m of models){
    const id=(m&&(m.id||m.label))||'';
    if(id&&!ids.includes(id)) ids.push(id);
  }
  if(!ids.length) return null;
  const haikuKeys=['haiku','flash','mini','nano','small','lite','tiny','8k','8K'];
  const sonnetKeys=['sonnet','chat','standard','medium','32k','32K'];
  const opusKeys=['opus','pro','max','large','plus','ultra','128k','128K'];
  let haikuModel='',sonnetModel='',opusModel='';
  for(const id of ids){
    const lower=String(id).toLowerCase();
    if(!haikuModel&&haikuKeys.some(k=>lower.includes(k.toLowerCase()))) haikuModel=id;
    else if(!sonnetModel&&sonnetKeys.some(k=>lower.includes(k.toLowerCase()))) sonnetModel=id;
    else if(!opusModel&&opusKeys.some(k=>lower.includes(k.toLowerCase()))) opusModel=id;
  }
  const main=ids[0];
  return {
    main:main,
    sonnet:sonnetModel||main,
    haiku:haikuModel||sonnetModel||main,
    opus:opusModel||main
  };
}

// 根据模型列表构建上下文窗口 map，从预设中查找已知模型的窗口大小
function _buildContextWindowsFromList(models,presetId){
  const ctx={};
  const presetMap={};
  if(presetId){
    const pr=ONBOARDING.presets.find(x=>x.id===presetId);
    if(pr&&pr.model_context_windows&&typeof pr.model_context_windows==='object'){
      for(const k in pr.model_context_windows) presetMap[k]=pr.model_context_windows[k];
    }
  }
  if(Array.isArray(models)){
    for(const m of models){
      const id=(m&&(m.id||m.label))||'';
      if(!id) continue;
      if(presetMap[id]){
        const num=parseInt(presetMap[id],10);
        if(!isNaN(num)&&num>0) ctx[id]=num;
      }
    }
  }
  return ctx;
}

// 将测试获取的模型列表填充到模型映射 textarea 和上下文窗口列表
function _applyProbedModelsToForm(models){
  if(!Array.isArray(models)||!models.length) return;
  // 1. 更新模型映射
  const mapping=_buildModelMappingFromList(models);
  if(mapping){
    ONBOARDING.form.modelMapping=JSON.stringify(mapping);
    const ta=$('onboardingProvModelMapping');
    if(ta) ta.value=ONBOARDING.form.modelMapping;
  }
  // 2. 更新上下文窗口
  const ctx=_buildContextWindowsFromList(models,ONBOARDING.form.presetId);
  ONBOARDING.form.modelContextWindows=Object.keys(ctx).length>0?JSON.stringify(ctx):'';
  const hidden=$('onboardingProvModelContext');
  if(hidden) hidden.value=ONBOARDING.form.modelContextWindows;
  // 3. 重新渲染上下文窗口列表（复用 _initOnboardingModelContextList）
  _initOnboardingModelContextList();
  // 4. 若未选模型，默认选第一个
  if(!ONBOARDING.form.model){
    ONBOARDING.form.model=models[0].id||models[0].label||'';
    const modelInput=$('onboardingModelInput');
    if(modelInput) modelInput.value=ONBOARDING.form.model;
  }
}

async function _testOnboardingProvider(){
  const f=ONBOARDING.form;
  const baseURL=(f.baseUrl||'').trim();
  if(!baseURL){showToast(t('providers_test_base_url_required')||'Base URL is required for testing',null,'error');return;}
  const btn=$('onboardingProvTestBtn');
  if(btn){btn.disabled=true;btn.textContent=t('providers_testing')||'Testing...';}
  try{
    const res=await api('/api/providers/test',{method:'POST',body:JSON.stringify({
      provider:f.provider||'custom',
      base_url:baseURL,
      api_key:f.apiKey,
      api_format:f.apiFormat
    })});
    const resultEl=$('onboardingProvTestResult');
    if(res.ok&&res.reachable){
      const models=Array.isArray(res.models)?res.models:[];
      showToast((t('providers_test_ok')||'Connection OK — ')+(models.length+' '+(t('providers_test_models_found')||'models found')),null,'success');
      if(resultEl)resultEl.innerHTML=`<p class="onboarding-copy" style="color:var(--success);">${t('providers_test_ok')||'Connection OK'} — ${models.length} ${t('providers_test_models_found')||'models found'}</p>`;
      // 自动填充模型映射和上下文窗口列表
      if(models.length>0){
        _applyProbedModelsToForm(models);
      }
    }else{
      showToast((t('providers_test_failed')||'Connection failed')+': '+(res.error||(t('providers_test_unknown')||'Unknown error')),null,'error');
      if(resultEl)resultEl.innerHTML=`<p class="onboarding-copy" style="color:var(--error);">${t('providers_test_failed')||'Connection failed'}: ${esc(res.error||(t('providers_test_unknown')||'Unknown error'))}</p>`;
    }
  }catch(e){
    showToast((t('providers_test_error')||'Test error')+': '+(e.message||String(e)),null,'error');
    const resultEl=$('onboardingProvTestResult');
    if(resultEl)resultEl.innerHTML=`<p class="onboarding-copy" style="color:var(--error);">${t('providers_test_error')||'Test error'}: ${esc(e.message||String(e))}</p>`;
  }finally{
    if(btn){btn.disabled=false;btn.textContent=t('providers_button_test')||'Test';}
  }
}

function syncOnboardingProvider(value){
  const provider=_getOnboardingSetupProvider(value);
  ONBOARDING.form.provider=value;
  if(provider){
    if(!ONBOARDING.form.model || !_getOnboardingProviderModelChoices().some(m=>m.id===ONBOARDING.form.model) || value==='custom'){
      ONBOARDING.form.model=provider.default_model||'';
    }
    if(provider.requires_base_url){
      ONBOARDING.form.baseUrl=ONBOARDING.form.baseUrl||provider.default_base_url||'';
    }else{
      ONBOARDING.form.baseUrl=provider.default_base_url||'';
    }
  }
  _renderOnboardingBody();
}

async function loadOnboardingWizard(){
  try{
    const status=await api('/api/onboarding/status');
    ONBOARDING.status=status;
    const current=((status.setup||{}).current)||{};
    ONBOARDING.form.provider=current.provider||'openrouter';
    ONBOARDING.form.workspace=(status.workspaces&&status.workspaces.last)||status.settings.default_workspace||'';
    ONBOARDING.form.model=status.settings.default_model||current.model||'';
    ONBOARDING.form.password='';
    ONBOARDING.form.apiKey='';
    ONBOARDING.form.baseUrl=current.base_url||'';
    ONBOARDING.active=!status.completed;
    if(!ONBOARDING.active) return false;
    $('onboardingOverlay').style.display='flex';
    _renderOnboardingSteps();
    _renderOnboardingBody();
    return true;
  }catch(e){
    console.warn('onboarding status failed',e);
    return false;
  }
}

function prevOnboardingStep(){
  if(ONBOARDING.step===0)return;
  ONBOARDING.step--;
  _renderOnboardingSteps();
  _renderOnboardingBody();
}

async function _saveOnboardingProviderSetup(){
  const f=ONBOARDING.form;
  const provider=(f.provider||'').trim();
  const model=(f.model||'').trim();
  const apiKey=(f.apiKey||'').trim();
  const baseUrl=(f.baseUrl||'').trim();
  const displayName=(f.displayName||'').trim();
  const apiFormat=f.apiFormat||'openai_chat';
  const authStrategy=f.authStrategy||'api_key';
  const defaultModel=(f.defaultModel||'').trim();
  const modelMapping=(f.modelMapping||'').trim();
  // 同步动态模型上下文窗口到 form
  _syncOnboardingModelContext();
  const modelContextWindows=(f.modelContextWindows||'').trim();
  const notes=(f.notes||'').trim();
  const presetId=f.presetId||'';
  const supportsVision=!!f.supportsVision;
  const supportsVoice=!!f.supportsVoice;
  if(!provider) return;
  // 验证JSON字段
  if(modelMapping){try{JSON.parse(modelMapping);}catch(e){throw new Error(t('providers_error_model_mapping_json')||'Model Mapping must be valid JSON');}}
  if(modelContextWindows){try{JSON.parse(modelContextWindows);}catch(e){throw new Error(t('providers_error_model_context_json')||'Model Context Windows must be valid JSON');}}
  // 调用 /api/providers POST 保存提供商（与添加提供商模态框一致）
  const body={
    provider,
    display_name: displayName||provider,
    base_url: baseUrl,
    api_key: apiKey,
    api_format: apiFormat,
    auth_strategy: authStrategy,
    default_model: defaultModel,
    supports_vision: supportsVision,
    supports_voice: supportsVoice,
    model_mapping: modelMapping,
    model_context_windows: modelContextWindows,
    preset_id: presetId,
    notes: notes,
  };
  // /api/providers 为 upsert 语义（不存在则创建，存在则更新），单次调用即可
  // 后端 Rg_SheZhiGongYingShang 在 p.ID==0 时自动新建，否则更新现有记录
  await api('/api/providers',{method:'POST',body:JSON.stringify(body)});
  // 保存默认模型设置
  if(model){
    try{localStorage.setItem('voldp-ai-agent-model',model);}catch{}
  }
  // 仍然调用 onboarding/setup 以保持状态同步
  try{
    const obBody={provider,model};
    if(apiKey) obBody.api_key=apiKey;
    if(baseUrl) obBody.base_url=baseUrl;
    const status=await api('/api/onboarding/setup',{method:'POST',body:JSON.stringify(obBody)});
    ONBOARDING.status=status;
  }catch(_){/* onboarding/setup 失败不影响流程 */}
}

async function _saveOnboardingDefaults(){
  const workspace=(ONBOARDING.form.workspace||'').trim();
  const model=(ONBOARDING.form.model||'').trim();
  const password=(ONBOARDING.form.password||'').trim();
  if(!workspace) throw new Error(t('onboarding_error_choose_workspace'));
  if(!model) throw new Error(t('onboarding_error_choose_model'));
  const known=_getOnboardingWorkspaceChoices().some(ws=>ws.path===workspace);
  if(!known){
    await api('/api/workspaces/add',{method:'POST',body:JSON.stringify({path:workspace})});
  }
  // Model persisted by /api/onboarding/setup — no /api/default-model call needed here
  const body={default_workspace:workspace};
  if(password) body._set_password=password;
  const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(body)});
  if(ONBOARDING.status){
    ONBOARDING.status.settings={...(ONBOARDING.status.settings||{}),password_enabled:!!saved.auth_enabled};
  }
  try{localStorage.setItem('voldp-ai-agent-model',model)}catch{}
  if($('modelSelect')) _applyModelToDropdown(model,$('modelSelect'));
}

async function _finishOnboarding(){
  await _saveOnboardingProviderSetup();
  await _saveOnboardingDefaults();
  const done=await api('/api/onboarding/complete',{method:'POST',body:'{}'});
  ONBOARDING.status=done;
  ONBOARDING.active=false;
  $('onboardingOverlay').style.display='none';
  showToast(t('onboarding_complete'));
  await loadWorkspaceList();
  if(typeof renderSessionList==='function') await renderSessionList();
  if(!S.session && typeof newSession==='function'){
    await newSession(true);
    await renderSessionList();
  }
}

async function skipOnboarding(){
  try{
    // Mark onboarding completed server-side without changing any config
    await api('/api/onboarding/complete',{method:'POST',body:'{}'});
    ONBOARDING.active=false;
    $('onboardingOverlay').style.display='none';
    showToast(t('onboarding_skipped')||'Setup skipped');
  }catch(e){
    _setOnboardingNotice((e.message||String(e)),'warn');
  }
}

async function nextOnboardingStep(){
  try{
    if(ONBOARDING.steps[ONBOARDING.step]==='setup'){
      // 从详细表单字段读取值
      const nameEl=$('onboardingProvName');
      const displayEl=$('onboardingProvDisplayName');
      const baseUrlEl=$('onboardingProvBaseUrl');
      const apiKeyEl=$('onboardingProvApiKey');
      const apiFormatEl=$('onboardingProvApiFormat');
      const authStrategyEl=$('onboardingProvAuthStrategy');
      const defaultModelEl=$('onboardingProvDefaultModel');
      const modelMappingEl=$('onboardingProvModelMapping');
      const modelContextEl=$('onboardingProvModelContext');
      const notesEl=$('onboardingProvNotes');
      const visionEl=$('onboardingProvSupportsVision');
      const voiceEl=$('onboardingProvSupportsVoice');
      if(nameEl) ONBOARDING.form.provider=nameEl.value.trim();
      if(displayEl) ONBOARDING.form.displayName=displayEl.value.trim();
      if(baseUrlEl) ONBOARDING.form.baseUrl=baseUrlEl.value.trim();
      if(apiKeyEl) ONBOARDING.form.apiKey=apiKeyEl.value.trim();
      if(apiFormatEl) ONBOARDING.form.apiFormat=apiFormatEl.value;
      if(authStrategyEl) ONBOARDING.form.authStrategy=authStrategyEl.value;
      if(defaultModelEl){
        ONBOARDING.form.defaultModel=defaultModelEl.value.trim();
        ONBOARDING.form.model=defaultModelEl.value.trim();
      }
      if(modelMappingEl) ONBOARDING.form.modelMapping=modelMappingEl.value.trim();
      if(modelContextEl) ONBOARDING.form.modelContextWindows=modelContextEl.value.trim();
      if(notesEl) ONBOARDING.form.notes=notesEl.value.trim();
      if(visionEl) ONBOARDING.form.supportsVision=visionEl.checked;
      if(voiceEl) ONBOARDING.form.supportsVoice=voiceEl.checked;
      if(!ONBOARDING.form.provider) throw new Error(t('onboarding_error_provider_required')||'Provider name is required');
      // 验证JSON字段
      if(ONBOARDING.form.modelMapping){
        try{JSON.parse(ONBOARDING.form.modelMapping);}
        catch(e){throw new Error(t('providers_error_model_mapping_json')||'Model Mapping must be valid JSON');}
      }
      if(ONBOARDING.form.modelContextWindows){
        try{JSON.parse(ONBOARDING.form.modelContextWindows);}
        catch(e){throw new Error(t('providers_error_model_context_json')||'Model Context Windows must be valid JSON');}
      }
    }
    if(ONBOARDING.steps[ONBOARDING.step]==='workspace'){
      ONBOARDING.form.workspace=(($('onboardingWorkspaceInput')||{}).value||ONBOARDING.form.workspace||'').trim();
      ONBOARDING.form.model=(($('onboardingModelInput')||{}).value||($('onboardingModelSelect')||{}).value||ONBOARDING.form.model||'').trim();
      if(!ONBOARDING.form.workspace) throw new Error(t('onboarding_error_workspace_required'));
      if(!ONBOARDING.form.model) throw new Error(t('onboarding_error_model_required'));
    }
    if(ONBOARDING.steps[ONBOARDING.step]==='password'){
      ONBOARDING.form.password=(($('onboardingPasswordInput')||{}).value||'').trim();
    }
    if(ONBOARDING.step===ONBOARDING.steps.length-1){
      await _finishOnboarding();
      return;
    }
    ONBOARDING.step++;
    _renderOnboardingSteps();
    _renderOnboardingBody();
  }catch(e){
    _setOnboardingNotice(e.message||String(e),'warn');
  }
}

/* ── Codex OAuth device-code flow ── */
let _codexOAuthPollTimer=null;
let _codexOAuthFlowId=null;

function _clearCodexOAuthPoll(){
  if(_codexOAuthPollTimer){clearTimeout(_codexOAuthPollTimer);_codexOAuthPollTimer=null;}
}

function _setCodexOAuthButton(enabled){
  const btn=$('codexOAuthBtn');
  if(btn){btn.disabled=!enabled;btn.textContent=enabled?t('oauth_login_codex'):'...';}
}

async function copyCodexOAuthCode(code){
  try{
    await navigator.clipboard.writeText(code||'');
    showToast('Code copied');
  }catch(e){
    showToast(code||'');
  }
}

async function cancelCodexOAuth(){
  const flowDiv=$('codexOAuthFlow');
  const flowId=_codexOAuthFlowId;
  _clearCodexOAuthPoll();
  _codexOAuthFlowId=null;
  if(flowId){
    try{await api('/api/onboarding/oauth/cancel',{method:'POST',body:JSON.stringify({flow_id:flowId})});}catch(e){}
  }
  _setCodexOAuthButton(true);
  if(flowDiv){
    flowDiv.innerHTML=`<div class="onboarding-oauth-card"><div class="onboarding-oauth-icon">⏹</div><div><strong>OAuth login cancelled</strong><p style="margin-top:6px;color:var(--muted);font-size:13px">Start again whenever you're ready.</p></div></div>`;
  }
}

function _renderCodexOAuthTerminal(status,message){
  const flowDiv=$('codexOAuthFlow');
  if(!flowDiv)return;
  const ok=status==='success';
  const icon=ok?'✅':status==='expired'?'⌛':status==='cancelled'?'⏹':'❌';
  const title=ok?t('oauth_codex_success'):(status==='expired'?t('oauth_codex_expired'):(status==='cancelled'?'OAuth login cancelled':t('oauth_codex_error')));
  flowDiv.innerHTML=`
    <div class="onboarding-oauth-card ${ok?'onboarding-oauth-ready':''}" ${ok?'':'style="border-color:var(--error,#e55)"'}>
      <div class="onboarding-oauth-icon">${icon}</div>
      <div><strong>${title}</strong><p style="margin-top:6px;color:var(--muted);font-size:13px">${esc(message||'')}</p></div>
    </div>`;
}

async function _pollCodexOAuth(){
  const flowId=_codexOAuthFlowId;
  if(!flowId)return;
  try{
    const resp=await api('/api/onboarding/oauth/poll?flow_id='+encodeURIComponent(flowId));
    const status=(resp&&resp.status)||'error';
    if(status==='pending'){
      _codexOAuthPollTimer=setTimeout(_pollCodexOAuth,3000);
      return;
    }
    _clearCodexOAuthPoll();
    _codexOAuthFlowId=null;
    _setCodexOAuthButton(true);
    if(status==='success'){
      _renderCodexOAuthTerminal('success','Credentials saved to the Hermes credential pool. Refreshing provider status…');
      showToast(t('oauth_codex_success'));
      try{await loadOnboardingWizard();}catch(e){}
    }else if(status==='expired'){
      _renderCodexOAuthTerminal('expired','The code expired. Start a new login flow to try again.');
    }else if(status==='cancelled'){
      _renderCodexOAuthTerminal('cancelled','The login flow was cancelled.');
    }else{
      _renderCodexOAuthTerminal('error',(resp&&resp.error)||'OAuth login failed. Please try again.');
    }
  }catch(e){
    _clearCodexOAuthPoll();
    _codexOAuthFlowId=null;
    _setCodexOAuthButton(true);
    _renderCodexOAuthTerminal('error',(e&&e.message)||String(e));
  }
}

async function startCodexOAuth(){
  const flowDiv=$('codexOAuthFlow');
  if(!flowDiv)return;
  _clearCodexOAuthPoll();
  _codexOAuthFlowId=null;
  _setCodexOAuthButton(false);
  flowDiv.style.display='block';
  flowDiv.innerHTML=`<div class="onboarding-oauth-card onboarding-oauth-pending"><div class="onboarding-oauth-icon">⏳</div><div><strong>${t('oauth_codex_polling')}</strong><p>Starting device-code flow…</p></div></div>`;
  try{
    const resp=await api('/api/onboarding/oauth/start',{method:'POST',body:JSON.stringify({provider:'openai-codex'})});
    if(resp.error) throw new Error(resp.error);
    const{flow_id,user_code,verification_uri}=resp;
    if(!flow_id||!user_code||!verification_uri) throw new Error('Invalid OAuth response');
    _codexOAuthFlowId=flow_id;
    flowDiv.innerHTML=`
      <div class="onboarding-oauth-card onboarding-oauth-pending">
        <div class="onboarding-oauth-icon">📋</div>
        <div style="flex:1">
          <strong>${t('oauth_codex_step1')}</strong>
          <p><a href="${esc(verification_uri)}" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">${esc(verification_uri)}</a></p>
          <p style="margin-top:8px"><strong>${t('oauth_codex_step2')}</strong></p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
            <code style="display:inline-block;font-size:18px;letter-spacing:0.1em;background:rgba(255,255,255,.08);padding:6px 14px;border-radius:8px;user-select:all">${esc(user_code)}</code>
            <button class="sm-btn" type="button" onclick="copyCodexOAuthCode('${esc(user_code)}')">Copy code</button>
            <button class="sm-btn" type="button" onclick="cancelCodexOAuth()">Cancel</button>
          </div>
          <p style="margin-top:8px;color:var(--muted);font-size:13px">${t('oauth_codex_polling')}</p>
        </div>
      </div>`;
    _codexOAuthPollTimer=setTimeout(_pollCodexOAuth,Math.max(1000,Number(resp.poll_interval_seconds||3)*1000));
  }catch(e){
    _clearCodexOAuthPoll();
    _codexOAuthFlowId=null;
    _renderCodexOAuthTerminal('error',(e&&e.message)||String(e));
    _setCodexOAuthButton(true);
  }
}

/* ── Anthropic / Claude Code credential-link flow ── */
let _anthropicOAuthPollTimer=null;
let _anthropicOAuthFlowId=null;

function _clearAnthropicOAuthPoll(){
  if(_anthropicOAuthPollTimer){clearTimeout(_anthropicOAuthPollTimer);_anthropicOAuthPollTimer=null;}
}

function _setAnthropicOAuthButton(enabled){
  const btn=$('anthropicOAuthBtn');
  if(btn){btn.disabled=!enabled;btn.textContent=enabled?'Login with Claude Code':'...';}
}

async function cancelAnthropicOAuth(){
  const flowDiv=$('anthropicOAuthFlow');
  const flowId=_anthropicOAuthFlowId;
  _clearAnthropicOAuthPoll();
  _anthropicOAuthFlowId=null;
  if(flowId){
    try{await api('/api/onboarding/oauth/cancel',{method:'POST',body:JSON.stringify({flow_id:flowId,provider:'anthropic'})});}catch(e){}
  }
  _setAnthropicOAuthButton(true);
  if(flowDiv){
    flowDiv.innerHTML=`<div class="onboarding-oauth-card"><div class="onboarding-oauth-icon">⏹</div><div><strong>Claude Code OAuth cancelled</strong><p style="margin-top:6px;color:var(--muted);font-size:13px">Start again whenever you're ready.</p></div></div>`;
  }
}

function _renderAnthropicOAuthTerminal(status,message){
  const flowDiv=$('anthropicOAuthFlow');
  if(!flowDiv)return;
  const ok=status==='success';
  const icon=ok?'✅':status==='expired'?'⌛':status==='cancelled'?'⏹':'❌';
  const title=ok?'Claude Code OAuth linked':(status==='expired'?'Claude Code polling expired':(status==='cancelled'?'Claude Code OAuth cancelled':'Claude Code OAuth failed'));
  flowDiv.style.display='block';
  flowDiv.innerHTML=`
    <div class="onboarding-oauth-card ${ok?'onboarding-oauth-ready':''}" ${ok?'':'style="border-color:var(--error,#e55)"'}>
      <div class="onboarding-oauth-icon">${icon}</div>
      <div><strong>${title}</strong><p style="margin-top:6px;color:var(--muted);font-size:13px">${esc(message||'')}</p></div>
    </div>`;
}

async function _pollAnthropicOAuth(){
  const flowId=_anthropicOAuthFlowId;
  if(!flowId)return;
  try{
    const resp=await api('/api/onboarding/oauth/poll?flow_id='+encodeURIComponent(flowId));
    const status=(resp&&resp.status)||'error';
    if(status==='pending'){
      _anthropicOAuthPollTimer=setTimeout(_pollAnthropicOAuth,3000);
      return;
    }
    _clearAnthropicOAuthPoll();
    _anthropicOAuthFlowId=null;
    _setAnthropicOAuthButton(true);
    if(status==='success'){
      _renderAnthropicOAuthTerminal('success','Hermes is now linked to Claude Code credentials. Refreshing provider status…');
      showToast('Claude Code OAuth linked');
      try{await loadOnboardingWizard();}catch(e){}
    }else if(status==='expired'){
      _renderAnthropicOAuthTerminal('expired','Claude Code credentials were not detected before this flow expired. Start a new flow to try again.');
    }else if(status==='cancelled'){
      _renderAnthropicOAuthTerminal('cancelled','The login flow was cancelled.');
    }else{
      _renderAnthropicOAuthTerminal('error',(resp&&resp.error)||'Claude Code OAuth linking failed. Please try again.');
    }
  }catch(e){
    _clearAnthropicOAuthPoll();
    _anthropicOAuthFlowId=null;
    _setAnthropicOAuthButton(true);
    _renderAnthropicOAuthTerminal('error',(e&&e.message)||String(e));
  }
}

async function startAnthropicOAuth(){
  const flowDiv=$('anthropicOAuthFlow');
  if(!flowDiv)return;
  _clearAnthropicOAuthPoll();
  _anthropicOAuthFlowId=null;
  _setAnthropicOAuthButton(false);
  flowDiv.style.display='block';
  flowDiv.innerHTML=`<div class="onboarding-oauth-card onboarding-oauth-pending"><div class="onboarding-oauth-icon">⏳</div><div><strong>Checking Claude Code credentials…</strong><p>Hermes is checking for existing Claude Code OAuth credentials on this server.</p></div></div>`;
  try{
    const resp=await api('/api/onboarding/oauth/start',{method:'POST',body:JSON.stringify({provider:'anthropic'})});
    if(resp.error) throw new Error(resp.error);
    const{flow_id,status,action_required}=resp;
    if(!flow_id) throw new Error('Invalid OAuth response');
    _anthropicOAuthFlowId=flow_id;
    if(status==='success'){
      _clearAnthropicOAuthPoll();
      _anthropicOAuthFlowId=null;
      _setAnthropicOAuthButton(true);
      _renderAnthropicOAuthTerminal('success','Hermes is now linked to Claude Code credentials. Refreshing provider status…');
      showToast('Claude Code OAuth linked');
      try{await loadOnboardingWizard();}catch(e){}
      return;
    }
    flowDiv.innerHTML=`
      <div class="onboarding-oauth-card onboarding-oauth-pending">
        <div class="onboarding-oauth-icon">🖥️</div>
        <div style="flex:1">
          <strong>Complete Claude Code login on this host</strong>
          <p style="margin-top:6px">${esc(action_required||"Run 'claude setup-token' on the server, then return here. Hermes will detect the credential automatically.")}</p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
            <code style="display:inline-block;background:rgba(255,255,255,.08);padding:6px 10px;border-radius:8px;user-select:all">claude setup-token</code>
            <button class="sm-btn" type="button" onclick="cancelAnthropicOAuth()">Cancel</button>
          </div>
          <p style="margin-top:8px;color:var(--muted);font-size:13px">Waiting for Claude Code credentials...</p>
        </div>
      </div>`;
    _anthropicOAuthPollTimer=setTimeout(_pollAnthropicOAuth,Math.max(1000,Number(resp.poll_interval_seconds||3)*1000));
  }catch(e){
    _clearAnthropicOAuthPoll();
    _anthropicOAuthFlowId=null;
    _renderAnthropicOAuthTerminal('error',(e&&e.message)||String(e));
    _setAnthropicOAuthButton(true);
  }
}
