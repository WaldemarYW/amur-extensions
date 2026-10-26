(() => {
  "use strict";

  if (window.top !== window || window.__AMUR_AUTOLIKE__) return;
  window.__AMUR_AUTOLIKE__ = true;

  const MESSAGE_SOURCE = "alpha-balance-page";
  const EVENT_TYPE = "AMUR_AUTOLIKE_INCOMING_REACTION";
  const QUEUE_KEY = "amurAutolikeQueueV1";
  const PROFILES_KEY = "amurAutolikeProfilesV1";
  const DELAY_MS = 6 * 60 * 1000;
  const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_QUEUE_SIZE = 500;
  const LOCK_NAME = "amur-autolike-queue";
  let queue = [];
  let profiles = [];
  let timer = null;
  let processing = false;

  const digits = (value) => String(value ?? "").replace(/\D/g, "");
  const getToken = () => String(localStorage.getItem("token") || "").trim();
  const storageGet = (keys) => chrome.storage.local.get(keys);
  const storageSet = (values) => chrome.storage.local.set(values);

  function normalizeQueue(value) {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    return (Array.isArray(value) ? value : [])
      .filter((job) => Number(job?.createdAt) >= cutoff)
      .slice(-MAX_QUEUE_SIZE);
  }

  async function reloadQueue() {
    const stored = await storageGet(QUEUE_KEY);
    queue = normalizeQueue(stored?.[QUEUE_KEY]);
  }

  async function saveQueue() {
    queue = normalizeQueue(queue);
    await storageSet({ [QUEUE_KEY]: queue });
  }

  async function withQueueLock(callback) {
    if (!navigator.locks?.request) return callback();
    return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined;
      await reloadQueue();
      return callback();
    });
  }

  async function refreshProfiles() {
    const token = getToken();
    if (!token) throw new Error("no_token");
    const response = await fetch("https://alpha.date/api/operator/profiles", {
      credentials: "include",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`profiles_${response.status}`);
    const payload = await response.json();
    const candidates = [];
    const visited = new WeakSet();
    const visit = (value) => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (!Array.isArray(value)) {
        const externalId = digits(value.external_id ?? value.externalId ?? value.id);
        if (externalId && (value.name != null || value.age != null || value.woman_age != null)) {
          candidates.push({ externalId, name: String(value.name || "").trim() });
        }
      }
      Object.values(value).forEach(visit);
    };
    visit(payload);
    profiles = Array.from(new Map(candidates.map((profile) => [profile.externalId, profile])).values());
    if (!profiles.length) throw new Error("profiles_empty");
    await storageSet({ [PROFILES_KEY]: profiles });
  }

  function findPair(payload) {
    const profileMap = new Map(profiles.map((profile) => [digits(profile.externalId), profile]));
    const female = digits(payload?.female_id);
    const male = digits(payload?.male_external_id);
    if (female && male && profileMap.has(female)) {
      return { womanId: female, manId: male, profile: profileMap.get(female) };
    }

    const sender = digits(payload?.sender_external_id);
    const recipient = digits(payload?.recipient_external_id);
    const senderProfile = profileMap.get(sender);
    const recipientProfile = profileMap.get(recipient);
    if (!!senderProfile === !!recipientProfile) return null;
    return senderProfile
      ? { womanId: sender, manId: recipient, profile: senderProfile }
      : { womanId: recipient, manId: sender, profile: recipientProfile };
  }

  async function getHistory(job) {
    const response = await fetch("https://alpha.date/api/chatList/chatHistory", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ chat_id: job.chatUid, page: 1 }),
    });
    if (!response.ok) throw new Error(`history_${response.status}`);
    return response.json();
  }

  function messageRows(payload) {
    const result = [];
    const visited = new WeakSet();
    const visit = (value) => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) return value.forEach(visit);
      if (value.message_type || value.messageType) result.push(value);
      Object.values(value).forEach(visit);
    };
    visit(payload);
    return result;
  }

  function alreadyLiked(payload, job) {
    const eventAt = Date.parse(job.eventAt || "");
    return messageRows(payload).some((row) => {
      if (String(row.message_type || row.messageType || "").toUpperCase() !== "SENT_LIKE") {
        return false;
      }
      if (digits(row.sender_external_id ?? row.sender_id) !== job.womanId) return false;
      if (digits(row.recipient_external_id ?? row.recipient_id) !== job.manId) return false;
      const sentAt = Date.parse(row.created_at || row.date_created || "");
      return !Number.isFinite(eventAt) || !Number.isFinite(sentAt) || sentAt >= eventAt - 5000;
    });
  }

  async function sendLike(job) {
    const response = await fetch("https://alpha.date/api/chat/message", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({
        chat_uid: job.chatUid,
        sender_id: Number(job.womanId) || job.womanId,
        recipient_id: Number(job.manId) || job.manId,
        message_content: `${job.profileName || "Profile"} liked your profile`,
        message_type: "SENT_LIKE",
        filename: "",
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status !== true) {
      const error = new Error(`send_${response.status}`);
      error.permanent = response.status >= 400 && response.status < 500;
      throw error;
    }
  }

  async function runJob(job) {
    if (!getToken()) throw new Error("no_token");
    const history = await getHistory(job);
    if (alreadyLiked(history, job)) {
      job.status = "done";
      job.result = "operator_liked";
      return;
    }
    await sendLike(job);
    job.status = "done";
    job.result = "liked";
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    const pending = queue.filter((job) => job.status === "pending");
    if (!pending.length) return;
    const next = Math.min(...pending.map((job) => Number(job.runAt) || Date.now()));
    timer = setTimeout(processQueue, Math.min(2_147_483_647, Math.max(0, next - Date.now())));
  }

  async function processQueueUnlocked() {
    if (processing) return;
    processing = true;
    try {
      const due = queue.filter((job) => job.status === "pending" && job.runAt <= Date.now());
      for (const job of due) {
        try {
          await runJob(job);
          job.lastError = "";
        } catch (error) {
          job.attempts = (job.attempts || 0) + 1;
          job.lastError = String(error?.message || error);
          if (error?.permanent || job.attempts >= 3) {
            job.status = "done";
            job.result = "failed";
          } else {
            job.runAt = Date.now() + Math.min(15, job.attempts * 3) * 60_000;
          }
        }
      }
      await saveQueue();
    } finally {
      processing = false;
      schedule();
    }
  }

  async function processQueue() {
    await withQueueLock(processQueueUnlocked);
  }

  async function enqueueReaction(payload) {
    if (!profiles.length) await refreshProfiles().catch(() => {});
    const pair = findPair(payload);
    const chatUid = String(payload?.chat_uid || "").trim();
    if (!pair || !chatUid) return;
    const key = payload?.notification_id
      ? `notification:${payload.notification_id}`
      : `${chatUid}:${pair.womanId}:${pair.manId}:${payload?.created_at || ""}`;

    await withQueueLock(async () => {
      if (queue.some((job) => job.key === key)) return;
      queue.push({
        key,
        chatUid,
        womanId: pair.womanId,
        manId: pair.manId,
        profileName: pair.profile.name || "Profile",
        eventAt: payload?.created_at || new Date().toISOString(),
        createdAt: Date.now(),
        runAt: Date.now() + DELAY_MS,
        status: "pending",
        attempts: 0,
      });
      await saveQueue();
    });
    schedule();
  }

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.origin === location.origin &&
      event.data?.source === MESSAGE_SOURCE &&
      event.data?.type === EVENT_TYPE
    ) {
      enqueueReaction(event.data.payload || {}).catch(() => {});
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes[QUEUE_KEY]) return;
    queue = normalizeQueue(changes[QUEUE_KEY].newValue);
    schedule();
  });

  async function start() {
    const stored = await storageGet([QUEUE_KEY, PROFILES_KEY]);
    queue = normalizeQueue(stored?.[QUEUE_KEY]);
    profiles = Array.isArray(stored?.[PROFILES_KEY]) ? stored[PROFILES_KEY] : [];
    await saveQueue();
    schedule();
    processQueue().catch(() => {});
    refreshProfiles().catch(() => {});
    setInterval(() => refreshProfiles().catch(() => {}), 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) processQueue().catch(() => {});
    });
  }

  start().catch(() => {});
})();
