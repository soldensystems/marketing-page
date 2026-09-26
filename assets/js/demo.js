
  (function(){
    var form=document.getElementById('demoForm');
    var done=document.getElementById('doneState');
    var msg=document.getElementById('doneMsg');
    if(!form)return;
    var btn=form.querySelector('.submit');
    var errEl=document.getElementById('formStatus');
    var fields=document.getElementById('demoFields');
    var interestEl=document.getElementById('interestContext');
    var ctxLabel=document.getElementById('ctxLabel');
    var financeJobLabels={
      'accounts-payable':'Accounts payable',
      'accounts-receivable':'Accounts receivable',
      'cash-treasury':'Cash & treasury',
      'fpa-reporting':'FP&A & reporting',
      'audit-compliance':'Audit & compliance'
    };
    var useCaseLabels={
      'team-capacity':'Finance team at capacity',
      'close-across-systems':'Close spread across systems',
      'multiple-entities':'Multiple entities or scopes',
      'scattered-audit-evidence':'Audit evidence is scattered',
      'staff-changes':'Staff changes disrupt the close'
    };
    function queryValue(name){
      var search=(window.location&&window.location.search)||'';
      var match=search.match(new RegExp('(?:[?&])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^&]*)'));
      if(!match)return '';
      try{
        return decodeURIComponent(match[1].replace(/\+/g,' '));
      }catch(error){
        return '';
      }
    }
    var financeJob=financeJobLabels[queryValue('finance_job')]||'';
    var useCase=useCaseLabels[queryValue('use_case')]||'';
    if(interestEl&&(financeJob||useCase)){
      interestEl.textContent=financeJob?('You are asking about '+financeJob+'.'):('You are asking about: '+useCase+'.');
      interestEl.hidden=false;
    }
    if(ctxLabel&&financeJob)ctxLabel.textContent='What recurring outcome would you want Solden to own in '+financeJob.toLowerCase()+'?';
    if(ctxLabel&&useCase)ctxLabel.textContent='What is making this finance work hard for your team?';
    function newSubmissionId(){
      if(window.crypto&&typeof window.crypto.randomUUID==='function')return window.crypto.randomUUID();
      var bytes=new Uint8Array(16); window.crypto.getRandomValues(bytes);
      bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
      var hex=Array.prototype.map.call(bytes,function(b){return b.toString(16).padStart(2,'0');}).join('');
      return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    }
    var submissionId=newSubmissionId();
    function showError(text){
      errEl.textContent=text;
    }
    function setBusy(busy){
      form.setAttribute('aria-busy',String(busy));
      btn.setAttribute('aria-busy',String(busy));
    }
    function val(id){var el=document.getElementById(id);return el?(el.value||'').trim():'';}
    form.addEventListener('submit',function(e){
      e.preventDefault();
      if(!form.checkValidity()){form.reportValidity();return;}
      var fn=val('fname'), ln=val('lname'), email=val('email');
      var team=val('team'), ctx=val('ctx');
      var parts=[];
      if(financeJob)parts.push('Finance job interest: '+financeJob);
      if(useCase)parts.push('Use case: '+useCase);
      if(team)parts.push('Team size: '+team);
      if(ctx)parts.push('Workflow to hold: '+ctx);
      var payload={
        name:(fn+' '+ln).trim(),
        email:email,
        company:val('company'),
        role:val('role'),
        topic:'demo',
        message:parts.join('\n\n'),
        company_website:val('company_website'),
        submission_id:submissionId
      };
      if(errEl)errEl.textContent='';
      var label=btn.innerHTML; btn.disabled=true; setBusy(true); btn.textContent='Sending…';
      fetch('/api/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
        .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
        .then(function(d){
          setBusy(false);
          if(d&&d.ok&&d.email==='accepted'&&d.internal_email==='accepted'&&d.prospect_email==='accepted'){
            msg.textContent='Thanks'+(fn?(', '+fn):'')+'. We’ve sent a confirmation to '+email+' and will reach out to set up your session.';
            form.style.display='none';
            done.classList.add('show');
            done.focus({preventScroll:true});
            done.scrollIntoView({block:'nearest'});
          }else if(d&&d.request_received){
            btn.innerHTML=label;
            var terminal=d.email==='failed'||d.error==='email_delivery_failed'||d.terminal===true;
            if(terminal){
              btn.disabled=true;
              showError('Your request is recorded, but we could not send the required email. Please email hello@soldenai.com so we can follow up.');
            }else if(d.dev&&d.automatic_retry===false){
              btn.disabled=false;
              showError('Your request is recorded, but email delivery is not complete. Try again to resend with the same request ID; it will not create a duplicate.');
            }else if(d.automatic_retry===true){
              btn.disabled=true;
              if(d.prospect_email==='accepted'){
                showError('Your request is recorded and the confirmation email has been sent to '+email+'. The remaining email is scheduled for automatic retry; you do not need to submit again.');
              }else{
                showError('Your request is recorded, but the confirmation email is delayed. Delivery is scheduled for automatic retry; you do not need to submit again.');
              }
            }else{
              btn.disabled=false;
              showError('Your request is recorded, but email delivery is not complete. Please try again with the same request, or email hello@soldenai.com.');
            }
          }else{
            btn.disabled=false; btn.innerHTML=label;
            showError('Something went wrong sending that. Please try again, or email hello@soldenai.com.');
          }
        })
        .catch(function(){
          setBusy(false);
          btn.disabled=false; btn.innerHTML=label;
          showError('We could not confirm the result. Please try again; your request and emails will not be duplicated.');
        });
    });
    if(fields)fields.disabled=false;
    document.documentElement.classList.add('js-ready');
    document.documentElement.classList.remove('no-js');
    document.documentElement.classList.add('js');
  })();
