document.documentElement.classList.remove('no-js');
document.documentElement.classList.add('js');

const navigationAssets = Object.freeze({
  accountsPayable: '/assets/icons/solden-nav-accounts-payable.svg',
  accountsReceivable: '/assets/icons/solden-nav-accounts-receivable.svg',
  cashTreasury: '/assets/icons/solden-nav-cash-treasury.svg',
  fpaReporting: '/assets/icons/solden-nav-fpa-reporting.svg',
  auditCompliance: '/assets/icons/solden-nav-audit-compliance.svg',
  teamCapacity: '/assets/icons/solden-nav-team-capacity.svg',
  closeSystems: '/assets/icons/solden-nav-close-systems.svg',
});

const financeJobs = Object.freeze([
  { label: 'Accounts payable', value: 'accounts-payable', icon: navigationAssets.accountsPayable },
  { label: 'Accounts receivable', value: 'accounts-receivable', icon: navigationAssets.accountsReceivable },
  { label: 'Cash & treasury', value: 'cash-treasury', icon: navigationAssets.cashTreasury },
  { label: 'FP&A & reporting', value: 'fpa-reporting', icon: navigationAssets.fpaReporting },
  { label: 'Audit & compliance', value: 'audit-compliance', icon: navigationAssets.auditCompliance },
]);

const useCases = Object.freeze([
  { label: 'Finance team at capacity', description: 'Recurring close work is consuming the team.', value: 'team-capacity', icon: navigationAssets.teamCapacity },
  { label: 'Close spread across systems', description: 'ERP, bank data and schedules do not stay aligned.', value: 'close-across-systems', icon: navigationAssets.closeSystems },
  { label: 'Multiple entities or scopes', description: 'Every close adds more handoffs and control paths.', value: 'multiple-entities', icon: navigationAssets.cashTreasury },
  { label: 'Audit evidence is scattered', description: 'Support is assembled after the work is done.', value: 'scattered-audit-evidence', icon: navigationAssets.accountsPayable },
  { label: 'Staff changes disrupt the close', description: 'Process knowledge lives with individual people.', value: 'staff-changes', icon: navigationAssets.accountsReceivable },
]);

function iconBadge(source) {
  return `<span class="nav-icon-badge" aria-hidden="true"><img src="${source}" width="18" height="18" alt="" /></span>`;
}

function financeJobLinks(className = 'finance-job-link') {
  return financeJobs.map((job) => `<a class="${className}" href="/request-demo?finance_job=${job.value}">
    ${iconBadge(job.icon)}<span>${job.label}</span>
  </a>`).join('');
}

function useCaseLinks(className = 'use-case-link') {
  return useCases.map((useCase) => `<a class="${className}" href="/request-demo?use_case=${useCase.value}">
    ${iconBadge(useCase.icon)}
    <span><strong>${useCase.label}</strong><small>${useCase.description}</small></span>
  </a>`).join('');
}

function desktopFinanceJobsMarkup() {
  return `<div class="mega-menu-heading">
      <h2>Give Solden a finance responsibility</h2>
      <p>Solden owns execution through verified completion.</p>
    </div>
    <div class="mega-menu-divider"></div>
    <div class="finance-menu-body">
      <a class="featured-responsibility" href="/#product">
        <strong>Month-end close</strong>
        <span>Solden reconciles accounts, investigates exceptions, prepares journal support and the close package, then verifies the result in the ledger.</span>
        <small>Verified result, or an exact blocker.</small>
      </a>
      <div class="finance-job-list">
        <p>Talk to Solden about</p>
        <div>${financeJobLinks()}</div>
      </div>
    </div>
    <div class="mega-menu-divider"></div>
    <div class="mega-menu-footer">
      <p>Have another recurring finance job? Tell us the outcome you need completed.</p>
      <a href="/request-demo?source=finance-jobs">Request a demo</a>
    </div>`;
}

function desktopUseCasesMarkup() {
  return `<div class="mega-menu-heading">
      <h2>Where Solden fits</h2>
      <p>Solden is a fit when recurring close work is consuming the team.</p>
    </div>
    <div class="mega-menu-divider"></div>
    <div class="use-case-list">${useCaseLinks()}</div>
    <div class="mega-menu-divider"></div>
    <div class="mega-menu-footer">
      <p>Tell us what is making the close hard.</p>
      <a href="/request-demo?source=use-cases">Request a demo</a>
    </div>`;
}

function mobileFinanceJobsMarkup() {
  return `<button class="mobile-nav-back" type="button" data-mobile-nav-back>Back to navigation</button>
    <div class="mobile-menu-heading">
      <h2>Give Solden a finance responsibility</h2>
      <p>Solden owns execution through verified completion.</p>
    </div>
    <div class="mega-menu-divider"></div>
    <a class="featured-responsibility" href="/#product">
      <strong>Month-end close</strong>
      <span>Solden reconciles accounts, investigates exceptions, prepares journal support and the close package, then verifies the result in the ledger.</span>
    </a>
    <div class="mobile-finance-job-list">
      <p>Talk to Solden about</p>
      <div>${financeJobLinks('mobile-finance-job-link')}</div>
    </div>
    <div class="mega-menu-divider"></div>
    <p class="mobile-menu-note">Don't see the finance responsibility? Tell us what you need done.</p>
    <a class="mobile-nav-cta" href="/request-demo?source=finance-jobs">Request a demo</a>`;
}

function mobileUseCasesMarkup() {
  return `<button class="mobile-nav-back" type="button" data-mobile-nav-back>Back to navigation</button>
    <div class="mobile-menu-heading">
      <h2>Where Solden fits</h2>
      <p>Solden is a fit when recurring close work is consuming the team.</p>
    </div>
    <div class="mega-menu-divider"></div>
    <div class="mobile-use-case-list">${useCaseLinks('mobile-use-case-link')}</div>
    <div class="mega-menu-divider"></div>
    <p class="mobile-menu-note">Tell us what is making the close hard.</p>
    <a class="mobile-nav-cta" href="/request-demo?source=use-cases">Request a demo</a>`;
}

function populateNavigationMenus(header) {
  const financePanel = header.querySelector('#finance-jobs-menu');
  const useCasesPanel = header.querySelector('#use-cases-menu');
  const mobileFinancePanel = header.querySelector('[data-mobile-nav-panel="finance-jobs"]');
  const mobileUseCasesPanel = header.querySelector('[data-mobile-nav-panel="use-cases"]');
  if (financePanel) financePanel.innerHTML = desktopFinanceJobsMarkup();
  if (useCasesPanel) useCasesPanel.innerHTML = desktopUseCasesMarkup();
  if (mobileFinancePanel) mobileFinancePanel.innerHTML = mobileFinanceJobsMarkup();
  if (mobileUseCasesPanel) mobileUseCasesPanel.innerHTML = mobileUseCasesMarkup();
}

function setupDesktopNavigation(header) {
  const menus = Array.from(header.querySelectorAll('[data-nav-menu]'));
  if (!menus.length) return;
  const desktopQuery = window.matchMedia('(min-width: 941px)');
  const hoverQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  const closeTimers = new WeakMap();
  const openOrigins = new WeakMap();

  function setMenuOpen(menu, open, options = {}) {
    const trigger = menu.querySelector('[data-nav-trigger]');
    const panel = menu.querySelector('[data-nav-panel]');
    if (!trigger || !panel) return;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    menu.classList.toggle('is-open', open);
    if (!open) openOrigins.delete(menu);
    if (!open && options.restoreFocus) trigger.focus();
  }

  function closeAll(except = null) {
    menus.forEach((menu) => {
      if (menu !== except) setMenuOpen(menu, false);
    });
    if (!except) document.body.classList.remove('mega-nav-open');
  }

  function openMenu(menu, origin = 'programmatic') {
    if (!desktopQuery.matches) return;
    const timer = closeTimers.get(menu);
    if (timer) window.clearTimeout(timer);
    closeAll(menu);
    setMenuOpen(menu, true);
    openOrigins.set(menu, origin);
    document.body.classList.add('mega-nav-open');
  }

  function closeMenuSoon(menu) {
    const timer = window.setTimeout(() => {
      if (openOrigins.get(menu) === 'click') return;
      setMenuOpen(menu, false);
      if (!menus.some((item) => item.classList.contains('is-open'))) {
        document.body.classList.remove('mega-nav-open');
      }
    }, 140);
    closeTimers.set(menu, timer);
  }

  menus.forEach((menu) => {
    const trigger = menu.querySelector('[data-nav-trigger]');
    const panel = menu.querySelector('[data-nav-panel]');
    if (!trigger || !panel) return;
    trigger.addEventListener('click', () => {
      const isOpen = trigger.getAttribute('aria-expanded') === 'true';
      if (isOpen && openOrigins.get(menu) === 'hover') {
        openOrigins.set(menu, 'click');
        return;
      }
      if (!isOpen) openMenu(menu, 'click');
      else {
        setMenuOpen(menu, false, { restoreFocus: true });
        document.body.classList.remove('mega-nav-open');
      }
    });
    menu.addEventListener('pointerenter', () => {
      if (!hoverQuery.matches) return;
      const timer = closeTimers.get(menu);
      if (timer) window.clearTimeout(timer);
      if (trigger.getAttribute('aria-expanded') !== 'true') openMenu(menu, 'hover');
    });
    menu.addEventListener('pointerleave', () => {
      if (hoverQuery.matches && openOrigins.get(menu) !== 'click') closeMenuSoon(menu);
    });
    panel.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => closeAll());
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openMenuItem = menus.find((menu) => menu.classList.contains('is-open'));
    if (!openMenuItem) return;
    setMenuOpen(openMenuItem, false, { restoreFocus: true });
    closeAll();
  });
  document.addEventListener('click', (event) => {
    if (header.contains(event.target)) return;
    closeAll();
  });
  window.addEventListener('resize', () => {
    if (!desktopQuery.matches) closeAll();
  }, { passive: true });
}

function setupMobileNavigation(header) {
  const toggle = header?.querySelector('.menu-toggle');
  const navigation = header?.querySelector('.mobile-nav');
  const root = navigation?.querySelector('[data-mobile-nav-root]');
  const panels = Array.from(navigation?.querySelectorAll('[data-mobile-nav-panel]') || []);
  const panelTriggers = Array.from(navigation?.querySelectorAll('[data-mobile-nav-target]') || []);
  const backButtons = Array.from(navigation?.querySelectorAll('[data-mobile-nav-back]') || []);
  if (!header || !toggle || !navigation || !root) return;
  const backgroundRegions = Array.from(document.body.children)
    .filter((element) => element !== header && element.tagName !== 'SCRIPT');
  const initialInertState = new Map(
    backgroundRegions.map((element) => [element, element.inert]),
  );
  let activePanelTrigger = null;

  function showRoot(options = {}) {
    root.hidden = false;
    panels.forEach((panel) => { panel.hidden = true; });
    panelTriggers.forEach((button) => button.setAttribute('aria-expanded', 'false'));
    navigation.removeAttribute('data-view');
    navigation.scrollTop = 0;
    if (options.restoreFocus && activePanelTrigger) {
      window.requestAnimationFrame(() => activePanelTrigger.focus({ preventScroll: true }));
    }
  }

  function showPanel(name, trigger) {
    const panel = panels.find((candidate) => candidate.dataset.mobileNavPanel === name);
    if (!panel) return;
    activePanelTrigger = trigger || panelTriggers.find((button) => button.dataset.mobileNavTarget === name) || null;
    root.hidden = true;
    panels.forEach((candidate) => { candidate.hidden = candidate !== panel; });
    panelTriggers.forEach((button) => {
      button.setAttribute('aria-expanded', String(button.dataset.mobileNavTarget === name));
    });
    navigation.dataset.view = name;
    navigation.scrollTop = 0;
    panel.scrollTop = 0;
    window.requestAnimationFrame(() => {
      panel.querySelector('button, a')?.focus({ preventScroll: true });
    });
  }

  function setOpen(open, options = {}) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    navigation.hidden = !open;
    document.body.classList.toggle('nav-open', open);
    backgroundRegions.forEach((element) => {
      element.inert = open || initialInertState.get(element);
    });
    if (open) {
      showRoot();
      window.requestAnimationFrame(() => {
        navigation.querySelector('button, a')?.focus({ preventScroll: true });
      });
    }
    if (!open && options.restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  panelTriggers.forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.mobileNavTarget, button));
  });
  backButtons.forEach((button) => {
    button.addEventListener('click', () => showRoot({ restoreFocus: true }));
  });
  navigation.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      const target = link.hash ? document.querySelector(link.hash) : null;
      setOpen(false);
      if (!target?.matches('[data-anchor-target]')) return;
      window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || navigation.hidden) return;
    if (navigation.dataset.view) {
      showRoot({ restoreFocus: true });
      return;
    }
    setOpen(false, { restoreFocus: true });
  });
  document.addEventListener('click', (event) => {
    if (navigation.hidden || header.contains(event.target)) return;
    setOpen(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 940 && !navigation.hidden) setOpen(false);
  }, { passive: true });
}

const siteHeader = document.querySelector('[data-site-header]');
if (siteHeader) {
  populateNavigationMenus(siteHeader);
  setupDesktopNavigation(siteHeader);
  setupMobileNavigation(siteHeader);
}
