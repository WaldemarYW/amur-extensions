(() => {
  "use strict";

  const API_PATH = "/api/chatList/chatListByUserID";
  const PERSONAL_INVITES_API_PATH = "/api/personal-invites/personal-invites-list";
  const MESSAGE_SOURCE = "alpha-balance-page";
  const RESPONSE_TYPE = "ALPHA_BALANCE_CHAT_LIST";
  const REPLAY_TYPE = "ALPHA_BALANCE_CHAT_LIST_REPLAY_REQUEST";
  const PERSONAL_RESPONSE_TYPE = "ALPHA_BALANCE_PERSONAL_INVITES";
  const PERSONAL_REPLAY_TYPE = "ALPHA_BALANCE_PERSONAL_INVITES_REPLAY_REQUEST";
  const AUTOLIKE_EVENT_TYPE = "AMUR_AUTOLIKE_INCOMING_REACTION";
  const seenReactions = new Map();
  let personalEntries = null;
  const pagesByMode = new Map([
    ["all", new Map()],
    ["chance", new Map()],
  ]);

  function isChatListUrl(input) {
    try {
      const raw = typeof input === "string" ? input : input?.url;
      return new URL(String(raw || ""), location.href).pathname === API_PATH;
    } catch {
      return false;
    }
  }

  function isPersonalInvitesUrl(input) {
    try {
      const raw = typeof input === "string" ? input : input?.url;
      return new URL(String(raw || ""), location.href).pathname === PERSONAL_INVITES_API_PATH;
    } catch {
      return false;
    }
  }

  function parseRequestBody(body) {
    if (!body) return null;
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    }
    return typeof body === "object" && !(body instanceof FormData) ? body : null;
  }

  function chatListRequestInfo(body) {
    const parsed = parseRequestBody(body);
    const chatType = String(parsed?.CHAT_TYPE || "").toUpperCase();
    const mode = chatType === "CHANCE" ? "chance" : chatType === "DEFAULT" ? "all" : "";
    if (!mode) return null;
    const rawPage = Number(parsed?.page);
    return {
      mode,
      page: Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1,
    };
  }

  function extractEntries(payload) {
    const response = payload?.response;
    const list = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

    return list
      .map((entry) => ({
        chat_uid: String(entry?.chat_uid || "").trim(),
        message_limit: entry?.message_limit ?? entry?.messageLimit ?? null,
        letter_limit: entry?.letter_limit ?? entry?.letterLimit ?? null,
        color: entry?.color ?? 0,
      }))
      .filter((entry) => entry.chat_uid);
  }

  function extractPersonalEntries(payload) {
    const lists = [
      ...(Array.isArray(payload?.newList) ? payload.newList : []),
      ...(Array.isArray(payload?.historyList) ? payload.historyList : []),
    ];
    const seen = new Set();
    return lists
      .map((entry) => {
        const type = String(entry?.type || "").toUpperCase();
        if (type !== "PERSONALISED_INVITE" && type !== "PERSONALISED_LETTER") return null;
        const womanExternalId = String(
          entry?.woman_external_id ?? entry?.womanExternalId ?? ""
        ).trim();
        const manExternalId = String(
          entry?.man_external_id ?? entry?.manExternalId ?? ""
        ).trim();
        if (!womanExternalId || !manExternalId) return null;
        const key = `${womanExternalId}:${manExternalId}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          woman_external_id: womanExternalId,
          man_external_id: manExternalId,
          alias_name: String(entry?.userProfileAlias?.name || "").trim(),
          alias_age: Number(entry?.userProfileAlias?.age) || null,
        };
      })
      .filter(Boolean);
  }

  function postPage(mode, page, entries) {
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: RESPONSE_TYPE,
        mode,
        page,
        entries,
      },
      location.origin
    );
  }

  function rememberAndPost(payload, mode, page) {
    const entries = extractEntries(payload);
    const pages = pagesByMode.get(mode);
    if (!pages) return;
    if (page === 1) pages.clear();
    pages.set(page, entries);
    postPage(mode, page, entries);
  }

  function postPersonalEntries(entries) {
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: PERSONAL_RESPONSE_TYPE,
        entries,
      },
      location.origin
    );
  }

  function rememberAndPostPersonal(payload) {
    if (!payload || (!Array.isArray(payload.newList) && !Array.isArray(payload.historyList))) {
      return;
    }
    personalEntries = extractPersonalEntries(payload);
    postPersonalEntries(personalEntries);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const responsePromise = originalFetch.apply(this, args);
      try {
        const [input, init] = args;
        const requestInfo = isChatListUrl(input) ? chatListRequestInfo(init?.body) : null;
        const requestMethod = String(init?.method || input?.method || "GET").toUpperCase();
        const personalRequest =
          requestMethod === "GET" && isPersonalInvitesUrl(input);
        if (requestInfo) {
          responsePromise.then((response) => {
            if (!response?.ok) return;
            response
              .clone()
              .json()
              .then((payload) => {
                rememberAndPost(payload, requestInfo.mode, requestInfo.page);
              })
              .catch(() => {});
          });
        }
        if (personalRequest) {
          responsePromise.then((response) => {
            if (!response?.ok) return;
            response.clone().json().then(rememberAndPostPersonal).catch(() => {});
          });
        }
      } catch {}
      return responsePromise;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requestMeta = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requestMeta.set(this, { method: String(method || "GET").toUpperCase(), url });
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = requestMeta.get(this);
    const requestInfo =
      meta?.method === "POST" && isChatListUrl(meta.url)
        ? chatListRequestInfo(body)
        : null;
    const personalRequest = meta?.method === "GET" && isPersonalInvitesUrl(meta.url);
    if (requestInfo || personalRequest) {
      this.addEventListener(
        "load",
        () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const payload =
              this.responseType === "json" ? this.response : JSON.parse(this.responseText || "null");
            if (requestInfo) rememberAndPost(payload, requestInfo.mode, requestInfo.page);
            if (personalRequest) rememberAndPostPersonal(payload);
          } catch {}
        },
        { once: true }
      );
    }
    return originalSend.call(this, body);
  };

  function findFirst(value, keys, visited = new WeakSet()) {
    if (!value || typeof value !== "object" || visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirst(item, keys, visited);
        if (found != null) return found;
      }
      return null;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) {
        return value[key];
      }
    }
    for (const child of Object.values(value)) {
      const found = findFirst(child, keys, visited);
      if (found != null) return found;
    }
    return null;
  }

  function postIncomingReaction(payload) {
    const key = [
      payload.notification_id,
      payload.chat_uid,
      payload.sender_external_id,
      payload.recipient_external_id,
      payload.created_at,
    ].join(":");
    const now = Date.now();
    if (seenReactions.has(key) && now - seenReactions.get(key) < 10_000) return;
    seenReactions.set(key, now);
    if (seenReactions.size > 1000) {
      for (const [item, timestamp] of seenReactions) {
        if (now - timestamp > 300_000) seenReactions.delete(item);
      }
    }
    window.postMessage(
      { source: MESSAGE_SOURCE, type: AUTOLIKE_EVENT_TYPE, payload },
      location.origin
    );
  }

  function inspectSocketMessage(data) {
    try {
      let parsed = data;
      if (typeof parsed === "string") {
        let text = parsed.trim();
        if (text.startsWith("42")) text = text.slice(2);
        if (!text.startsWith("{") && !text.startsWith("[")) return;
        parsed = JSON.parse(text);
      }
      if (!parsed || typeof parsed !== "object") return;

      const action = Array.isArray(parsed) ? String(parsed[0] || "") : "";
      const root = Array.isArray(parsed) && parsed.length > 1 ? parsed[1] : parsed;
      const source = root?.message_object && typeof root.message_object === "object"
        ? root.message_object
        : root;
      const socketType = String(
        findFirst(source, ["message_type", "messageType", "type"]) || ""
      ).toUpperCase();
      const normalizedAction = String(findFirst(root, ["action"]) || action).toUpperCase();
      const messageType = normalizedAction === "MESSAGE"
        ? socketType
        : normalizedAction || socketType;
      const isMale = Number(findFirst(source, ["is_male", "isMale"]));
      const incomingMaleLike = messageType === "SENT_LIKE" && isMale === 1;
      if (messageType !== "LIKED" && messageType !== "SENT_WINK" && !incomingMaleLike) {
        return;
      }

      postIncomingReaction({
        message_type: messageType,
        is_male: Number.isFinite(isMale) ? isMale : null,
        chat_uid:
          findFirst(source, ["chat_uid", "chatUid"]) ||
          findFirst(root, ["chat_uid", "chatUid"]) ||
          "",
        sender_external_id: findFirst(source, ["sender_external_id", "senderExternalId"]),
        recipient_external_id: findFirst(source, ["recipient_external_id", "recipientExternalId"]),
        female_id: findFirst(root, ["female_id", "femaleId", "female_external_id"]),
        male_external_id: findFirst(root, ["male_external_id", "maleExternalId", "male_id"]),
        notification_id:
          findFirst(root, ["notification_id", "notificationId"]) ||
          findFirst(source, ["notification_id", "notificationId", "id"]) ||
          "",
        created_at:
          findFirst(source, ["created_at", "createdAt", "date_created"]) ||
          new Date().toISOString(),
      });
    } catch {}
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function") {
    window.WebSocket = function AmurWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      socket.addEventListener("message", (event) => inspectSocketMessage(event.data));
      return socket;
    };
    window.WebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(window.WebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === REPLAY_TYPE) {
      const mode = event.data?.mode === "chance" ? "chance" : "all";
      [...(pagesByMode.get(mode)?.entries() || [])]
        .sort(([a], [b]) => a - b)
        .forEach(([page, entries]) => postPage(mode, page, entries));
    }
    if (event.data?.type === PERSONAL_REPLAY_TYPE && Array.isArray(personalEntries)) {
      postPersonalEntries(personalEntries);
    }
  });
})();
