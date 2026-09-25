(() => {
  "use strict";

  const WIDGET_ID = "alpha-balance-widget";
  const HOST_ATTRIBUTE = "data-alpha-balance-host";
  const POLL_INTERVAL_MS = 30_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const API_PATH = "/api/statistic/profileActionGrouped";
  const CHAT_LIST_API_PATH = "/api/chatList/chatListByUserID";
  const CHAT_LIST_RESPONSE_TYPE = "ALPHA_BALANCE_CHAT_LIST";
  const CHAT_LIST_REPLAY_TYPE = "ALPHA_BALANCE_CHAT_LIST_REPLAY_REQUEST";
  const PERSONAL_INVITES_RESPONSE_TYPE = "ALPHA_BALANCE_PERSONAL_INVITES";
  const PERSONAL_INVITES_REPLAY_TYPE = "ALPHA_BALANCE_PERSONAL_INVITES_REPLAY_REQUEST";
  const CACHE_KEY = "alphaBalanceLastValue";
  const SNAPSHOT_KEY = "alphaBalanceSnapshot";
  const HISTORY_KEY = "alphaBalanceHistory";
  const PERSONAL_CHAT_CACHE_KEY = "alphaBalancePersonalChatsSnapshotV2";
  const PERSONAL_PAIRS_CACHE_KEY = "alphaBalancePersonalPairsV1";
  const PERSONAL_PAIRS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const HISTORY_LIMIT = 30;
  const PERSONAL_CHAT_LIMIT = 60;

  const ACTION_LABELS = {
    SENT_TEXT: "Повідомлення",
    SENT_STICKER: "Стікер",
    SENT_MAIL: "Лист",
    SENT_MAIL_FIRST: "Перший лист",
    SENT_MAIL_SECOND: "Повторний лист",
    READ_MAIL: "Прочитаний лист",
    SENT_IMAGE: "Фото в чаті",
    SENT_IMAGE_MAIL: "Фото в листі",
    SENT_VIDEO: "Відео в чаті",
    SENT_VIDEO_MAIL: "Відео в листі",
    SENT_AUDIO: "Голосове",
    GET_VIDEO: "Перегляд відео",
    GET_VIDEO_NEW: "Перегляд відео",
    GET_VIDEO_MAIL: "Відео в листі",
    GET_VIDEO_MAIL_NEW: "Відео в листі",
    GET_IMAGE_MAIL: "Фото в листі",
    GET_AUDIO_NEW: "Голосове в листі",
    GET_CONTACT_APPROVE: "Отримання контакту",
    SENT_VIRTUAL_GIFT: "Подарунок",
  };

  let pollTimer = null;
  let requestInFlight = false;
  let lastValue = null;
  let placementFrame = 0;
  let previousSnapshot = null;
  let balanceHistory = [];
  let chatLimitsRequestInFlight = false;
  let chatLimitsRefreshPending = false;
  let chatLimitsRefreshTimer = null;
  let chatLimitsToken = "";
  let chatLimitsMode = "";
  let personalChatEntries = [];
  let personalChatSignature = "";
  let personalChatBlockMarkup = "";
  let personalChatScrollTop = 0;
  let personalChatSource = "all";
  const personalChatSnapshots = { all: null, chance: null };
  let personalChatPersistTimer = null;
  const profilesPanelPlacements = { chat: null, personal: null, letter: null };
  let sourceFilterActionInFlight = false;
  const chatLimitsByUid = new Map();
  const personalPairKeys = new Set();
  const personalAliasKeys = new Set();
  const boundQuickNavigations = new WeakSet();

  function todayKey() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Kyiv",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  async function restoreCachedBalance() {
    try {
      const stored = await chrome.storage.local.get([
        CACHE_KEY,
        SNAPSHOT_KEY,
        HISTORY_KEY,
      ]);
      const cached = stored?.[CACHE_KEY];
      const value = Number.parseFloat(cached?.value);
      const day = todayKey();

      const storedSnapshot = stored?.[SNAPSHOT_KEY];
      if (storedSnapshot?.date === day && storedSnapshot?.values) {
        previousSnapshot = storedSnapshot;
      }

      const storedHistory = stored?.[HISTORY_KEY];
      if (storedHistory?.date === day && Array.isArray(storedHistory?.items)) {
        balanceHistory = storedHistory.items.slice(0, HISTORY_LIMIT);
      }
      renderHistory();

      if (cached?.date !== day || !Number.isFinite(value)) return;

      lastValue = value;
      setWidgetState(
        "loading",
        `${value.toFixed(2)}$`,
        "Показано останнє значення; перевіряю актуальний баланс"
      );
    } catch {}
  }

  async function persistBalanceState(value) {
    try {
      await chrome.storage.local.set({
        [CACHE_KEY]: { value, date: todayKey(), savedAt: Date.now() },
        [SNAPSHOT_KEY]: previousSnapshot,
        [HISTORY_KEY]: { date: todayKey(), items: balanceHistory },
      });
    } catch {}
  }

  function findNotificationsHeader() {
    const candidates = document.querySelectorAll("span, h1, h2, h3, div");
    for (const element of candidates) {
      if (element.childElementCount > 0) continue;
      if (element.textContent?.trim() === "Notifications") {
        element.setAttribute("data-alpha-balance-notifications-label", "true");
        return element;
      }
    }
    return null;
  }

  function findNotificationsColumn() {
    const header = findNotificationsHeader();
    if (!header) return null;

    header.parentElement?.setAttribute(
      "data-alpha-balance-notifications-heading",
      "true"
    );

    let node = header.parentElement;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      if (rect.height >= window.innerHeight * 0.65 && rect.width >= 180) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function createWidget() {
    const widget = document.createElement("section");
    widget.id = WIDGET_ID;
    widget.dataset.state = "loading";
    widget.setAttribute("aria-label", "Alpha balance");
    widget.title = "Баланс оновлюється кожні 30 секунд";
    widget.innerHTML = `
      <div class="alpha-balance-summary">
        <div class="alpha-balance-caption">
          <span class="alpha-balance-dot" aria-hidden="true"></span>
          <span>Balance</span>
        </div>
        <output class="alpha-balance-value" aria-live="polite">…</output>
      </div>
      <div class="alpha-balance-history" aria-label="Історія нарахувань"></div>
    `;
    renderHistory(widget);
    return widget;
  }

  function placeWidget(widget) {
    const column = findNotificationsColumn();
    if (!column || !widget) return false;

    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`).forEach((element) => {
      if (element !== column) element.removeAttribute(HOST_ATTRIBUTE);
    });
    column.setAttribute(HOST_ATTRIBUTE, "true");
    const rect = column.getBoundingClientRect();
    widget.style.setProperty("--alpha-balance-top", `${Math.max(8, rect.top + 8)}px`);
    widget.style.setProperty("--alpha-balance-left", `${rect.left + 8}px`);
    widget.style.setProperty("--alpha-balance-right", "auto");
    widget.style.setProperty("--alpha-balance-width", `${Math.max(164, rect.width - 16)}px`);
    return true;
  }

  function ensureWidget() {
    let widget = document.getElementById(WIDGET_ID);
    if (!widget?.isConnected) {
      widget = createWidget();
      document.body.append(widget);
    }
    placeWidget(widget);
    return widget;
  }

  function schedulePlacement() {
    if (placementFrame) return;
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0;
      ensureWidget();
      ensureConversationShortcut();
      ensurePersonalQuickPanel();
      ensureLetterChatPanel();
      ensureQuickNavigation();
      captureRenderedChatList();
      ensureProfilesPanelPlacement();
      ensureLeftMenuHidden();
      scheduleChatLimitsForCurrentSection();
      applyChatLimitBadges();
    });
  }

  const QUICK_NAV_ITEMS = [
    { key: "all", label: "All chats", testId: "main-menu-item-All chats" },
    { key: "chance", label: "Chance", testId: "main-menu-item-Chance" },
    { key: "personal", label: "Personal", testId: "main-menu-item-Personal" },
  ];

  function updateQuickNavigationState(nav) {
    const personalPage = /^\/personal(?:\/|$)/.test(location.pathname);
    const letterPage = /^\/letter(?:\/|$)/.test(location.pathname);
    for (const item of QUICK_NAV_ITEMS) {
      const source = document.querySelector(`[data-testid="${item.testId}"]`);
      const button = nav?.querySelector(`[data-alpha-quick-nav="${item.key}"]`);
      if (!button) continue;
      const active = personalPage
        ? item.key === "personal" || item.key === personalChatSource
        : letterPage
          ? item.key === personalChatSource
          : !!source && /(^|\s)active(?:-|\s|$)/.test(source.className || "");
      button.dataset.active = active ? "true" : "false";
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function ensureQuickNavigation() {
    const messages = Array.from(
      document.querySelectorAll('[data-testid="messages-button"]')
    ).find(
      (element) => !element.closest('[data-alpha-personal-frozen-chat-block="true"]')
    );
    const filtersRow = messages?.parentElement;
    if (!filtersRow) return false;

    filtersRow.setAttribute("data-alpha-quick-nav-host", "true");
    let nav = filtersRow.querySelector("#alpha-quick-navigation");
    if (!nav) {
      nav = document.createElement("nav");
      nav.id = "alpha-quick-navigation";
      nav.className = "alpha-quick-navigation";
      nav.setAttribute("aria-label", "Швидке перемикання розділів");
      populateQuickNavigation(nav);
      filtersRow.append(nav);
    }

    updateQuickNavigationState(nav);
    return true;
  }

  function populateQuickNavigation(nav) {
    if (!nav) return;
    if (!nav.childElementCount) {
      for (const item of QUICK_NAV_ITEMS) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.alphaQuickNav = item.key;
        button.textContent = item.label;
        nav.append(button);
      }
    }
    bindQuickNavigation(nav);
  }

  function bindQuickNavigation(nav) {
    if (!nav || boundQuickNavigations.has(nav)) return;
    boundQuickNavigations.add(nav);
    nav.querySelectorAll("[data-alpha-quick-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.alphaQuickNav;
        const item = QUICK_NAV_ITEMS.find((candidate) => candidate.key === key);
        if (!item) return;
        if (item.key === "personal") captureRenderedChatList();
        document.querySelector(`[data-testid="${item.testId}"]`)?.click();
        requestAnimationFrame(() => updateQuickNavigationState(nav));
      });
    });
  }

  function cleanupPersonalQuickPanel() {
    document.querySelectorAll("#alpha-personal-sidebar").forEach((sidebar) => sidebar.remove());
    const attributes = [
      "data-alpha-personal-layout",
      "data-alpha-personal-source-column",
      "data-alpha-personal-main-column",
      "data-alpha-personal-chooser",
      "data-alpha-personal-chooser-title",
      "data-alpha-personal-top-row",
      "data-alpha-personal-pick",
      "data-alpha-personal-wait",
      "data-alpha-personal-connect",
    ];
    for (const attribute of attributes) {
      document.querySelectorAll(`[${attribute}]`).forEach((element) =>
        element.removeAttribute(attribute)
      );
    }
  }

  function ensurePersonalQuickPanel() {
    if (!/^\/personal(?:\/|$)/.test(location.pathname)) {
      cleanupPersonalQuickPanel();
      return false;
    }
    const personalColumn = document.querySelector('[class*="clmn_2_personal"]');
    const personalPage = personalColumn?.closest('[class*="personal_page_wrap"]');
    const mainColumn = personalPage?.querySelector('[class*="clmn_3_personal"]');
    const chooser = personalColumn?.querySelector('[class*="personal_choose_girl"]');
    const topRow = mainColumn?.querySelector('[class*="connect_top_row"]');
    const pickPerson = topRow?.querySelector('[class*="choose_man_wrap"]');
    const letsConnect = topRow?.querySelector('[class*="lets_connect_wrap"]');
    const waitList = mainColumn?.querySelector('[class*="connect_wait_list"]');
    if (
      !personalColumn ||
      !personalPage ||
      !mainColumn ||
      !chooser ||
      !topRow ||
      !pickPerson ||
      !waitList
    ) {
      return false;
    }

    personalPage.setAttribute("data-alpha-personal-layout", "true");
    personalColumn.setAttribute("data-alpha-personal-source-column", "true");
    mainColumn.setAttribute("data-alpha-personal-main-column", "true");
    chooser.setAttribute("data-alpha-personal-chooser", "true");
    const chooserTitle = Array.from(chooser.querySelectorAll("*")).find(
      (element) => element.textContent?.trim() === "Your profile for connect"
    );
    document
      .querySelectorAll('[data-alpha-personal-chooser-title="true"]')
      .forEach((element) => {
        if (element !== chooserTitle) {
          element.removeAttribute("data-alpha-personal-chooser-title");
        }
      });
    chooserTitle?.setAttribute("data-alpha-personal-chooser-title", "true");
    topRow.setAttribute("data-alpha-personal-top-row", "true");
    pickPerson.setAttribute("data-alpha-personal-pick", "true");
    waitList.setAttribute("data-alpha-personal-wait", "true");
    letsConnect?.setAttribute("data-alpha-personal-connect", "true");

    let sidebar = personalPage.querySelector("#alpha-personal-sidebar");
    if (!sidebar) {
      sidebar = document.createElement("aside");
      sidebar.id = "alpha-personal-sidebar";
      personalPage.prepend(sidebar);
    }

    if (personalPage.firstElementChild !== sidebar) personalPage.prepend(sidebar);

    renderPersonalChatBlock(sidebar);
    return true;
  }

  function cleanupLetterChatPanel() {
    document.querySelectorAll("#alpha-letter-sidebar").forEach((sidebar) => sidebar.remove());
    const attributes = [
      "data-alpha-letter-chat-host",
      "data-alpha-letter-sidebar-column",
      "data-alpha-letter-main-column",
    ];
    for (const attribute of attributes) {
      document.querySelectorAll(`[${attribute}]`).forEach((element) =>
        element.removeAttribute(attribute)
      );
    }
  }

  function ensureLetterChatPanel() {
    if (!/^\/letter(?:\/|$)/.test(location.pathname)) {
      cleanupLetterChatPanel();
      return false;
    }
    const host = document.querySelector('[data-testid="letter-filter-block"]');
    if (!host) return false;
    const sidebarColumn =
      host.closest('[class*="clmn_2_letters"]') || host.parentElement || host;
    const mainColumn = document.querySelector('[class*="clmn_3_letters"]');

    host.setAttribute("data-alpha-letter-chat-host", "true");
    sidebarColumn.setAttribute("data-alpha-letter-sidebar-column", "true");
    mainColumn?.setAttribute("data-alpha-letter-main-column", "true");
    let sidebar = host.querySelector(":scope > #alpha-letter-sidebar");
    if (!sidebar) {
      sidebar = document.createElement("aside");
      sidebar.id = "alpha-letter-sidebar";
      host.append(sidebar);
    }
    renderPersonalChatBlock(sidebar);
    return true;
  }

  function createPersonalSidebarFallback(sidebar) {
    const panel = document.createElement("div");
    panel.id = "alpha-personal-quick-panel";

    const heartSpacer = document.createElement("div");
    heartSpacer.id = "alpha-personal-heart-spacer";
    heartSpacer.setAttribute("aria-hidden", "true");

    const nav = document.createElement("nav");
    nav.id = "alpha-personal-quick-navigation";
    nav.className = "alpha-quick-navigation";
    nav.setAttribute("aria-label", "Швидке перемикання розділів");
    populateQuickNavigation(nav);

    const empty = document.createElement("div");
    empty.className = "alpha-personal-chat-empty";
    empty.textContent = "Спочатку відкрийте All chats або Chance, щоб зберегти список";

    panel.append(heartSpacer, nav);
    sidebar.append(panel, empty);
  }

  function captureRenderedChatList() {
    const sourceSection = currentChatLimitsMode();
    if (!sourceSection) return false;
    const source = nativeChatList();
    if (!source) return false;
    const chatListBlock = source.closest('[data-testid="chat-list-block"]');
    if (!chatListBlock) return false;

    const seen = new Set();
    const entries = Array.from(source.querySelectorAll('[data-testid="man-name"]'))
      .map((nameElement) => {
        let row = nameElement.parentElement;
        while (row && row.parentElement !== source) {
          if (row.hasAttribute?.("data-testid")) break;
          row = row.parentElement;
        }
        if (!row || !source.contains(row)) return null;
        const chatUid = String(row.getAttribute("data-testid") || "").trim();
        if (!chatUid || seen.has(chatUid)) return null;
        seen.add(chatUid);
        return { chatUid };
      })
      .filter(Boolean)
      .slice(0, PERSONAL_CHAT_LIMIT);

    if (!entries.length) return false;
    const blockClone = chatListBlock.cloneNode(true);
    const cloneFilter = blockClone.querySelector('[data-testid="chat-list-filter"]');
    const cloneQuickNavHost = cloneFilter?.querySelector(
      '[data-alpha-quick-nav-host="true"]'
    );
    if (cloneFilter && cloneQuickNavHost && !cloneFilter.querySelector("#alpha-profiles-panel-spacer")) {
      const cloneSpacer = document.createElement("div");
      cloneSpacer.id = "alpha-profiles-panel-spacer";
      cloneSpacer.setAttribute("aria-hidden", "true");
      cloneQuickNavHost.before(cloneSpacer);
    }
    const sourceInputs = chatListBlock.querySelectorAll("input");
    const cloneInputs = blockClone.querySelectorAll("input");
    sourceInputs.forEach((input, index) => {
      const clone = cloneInputs[index];
      if (!clone) return;
      if (input.checked) clone.setAttribute("checked", "");
      else clone.removeAttribute("checked");
      clone.setAttribute("value", input.value || "");
    });
    setPersonalChatEntries(
      entries,
      true,
      blockClone.outerHTML,
      source.scrollTop,
      sourceSection
    );
    return true;
  }

  function setPersonalChatEntries(
    entries,
    persist = false,
    blockMarkup = personalChatBlockMarkup,
    scrollTop = personalChatScrollTop,
    sourceSection = personalChatSource
  ) {
    const normalizedSource = sourceSection === "chance" ? "chance" : "all";
    const normalized = entries
      .filter((entry) => entry?.chatUid)
      .map((entry) => ({
        chatUid: String(entry.chatUid),
      }))
      .slice(0, PERSONAL_CHAT_LIMIT);
    const nextBlockMarkup = String(blockMarkup || "");
    const nextScrollTop = Math.max(0, Number(scrollTop) || 0);
    let markupHash = 2166136261;
    for (let index = 0; index < nextBlockMarkup.length; index += 1) {
      markupHash ^= nextBlockMarkup.charCodeAt(index);
      markupHash = Math.imul(markupHash, 16777619);
    }
    const signature = `${normalizedSource}:${normalized
      .map((entry) => entry.chatUid)
      .join(",")}:${nextBlockMarkup.length}:${markupHash >>> 0}:${nextScrollTop}`;
    if (!normalized.length || signature === personalChatSignature) return;
    personalChatSource = normalizedSource;
    personalChatEntries = normalized;
    personalChatBlockMarkup = nextBlockMarkup;
    personalChatScrollTop = nextScrollTop;
    personalChatSignature = signature;
    personalChatSnapshots[normalizedSource] = {
      savedAt: Date.now(),
      entries: normalized,
      blockMarkup: nextBlockMarkup,
      scrollTop: nextScrollTop,
    };
    renderPersonalChatBlock();
    if (persist) schedulePersonalChatPersist();
  }

  function schedulePersonalChatPersist() {
    if (personalChatPersistTimer) clearTimeout(personalChatPersistTimer);
    personalChatPersistTimer = setTimeout(async () => {
      personalChatPersistTimer = null;
      try {
        await chrome.storage.local.set({
          [PERSONAL_CHAT_CACHE_KEY]: {
            savedAt: Date.now(),
            activeSource: personalChatSource,
            snapshots: personalChatSnapshots,
          },
        });
      } catch {}
    }, 250);
  }

  async function restoreCachedPersonalChats() {
    try {
      const stored = await chrome.storage.local.get(PERSONAL_CHAT_CACHE_KEY);
      const snapshot = stored?.[PERSONAL_CHAT_CACHE_KEY];
      if (snapshot?.snapshots && typeof snapshot.snapshots === "object") {
        for (const sourceSection of ["all", "chance"]) {
          const saved = snapshot.snapshots[sourceSection];
          if (!Array.isArray(saved?.entries) || !saved.entries.length) continue;
          personalChatSnapshots[sourceSection] = {
            savedAt: Number(saved.savedAt) || Date.now(),
            entries: saved.entries
              .filter((entry) => entry?.chatUid)
              .map((entry) => ({ chatUid: String(entry.chatUid) }))
              .slice(0, PERSONAL_CHAT_LIMIT),
            blockMarkup: String(saved.blockMarkup || ""),
            scrollTop: Math.max(0, Number(saved.scrollTop) || 0),
          };
        }
        const requestedSource = snapshot.activeSource === "chance" ? "chance" : "all";
        const activeSnapshot =
          personalChatSnapshots[requestedSource] ||
          personalChatSnapshots.all ||
          personalChatSnapshots.chance;
        const activeSource = personalChatSnapshots[requestedSource]
          ? requestedSource
          : personalChatSnapshots.all
            ? "all"
            : "chance";
        if (activeSnapshot) {
          setPersonalChatEntries(
            activeSnapshot.entries,
            false,
            activeSnapshot.blockMarkup,
            activeSnapshot.scrollTop,
            activeSource
          );
          schedulePersonalChatPersist();
        }
      } else if (Array.isArray(snapshot?.entries)) {
        setPersonalChatEntries(
          snapshot.entries,
          false,
          snapshot.blockMarkup,
          snapshot.scrollTop,
          "all"
        );
        schedulePersonalChatPersist();
      }
    } catch {}
  }

  function numericExternalId(value) {
    const id = String(value ?? "").replace(/\D+/g, "");
    return id.length >= 6 ? id : "";
  }

  function externalIdFromImage(image) {
    try {
      const path = new URL(String(image?.getAttribute("src") || ""), location.origin).pathname;
      return path.split("/").map(numericExternalId).find(Boolean) || "";
    } catch {
      return "";
    }
  }

  function normalizedAliasKey(womanId, name, age) {
    const normalizedName = String(name || "").trim().toLocaleLowerCase("en-US");
    const normalizedAge = Math.floor(Number(age) || 0);
    return womanId && normalizedName && normalizedAge > 0
      ? `${womanId}:${normalizedName}:${normalizedAge}`
      : "";
  }

  function currentTokenFingerprint() {
    const token = getToken();
    if (!token || !globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
      return Promise.resolve("");
    }
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(token))
      .then((buffer) =>
        Array.from(new Uint8Array(buffer).slice(0, 12), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
      )
      .catch(() => "");
  }

  function setPersonalPairs(entries) {
    personalPairKeys.clear();
    personalAliasKeys.clear();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const womanId = numericExternalId(
        entry?.woman_external_id ?? entry?.womanExternalId
      );
      const manId = numericExternalId(entry?.man_external_id ?? entry?.manExternalId);
      if (!womanId || !manId) continue;
      personalPairKeys.add(`${womanId}:${manId}`);
      const aliasKey = normalizedAliasKey(womanId, entry?.alias_name, entry?.alias_age);
      if (aliasKey) personalAliasKeys.add(aliasKey);
    }
    applyPersonalRailColors();
  }

  async function persistPersonalPairs(entries) {
    try {
      const fingerprint = await currentTokenFingerprint();
      await chrome.storage.local.set({
        [PERSONAL_PAIRS_CACHE_KEY]: {
          savedAt: Date.now(),
          fingerprint,
          entries,
        },
      });
    } catch {}
  }

  async function restoreCachedPersonalPairs() {
    try {
      const stored = await chrome.storage.local.get(PERSONAL_PAIRS_CACHE_KEY);
      const cache = stored?.[PERSONAL_PAIRS_CACHE_KEY];
      if (!Array.isArray(cache?.entries)) return;
      if (Date.now() - Number(cache.savedAt || 0) > PERSONAL_PAIRS_CACHE_TTL_MS) return;
      const fingerprint = await currentTokenFingerprint();
      if (cache.fingerprint && fingerprint && cache.fingerprint !== fingerprint) return;
      setPersonalPairs(cache.entries);
    } catch {}
  }

  function requestPersonalInvitesReplay() {
    window.postMessage({ type: PERSONAL_INVITES_REPLAY_TYPE }, location.origin);
  }

  function handlePersonalInvitesResponse(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (
      data?.source !== "alpha-balance-page" ||
      data?.type !== PERSONAL_INVITES_RESPONSE_TYPE ||
      !Array.isArray(data.entries)
    ) {
      return;
    }
    setPersonalPairs(data.entries);
    void persistPersonalPairs(data.entries);
  }

  function frozenChatRowFromTarget(target, list) {
    let row = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    while (row && row !== list) {
      const chatUid = String(row.getAttribute?.("data-testid") || "").trim();
      if (chatUid && personalChatEntries.some((entry) => entry.chatUid === chatUid)) {
        return { row, chatUid };
      }
      row = row.parentElement;
    }
    return null;
  }

  function applyFrozenChatFilters(sidebar) {
    const list = sidebar.querySelector('[data-testid="chat-list"]');
    if (!list) return;
    const query = String(
      sidebar.querySelector('[data-testid="idOrName"]')?.value || ""
    ).trim().toLocaleLowerCase();
    for (const entry of personalChatEntries) {
      const escapedUid = globalThis.CSS?.escape
        ? CSS.escape(entry.chatUid)
        : entry.chatUid.replace(/["\\]/g, "\\$&");
      const row = list.querySelector(`[data-testid="${escapedUid}"]`);
      if (!row) continue;
      const wrapper = row.parentElement === list ? row : row.parentElement;
      const searchable = String(row.textContent || "").toLocaleLowerCase();
      wrapper.hidden = !!query && !searchable.includes(query);
    }
  }

  function nativeChatList() {
    return Array.from(document.querySelectorAll('[data-testid="chat-list"]')).find(
      (list) => !list.closest('[data-alpha-personal-frozen-chat-block="true"]')
    );
  }

  function nativeChatFilter() {
    return Array.from(document.querySelectorAll('[data-testid="chat-list-filter"]')).find(
      (filter) => !filter.closest('[data-alpha-personal-frozen-chat-block="true"]')
    );
  }

  function filterControlState(type, filter = nativeChatFilter()) {
    if (!filter) return null;
    if (type === "online") {
      const input = filter.querySelector('[data-testid="online"] input');
      return input ? !!input.checked : null;
    }
    if (type === "freeze") {
      const source = String(
        filter.querySelector('[data-testid="freeze-cube"] img')?.getAttribute("src") || ""
      );
      return source ? /freeze-cube-full/i.test(source) : null;
    }
    return null;
  }

  function waitForNativeFilter(type, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const filter = nativeChatFilter();
        if (filter && filterControlState(type, filter) !== null) return resolve(filter);
        if (Date.now() - startedAt >= timeoutMs) return resolve(null);
        setTimeout(check, 60);
      };
      check();
    });
  }

  async function activateSourceFilter(type, desiredState) {
    if (sourceFilterActionInFlight || typeof desiredState !== "boolean") return;
    sourceFilterActionInFlight = true;
    try {
      const sourceSection = personalChatSource === "chance" ? "chance" : "all";
      const sourceItem = QUICK_NAV_ITEMS.find((item) => item.key === sourceSection);
      const sourceButton = sourceItem
        ? document.querySelector(`[data-testid="${sourceItem.testId}"]`)
        : null;
      if (!sourceButton) return;

      sourceButton.click();
      const filter = await waitForNativeFilter(type);
      if (!filter || filterControlState(type, filter) === desiredState) return;

      if (type === "online") {
        const online = filter.querySelector('[data-testid="online"]');
        const target = online?.querySelector("label") || online?.querySelector("input");
        target?.click();
      } else if (type === "freeze") {
        filter.querySelector('[data-testid="freeze-cube"]')?.click();
      }
    } finally {
      setTimeout(() => {
        sourceFilterActionInFlight = false;
      }, 350);
    }
  }

  function nativeChatRow(chatUid) {
    const list = nativeChatList();
    if (!list) return null;
    const escapedUid = globalThis.CSS?.escape
      ? CSS.escape(chatUid)
      : chatUid.replace(/["\\]/g, "\\$&");
    return list.querySelector(`[data-testid="${escapedUid}"]`);
  }

  function chanceLoadMoreControl() {
    const list = nativeChatList();
    const root = list?.closest('[data-testid="chat-list-block"]') || list?.parentElement;
    if (!root) return null;
    return Array.from(
      root.querySelectorAll('button, [role="button"], a, [tabindex], div, span')
    )
      .filter((element) => /^load\s+more$/i.test(element.textContent?.trim() || ""))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .sort((a, b) => a.childElementCount - b.childElementCount)[0] || null;
  }

  function nativeChatListSignature() {
    const list = nativeChatList();
    if (!list) return "";
    return Array.from(list.querySelectorAll('[data-testid="man-name"]'))
      .map((element) => element.textContent?.trim() || "")
      .join("|");
  }

  function waitForNativeChatRow(chatUid, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const row = nativeChatRow(chatUid);
        if (row) return resolve(row);
        if (Date.now() - startedAt >= timeoutMs) return resolve(null);
        setTimeout(check, 60);
      };
      check();
    });
  }

  function waitForChatListChange(previousSignature, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const nextSignature = nativeChatListSignature();
        if (nextSignature && nextSignature !== previousSignature) return resolve(true);
        if (Date.now() - startedAt >= timeoutMs) return resolve(false);
        setTimeout(check, 60);
      };
      check();
    });
  }

  async function openFrozenChatNatively(chatUid) {
    const sourceSection = personalChatSource === "chance" ? "chance" : "all";
    const sourceItem = QUICK_NAV_ITEMS.find((item) => item.key === sourceSection);
    const sourceButton = sourceItem
      ? document.querySelector(`[data-testid="${sourceItem.testId}"]`)
      : null;
    if (!sourceButton) return;

    sourceButton.click();
    let row = await waitForNativeChatRow(chatUid);
    for (let pageAttempt = 0; !row && sourceSection === "chance" && pageAttempt < 10; pageAttempt += 1) {
      const loadMore = chanceLoadMoreControl();
      if (!loadMore) break;
      const previousSignature = nativeChatListSignature();
      loadMore.click();
      const changed = await waitForChatListChange(previousSignature);
      row = await waitForNativeChatRow(chatUid, 600);
      if (!changed && !row) break;
    }

    const nativeTarget = row?.querySelector('[data-testid="man-name"]') || row;
    nativeTarget?.click();
  }

  function bindFrozenChatBlock(sidebar) {
    const nav = sidebar.querySelector(".alpha-quick-navigation");
    bindQuickNavigation(nav);
    updateQuickNavigationState(nav);

    const list = sidebar.querySelector('[data-testid="chat-list"]');
    if (list && list.dataset.alphaFrozenBound !== "true") {
      list.dataset.alphaFrozenBound = "true";
      list.addEventListener("click", (event) => {
        const match = frozenChatRowFromTarget(event.target, list);
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        void openFrozenChatNatively(match.chatUid);
      });
    }

    const search = sidebar.querySelector('[data-testid="idOrName"]');
    const online = sidebar.querySelector('[data-testid="online"] input');
    const freeze = sidebar.querySelector('[data-testid="freeze-cube"]');
    if (search && search.dataset.alphaFrozenBound !== "true") {
      search.dataset.alphaFrozenBound = "true";
      search.addEventListener("input", () => applyFrozenChatFilters(sidebar));
    }
    if (online && online.dataset.alphaFrozenBound !== "true") {
      online.dataset.alphaFrozenBound = "true";
      online.addEventListener("change", (event) => {
        event.stopPropagation();
        void activateSourceFilter("online", !!online.checked);
      });
    }
    if (freeze && freeze.dataset.alphaFrozenBound !== "true") {
      freeze.dataset.alphaFrozenBound = "true";
      freeze.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const active = /freeze-cube-full/i.test(
          freeze.querySelector("img")?.getAttribute("src") || ""
        );
        void activateSourceFilter("freeze", !active);
      });
    }
    applyFrozenChatFilters(sidebar);
  }

  function renderPersonalChatBlock(sidebar = document.getElementById("alpha-personal-sidebar")) {
    if (!sidebar) return;
    if (!personalChatBlockMarkup || !personalChatEntries.length) {
      if (sidebar.dataset.signature !== "empty") {
        sidebar.dataset.signature = "empty";
        sidebar.replaceChildren();
        createPersonalSidebarFallback(sidebar);
      }
      updateQuickNavigationState(sidebar.querySelector(".alpha-quick-navigation"));
      return;
    }
    if (sidebar.dataset.signature !== personalChatSignature) {
      sidebar.dataset.signature = personalChatSignature;
      sidebar.innerHTML = personalChatBlockMarkup;
      sidebar
        .querySelector('[data-testid="chat-list-block"]')
        ?.setAttribute("data-alpha-personal-frozen-chat-block", "true");
      const list = sidebar.querySelector('[data-testid="chat-list"]');
      if (list) list.scrollTop = personalChatScrollTop;
    }
    bindFrozenChatBlock(sidebar);
  }

  function ensureProfilesPanelPlacement() {
    const profilesButton = document.querySelector('[data-testid="profiles-btn"]');
    const filtersContainer = nativeChatFilter();
    const quickNavHost = filtersContainer?.querySelector(
      '[data-alpha-quick-nav-host="true"]'
    );
    const personalSpacer =
      document.querySelector("#alpha-personal-sidebar #alpha-profiles-panel-spacer") ||
      document.querySelector("#alpha-personal-heart-spacer");
    const letterSpacer =
      document.querySelector("#alpha-letter-sidebar #alpha-profiles-panel-spacer") ||
      document.querySelector("#alpha-letter-sidebar #alpha-personal-heart-spacer");
    if (!profilesButton) return false;

    const profileCard = profilesButton.parentElement?.querySelector(
      ':scope > [data-testid="active-profile-photo"]'
    )
      ? profilesButton.parentElement
      : null;
    const profilesPanel = profileCard || profilesButton;
    const panelMode = profileCard ? "profile" : "menu";
    const panelHeight = profileCard
      ? Math.max(166, Math.min(220, Math.ceil(profileCard.scrollHeight || 0)))
      : 68;

    document.querySelectorAll('[data-alpha-profiles-panel="true"]').forEach((element) => {
      if (element === profilesPanel) return;
      element.removeAttribute("data-alpha-profiles-panel");
      element.removeAttribute("data-alpha-profiles-panel-mode");
      element.removeAttribute("data-alpha-profiles-panel-hidden");
      element.style.removeProperty("--alpha-profiles-top");
      element.style.removeProperty("--alpha-profiles-left");
      element.style.removeProperty("--alpha-profiles-width");
      element.style.removeProperty("--alpha-profiles-height");
    });
    profilesPanel.setAttribute("data-alpha-profiles-panel-mode", panelMode);
    profilesPanel.style.setProperty("--alpha-profiles-height", `${panelHeight}px`);

    const isPersonalPage = /^\/personal(?:\/|$)/.test(location.pathname);
    const isLetterPage = /^\/letter(?:\/|$)/.test(location.pathname);
    const isChatListPage = !!currentChatLimitsMode();
    const placementKey = isPersonalPage ? "personal" : isLetterPage ? "letter" : "chat";
    const regularTarget = !isPersonalPage && !isLetterPage && filtersContainer && quickNavHost;
    const targetSpacer = isPersonalPage
      ? personalSpacer
      : isLetterPage
        ? letterSpacer
        : regularTarget
          ? filtersContainer.querySelector("#alpha-profiles-panel-spacer")
          : null;
    const hasTarget = isPersonalPage
      ? !!personalSpacer
      : isLetterPage
        ? !!letterSpacer
        : !!regularTarget;
    if (hasTarget) {
      profilesPanel.removeAttribute("data-alpha-profiles-panel-hidden");
    } else {
      profilesPanel.setAttribute("data-alpha-profiles-panel", "true");
      profilesPanel.setAttribute("data-alpha-profiles-panel-hidden", "true");
    }
    if (!hasTarget) {
      if (!isPersonalPage && !isLetterPage && !isChatListPage) {
        document.getElementById("alpha-profiles-panel-spacer")?.remove();
      }
      return false;
    }

    profilesPanel.setAttribute("data-alpha-profiles-panel", "true");
    let spacer = targetSpacer;
    if (!isPersonalPage && !isLetterPage && !spacer) {
      if (!filtersContainer || !quickNavHost) {
        profilesPanel.setAttribute("data-alpha-profiles-panel-hidden", "true");
        return false;
      }
      filtersContainer.setAttribute("data-alpha-profiles-filter-host", "true");
      spacer = document.createElement("div");
      spacer.id = "alpha-profiles-panel-spacer";
      spacer.setAttribute("aria-hidden", "true");
      quickNavHost.before(spacer);
    }

    if (!spacer?.isConnected) {
      profilesPanel.setAttribute("data-alpha-profiles-panel-hidden", "true");
      return false;
    }

    spacer.style.height = `${panelHeight}px`;

    const rect = spacer.getBoundingClientRect();
    // Follow the route's real placeholder: admin mode adds a top bar, while
    // the regular layout starts closer to the viewport edge.
    const placement = {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${panelHeight}px`,
    };
    profilesPanelPlacements[placementKey] = placement;
    profilesPanel.style.setProperty("--alpha-profiles-top", placement.top);
    profilesPanel.style.setProperty("--alpha-profiles-left", placement.left);
    profilesPanel.style.setProperty("--alpha-profiles-width", placement.width);
    profilesPanel.style.setProperty("--alpha-profiles-height", placement.height);
    return true;
  }

  function ensureLeftMenuHidden() {
    const menuList = document.querySelector('[data-testid="main-menu-list"]');
    const column = menuList?.closest?.(".clmn_1");
    const pageWrapper = column?.closest?.('[class*="wchat_wrap_redesign"]');
    document
      .querySelectorAll('[data-alpha-left-menu-hidden="true"]')
      .forEach((element) => {
        if (element !== column) element.removeAttribute("data-alpha-left-menu-hidden");
    });
    document
      .querySelectorAll('[data-alpha-main-expanded="true"]')
      .forEach((element) => {
        if (element !== pageWrapper) element.removeAttribute("data-alpha-main-expanded");
      });
    if (!column) return false;
    column.setAttribute("data-alpha-left-menu-hidden", "true");
    pageWrapper?.setAttribute("data-alpha-main-expanded", "true");

    for (const child of column.children) {
      child.removeAttribute("data-alpha-left-menu-keep");
    }
    const profilesPanel = column.querySelector('[data-testid="profiles-btn"]');
    let profilesHost = profilesPanel;
    while (profilesHost?.parentElement && profilesHost.parentElement !== column) {
      profilesHost = profilesHost.parentElement;
    }
    if (profilesHost?.parentElement === column) {
      profilesHost.setAttribute("data-alpha-left-menu-keep", "true");
    }
    return true;
  }

  function ensureConversationShortcut() {
    const optionsArea = document.querySelector('[data-testid="options-btn"]');
    const openOptions = optionsArea?.querySelector('[title="Open options"]');
    const shortcut = document.querySelector(
      '[data-testid="send-letter-btn"], [data-testid="open-chat-btn"]'
    );
    if (!optionsArea || !openOptions || !shortcut) return false;

    if (
      shortcut.parentElement === optionsArea &&
      shortcut.nextElementSibling === openOptions
    ) {
      return true;
    }

    shortcut.setAttribute("data-alpha-balance-letter-shortcut", "true");
    openOptions.before(shortcut);
    return true;
  }

  function setWidgetState(state, text, title) {
    const widget = ensureWidget();
    if (!widget) return;

    widget.dataset.state = state;
    const value = widget.querySelector(".alpha-balance-value");
    if (value) value.textContent = text;
    widget.title = title;
  }

  function actionLabel(type) {
    return ACTION_LABELS[type] || String(type || "Нарахування").replaceAll("_", " ");
  }

  function renderHistory(widget = document.getElementById(WIDGET_ID)) {
    const container = widget?.querySelector(".alpha-balance-history");
    if (!container) return;
    container.replaceChildren();

    const items = balanceHistory;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "alpha-balance-history-empty";
      empty.textContent = "Нових нарахувань ще немає";
      container.append(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "alpha-balance-history-row";

      const time = document.createElement("time");
      time.textContent = new Date(item.detectedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      const label = document.createElement("span");
      label.className = "alpha-balance-history-label";
      label.textContent = actionLabel(item.type);

      const amount = document.createElement("strong");
      amount.textContent = `+${Number(item.amount).toFixed(2)}$`;

      row.append(time, label, amount);
      container.append(row);
    }
  }

  function getToken() {
    const token = String(localStorage.getItem("token") || "").trim();
    return token.replace(/^Bearer\s+/i, "");
  }

  function normalizeLimit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
  }

  function normalizeManColor(value) {
    const color = Number(value);
    return color === 1 || color === 2 || color === 3 ? color : 0;
  }

  function currentChatLimitsMode() {
    if (/^\/chance(?:\/|$)/.test(location.pathname)) return "chance";
    if (/^\/chat(?:\/|$)/.test(location.pathname)) return "all";
    return "";
  }

  function scheduleChatLimitsForCurrentSection() {
    const mode = currentChatLimitsMode();
    if (mode === chatLimitsMode || chatLimitsRefreshTimer) return;

    chatLimitsByUid.clear();
    chatLimitsMode = "";
    removeChatLimitBadges();
    if (!mode) return;

    chatLimitsRefreshTimer = setTimeout(() => {
      chatLimitsRefreshTimer = null;
      if (currentChatLimitsMode() !== mode) {
        scheduleChatLimitsForCurrentSection();
        return;
      }
      chatLimitsMode = mode;
      requestChatLimitsReplay(mode);
    }, 80);
  }

  function extractChatList(payload) {
    const response = payload?.response;
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function removeChatLimitBadges() {
    document.querySelectorAll("[data-alpha-chat-limits]").forEach((badge) => {
      if (!badge.closest('[data-alpha-personal-frozen-chat-block="true"]')) badge.remove();
    });
    document.querySelectorAll("[data-alpha-limit-rail]").forEach((rail) => {
      if (rail.closest('[data-alpha-personal-frozen-chat-block="true"]')) return;
      rail.querySelectorAll("[data-alpha-side-limit]").forEach((item) => item.remove());
      rail.querySelectorAll("[data-alpha-native-limit-icon]").forEach((icon) => {
        icon.removeAttribute("data-alpha-native-limit-icon");
      });
      rail.removeAttribute("data-alpha-limit-rail");
      rail.removeAttribute("data-alpha-man-color");
      rail.removeAttribute("data-alpha-personal");
      rail.removeAttribute("title");
    });
  }

  function findChatLimitRail(chat) {
    const direct =
      chat?.querySelector('[class*="item_left_left-"]') ||
      chat?.querySelector('[class*="styles_item_left_left"]');
    if (direct) return direct;

    const photo = chat?.querySelector('[data-testid="man-photo"]');
    let candidate = photo?.previousElementSibling || null;
    while (candidate) {
      if (candidate.querySelector?.("svg,img") || candidate.matches?.("svg,img")) {
        return candidate;
      }
      candidate = candidate.previousElementSibling;
    }
    return null;
  }

  function nativeLimitIcons(rail) {
    return Array.from(rail?.children || []).filter((child) => {
      if (child.hasAttribute?.("data-alpha-side-limit")) return false;
      return child.matches?.("svg,img") || !!child.querySelector?.("svg,img");
    });
  }

  function nativeLimitIconType(icon) {
    const svg = icon?.matches?.("svg") ? icon : icon?.querySelector?.("svg");
    const viewBox = String(svg?.getAttribute("viewBox") || "")
      .trim()
      .replace(/\s+/g, " ");
    if (viewBox === "0 0 11 11") return "message";
    if (viewBox === "0 0 10 9") return "letter";
    if (viewBox === "0 0 10 10") return "heart";
    return "";
  }

  function setSideLimit(rail, kind, value, top, needsFallbackIcon) {
    let count = rail.querySelector(`[data-alpha-side-limit="${kind}"]`);
    if (!count) {
      count = document.createElement("span");
      count.dataset.alphaSideLimit = kind;
      count.className = `alpha-side-limit alpha-side-limit-${kind}`;
      rail.append(count);
    }
    count.textContent = String(value ?? "—");
    count.dataset.zero = value === 0 ? "true" : "false";
    count.style.setProperty("--alpha-side-limit-top", `${top}px`);

    let fallback = rail.querySelector(`[data-alpha-side-limit="${kind}-icon"]`);
    if (needsFallbackIcon && !fallback) {
      fallback = document.createElement("span");
      fallback.dataset.alphaSideLimit = `${kind}-icon`;
      fallback.className = `alpha-side-limit-fallback alpha-side-limit-fallback-${kind}`;
      fallback.setAttribute("aria-hidden", "true");
      rail.append(fallback);
    }
    if (fallback) {
      fallback.style.setProperty("--alpha-side-limit-top", `${top}px`);
      fallback.hidden = !needsFallbackIcon;
    }
  }

  function chatRowIdentity(chat) {
    const womanId =
      numericExternalId(
        chat?.querySelector('[data-testid="woman-external_id"]')?.textContent
      ) || externalIdFromImage(chat?.querySelector('[data-testid="woman-photo"] img'));
    const manId = externalIdFromImage(chat?.querySelector('[data-testid="man-photo"] img'));
    const nameAge = String(
      chat?.querySelector('[data-testid="man-name"]')?.textContent || ""
    ).match(/^\s*(.*?)\s*,\s*(\d{1,3})\s*$/);
    return {
      womanId,
      manId,
      aliasKey: nameAge ? normalizedAliasKey(womanId, nameAge[1], nameAge[2]) : "",
    };
  }

  function isPersonalChatRow(chat) {
    const identity = chatRowIdentity(chat);
    if (identity.womanId && identity.manId) {
      return personalPairKeys.has(`${identity.womanId}:${identity.manId}`);
    }
    return !!identity.aliasKey && personalAliasKeys.has(identity.aliasKey);
  }

  function applyPersonalRailColors(root = document) {
    root.querySelectorAll?.('[data-alpha-limit-rail="true"]').forEach((rail) => {
      const chat = rail.parentElement;
      if (!chat?.querySelector?.('[data-testid="man-name"]')) return;
      if (isPersonalChatRow(chat)) rail.dataset.alphaPersonal = "true";
      else rail.removeAttribute("data-alpha-personal");
    });
  }

  function applyChatLimitBadges() {
    const chatLists = Array.from(document.querySelectorAll('[data-testid="chat-list"]'));
    if (!chatLists.length) return;

    for (const chatList of chatLists) {
      for (const [chatUid, limits] of chatLimitsByUid) {
        const escapedUid = globalThis.CSS?.escape
          ? CSS.escape(chatUid)
          : chatUid.replace(/["\\]/g, "\\$&");
        const chat = chatList.querySelector(`[data-testid="${escapedUid}"]`);
        const name = chat?.querySelector('[data-testid="man-name"]');
        if (!name) continue;
        name.querySelector('[data-alpha-chat-limits="true"]')?.remove();

        const rail = findChatLimitRail(chat);
        if (!rail) continue;
        rail.dataset.alphaLimitRail = "true";
        const manColor = normalizeManColor(limits.color);
        if (manColor) rail.dataset.alphaManColor = String(manColor);
        else rail.removeAttribute("data-alpha-man-color");

        const message = limits.messageLimit ?? "—";
        const letter = limits.letterLimit ?? "—";
        const icons = nativeLimitIcons(rail);
        const iconTypes = new Set();
        icons.forEach((icon) => {
          const type = nativeLimitIconType(icon);
          if (!type) return;
          iconTypes.add(type);
          icon.dataset.alphaNativeLimitIcon = type;
        });

        setSideLimit(rail, "message", message, 5, !iconTypes.has("message"));
        setSideLimit(rail, "letter", letter, 25, !iconTypes.has("letter"));
        rail.title = `Повідомлень: ${message} · Листів: ${letter}`;
      }
      applyPersonalRailColors(chatList);
    }
  }

  function requestChatLimitsReplay(mode = currentChatLimitsMode()) {
    if (!mode) return;
    window.postMessage({ type: CHAT_LIST_REPLAY_TYPE, mode }, location.origin);
  }

  function handleChatListResponse(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    const mode = data?.mode === "chance" ? "chance" : data?.mode === "all" ? "all" : "";
    if (
      data?.source !== "alpha-balance-page" ||
      data?.type !== CHAT_LIST_RESPONSE_TYPE ||
      !mode ||
      currentChatLimitsMode() !== mode ||
      !Array.isArray(data.entries)
    ) {
      return;
    }

    const page = Math.max(1, Math.floor(Number(data.page) || 1));
    if (page === 1) {
      chatLimitsByUid.clear();
      removeChatLimitBadges();
    }

    for (const entry of data.entries) {
      const chatUid = String(entry?.chat_uid || "").trim();
      if (!chatUid) continue;
      chatLimitsByUid.set(chatUid, {
        messageLimit: normalizeLimit(entry?.message_limit ?? entry?.messageLimit),
        letterLimit: normalizeLimit(entry?.letter_limit ?? entry?.letterLimit),
        color: normalizeManColor(entry?.color),
      });
    }

    chatLimitsMode = mode;
    applyChatLimitBadges();
  }

  async function updateChatLimits() {
    const requestMode = currentChatLimitsMode();
    if (!requestMode) {
      chatLimitsMode = "";
      chatLimitsByUid.clear();
      removeChatLimitBadges();
      return;
    }
    if (requestMode === "chance") {
      if (chatLimitsRequestInFlight) {
        chatLimitsRefreshPending = true;
        return;
      }
      if (chatLimitsMode !== "chance") {
        chatLimitsMode = "chance";
        requestChatLimitsReplay("chance");
      }
      return;
    }
    if (chatLimitsRequestInFlight) {
      chatLimitsRefreshPending = true;
      return;
    }
    if (document.hidden) return;
    chatLimitsRequestInFlight = true;

    try {
      const token = getToken();
      if (!token) {
        chatLimitsToken = "";
        chatLimitsMode = requestMode;
        chatLimitsByUid.clear();
        removeChatLimitBadges();
        return;
      }

      if (chatLimitsToken && chatLimitsToken !== token) {
        chatLimitsByUid.clear();
        removeChatLimitBadges();
      }
      chatLimitsToken = token;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(CHAT_LIST_API_PATH, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            accept: "application/json, text/plain, */*",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            user_id: "",
            chat_uid: false,
            page: 1,
            freeze: true,
            limits: null,
            ONLINE_STATUS: 1,
            SEARCH: "",
            CHAT_TYPE: "DEFAULT",
            blockedByMan: 0,
            blockedByWoman: 0,
            showHidden: 0,
          }),
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) throw new Error(`Alpha chat list API: ${response.status}`);
      const payload = await response.json();
      if (currentChatLimitsMode() !== requestMode) {
        chatLimitsRefreshPending = true;
        return;
      }
      const entries = extractChatList(payload);
      const nextLimits = new Map();

      for (const entry of entries) {
        const chatUid = String(entry?.chat_uid || "").trim();
        if (!chatUid) continue;
        nextLimits.set(chatUid, {
          messageLimit: normalizeLimit(entry?.message_limit ?? entry?.messageLimit),
          letterLimit: normalizeLimit(entry?.letter_limit ?? entry?.letterLimit),
          color: normalizeManColor(entry?.color),
        });
      }

      chatLimitsByUid.clear();
      nextLimits.forEach((value, key) => chatLimitsByUid.set(key, value));
      chatLimitsMode = requestMode;
      applyChatLimitBadges();
    } catch (error) {
      console.warn("Alpha Balance: не вдалося оновити залишки чатів", error);
      if (currentChatLimitsMode() === requestMode) {
        chatLimitsMode = requestMode;
        applyChatLimitBadges();
      }
    } finally {
      chatLimitsRequestInFlight = false;
      if (chatLimitsRefreshPending) {
        chatLimitsRefreshPending = false;
        queueMicrotask(updateChatLimits);
      }
    }
  }

  function updateAlphaData() {
    updateBalance();
    updateChatLimits();
  }

  function extractGroupedPayload(payload) {
    let grouped = null;
    if (Array.isArray(payload?.response)) {
      grouped = payload.response.find(
        (item) => item && typeof item === "object" && !Array.isArray(item)
      );
    } else if (payload?.response && typeof payload.response === "object") {
      grouped = payload.response;
    } else if (payload && typeof payload === "object") {
      grouped = payload;
    }

    return grouped;
  }

  function extractTotal(grouped) {
    const total = Number.parseFloat(grouped?.total);
    if (Number.isFinite(total)) return total;

    if (!grouped) return null;
    const calculated = Object.entries(grouped)
      .filter(([key]) => key !== "date" && key !== "total")
      .reduce((sum, [, value]) => {
        const amount = Number.parseFloat(value);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);
    return Number.isFinite(calculated) ? calculated : null;
  }

  function normalizeSnapshot(grouped) {
    const values = {};
    for (const [type, rawValue] of Object.entries(grouped || {})) {
      if (type === "date" || type === "total") continue;
      const value = Number.parseFloat(rawValue);
      if (Number.isFinite(value)) values[type] = value;
    }
    return values;
  }

  function recordNewCredits(values, total) {
    const day = todayKey();
    if (!previousSnapshot || previousSnapshot.date !== day) {
      previousSnapshot = { date: day, values, total };
      balanceHistory = [];
      renderHistory();
      return;
    }

    const detectedAt = Date.now();
    let categorizedIncrease = 0;
    const newItems = [];
    for (const [type, current] of Object.entries(values)) {
      const previous = Number(previousSnapshot.values?.[type] || 0);
      const delta = current - previous;
      if (delta > 0.0001) {
        categorizedIncrease += delta;
        newItems.push({ type, amount: delta, detectedAt });
      }
    }

    const totalIncrease = total - Number(previousSnapshot.total || 0);
    const unexplained = totalIncrease - categorizedIncrease;
    if (unexplained > 0.0001) {
      newItems.push({ type: "BALANCE_UPDATE", amount: unexplained, detectedAt });
    }

    if (newItems.length) {
      balanceHistory = [...newItems.reverse(), ...balanceHistory].slice(0, HISTORY_LIMIT);
    }
    previousSnapshot = { date: day, values, total };
    renderHistory();
  }

  async function updateBalance() {
    if (requestInFlight || document.hidden) return;
    requestInFlight = true;

    try {
      ensureWidget();
      const token = getToken();
      if (!token) throw new Error("Увійдіть в Alpha");

      if (lastValue === null) {
        setWidgetState("loading", "…", "Отримую актуальний баланс");
      }

      const today = todayKey();
      const params = new URLSearchParams({ date_from: today, date_to: today });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(`${API_PATH}?${params}`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          authorization: `Bearer ${token}`,
        },
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`Alpha API: ${response.status}`);
      const payload = await response.json();
      if (payload?.status === false) throw new Error("Alpha не повернула баланс");

      const grouped = extractGroupedPayload(payload);
      const total = extractTotal(grouped);
      if (total === null) throw new Error("Баланс відсутній у відповіді Alpha");

      recordNewCredits(normalizeSnapshot(grouped), total);
      lastValue = total;
      await persistBalanceState(total);
      const updatedAt = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setWidgetState(
        "ok",
        `${total.toFixed(2)}$`,
        `Оновлено о ${updatedAt}. Наступна перевірка через 30 секунд.`
      );
    } catch (error) {
      const fallback = lastValue === null ? "—" : `${lastValue.toFixed(2)}$`;
      setWidgetState("error", fallback, error?.message || "Не вдалося оновити баланс");
    } finally {
      requestInFlight = false;
    }
  }

  function schedulePolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(updateAlphaData, POLL_INTERVAL_MS);
  }

  const observer = new MutationObserver(schedulePlacement);

  async function start() {
    ensureWidget();
    ensureConversationShortcut();
    ensurePersonalQuickPanel();
    ensureLetterChatPanel();
    ensureQuickNavigation();
    ensureProfilesPanelPlacement();
    ensureLeftMenuHidden();
    await Promise.all([
      restoreCachedBalance(),
      restoreCachedPersonalChats(),
      restoreCachedPersonalPairs(),
    ]);
    requestPersonalInvitesReplay();
    schedulePlacement();
    updateBalance();
    scheduleChatLimitsForCurrentSection();
    schedulePolling();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", schedulePlacement, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateAlphaData();
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  window.addEventListener("message", handleChatListResponse);
  window.addEventListener("message", handlePersonalInvitesResponse);
})();
