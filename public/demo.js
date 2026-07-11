(() => {
  "use strict";

  const MAX_LOG_ENTRIES = 80;
  const elements = {
    channelName: document.querySelector("#channel-name"),
    clearLog: document.querySelector("#clear-log"),
    connectionPill: document.querySelector("#connection-pill"),
    connectionState: document.querySelector("#connection-state"),
    eventLog: document.querySelector("#event-log"),
    guestName: document.querySelector("#guest-name"),
    memberCount: document.querySelector("#member-count"),
    memberList: document.querySelector("#member-list"),
    messageForm: document.querySelector("#message-form"),
    messageInput: document.querySelector("#message-input"),
    nodeId: document.querySelector("#node-id"),
    sendButton: document.querySelector("#send-button"),
    socketId: document.querySelector("#socket-id"),
  };

  let channel;
  const identity = getIdentity();
  elements.guestName.textContent = `You are ${identity.name} · ${identity.id}`;
  elements.clearLog.addEventListener("click", () => {
    elements.eventLog.replaceChildren();
  });
  elements.messageForm.addEventListener("submit", sendClientEvent);

  initialize().catch((error) => {
    setConnectionState("failed");
    addLog("startup:error", formatError(error));
  });

  async function initialize() {
    if (typeof window.Pusher !== "function") {
      throw new Error("pusher-js failed to load from the CDN");
    }

    const response = await fetch("/demo/config", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Demo configuration failed with HTTP ${response.status}`);
    }
    const config = await response.json();
    elements.channelName.textContent = config.channel;

    const secure = window.location.protocol === "https:";
    const port = Number(window.location.port || (secure ? 443 : 80));
    const pusher = new window.Pusher(config.appKey, {
      cluster: "mt1",
      wsHost: window.location.hostname,
      wsPort: port,
      wssPort: port,
      forceTLS: secure,
      enabledTransports: ["ws"],
      disableStats: true,
      channelAuthorization: {
        endpoint: "/demo/auth",
        transport: "ajax",
        params: {
          user_id: identity.id,
          user_info: JSON.stringify({ name: identity.name }),
        },
      },
    });

    pusher.connection.bind("state_change", ({ current }) => {
      setConnectionState(current);
      addLog("connection", current);
      if (current !== "connected") {
        elements.sendButton.disabled = true;
      }
    });
    pusher.connection.bind("connected", () => {
      elements.socketId.textContent = pusher.connection.socket_id;
    });
    pusher.connection.bind("error", (error) => {
      addLog("connection:error", formatError(error));
    });
    pusher.bind("pulsews:node", ({ node_id: nodeId }) => {
      elements.nodeId.textContent = nodeId;
      addLog("node", nodeId);
    });

    channel = pusher.subscribe(config.channel);
    channel.bind("pusher:subscription_succeeded", (members) => {
      renderMembers(members);
      elements.sendButton.disabled = false;
      addLog("presence:ready", `${members.count} member(s)`);
    });
    channel.bind("pusher:subscription_error", (error) => {
      elements.sendButton.disabled = true;
      addLog("presence:error", formatError(error));
    });
    channel.bind("pusher:member_added", (member) => {
      renderMembers(channel.members);
      addLog("member:joined", memberLabel(member));
    });
    channel.bind("pusher:member_removed", (member) => {
      renderMembers(channel.members);
      addLog("member:left", memberLabel(member));
    });
    channel.bind("client-demo-message", (data, metadata) => {
      const sender = metadata?.user_id ?? "unknown";
      addLog("client:message", `${sender}: ${data.text ?? ""}`);
    });
  }

  function sendClientEvent(event) {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    if (!channel?.subscribed || text.length === 0) {
      return;
    }

    const sent = channel.trigger("client-demo-message", {
      text,
      sentAt: new Date().toISOString(),
    });
    addLog(sent ? "client:sent" : "client:failed", text);
    if (sent) {
      elements.messageInput.value = "";
    }
  }

  function renderMembers(members) {
    const entries = [];
    members.each((member) => entries.push(member));
    entries.sort((left, right) => left.id.localeCompare(right.id));
    elements.memberList.replaceChildren();
    elements.memberCount.textContent = String(members.count);

    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "Nobody is present yet.";
      elements.memberList.append(empty);
      return;
    }

    for (const member of entries) {
      const item = document.createElement("li");
      item.className = "member";
      const avatar = document.createElement("span");
      avatar.className = "member-avatar";
      avatar.textContent = memberLabel(member).slice(0, 1).toUpperCase();
      const details = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = memberLabel(member);
      const id = document.createElement("small");
      id.textContent = member.id;
      details.append(name, id);
      item.append(avatar, details);
      elements.memberList.append(item);
    }
  }

  function addLog(kind, value) {
    const item = document.createElement("li");
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });
    const eventKind = document.createElement("span");
    eventKind.className = "event-kind";
    eventKind.textContent = kind;
    const data = document.createElement("span");
    data.className = "event-data";
    data.textContent = typeof value === "string" ? value : JSON.stringify(value);
    item.append(time, eventKind, data);
    elements.eventLog.prepend(item);

    while (elements.eventLog.children.length > MAX_LOG_ENTRIES) {
      elements.eventLog.lastElementChild.remove();
    }
  }

  function setConnectionState(state) {
    elements.connectionPill.dataset.state = state;
    elements.connectionState.textContent = state.replaceAll("_", " ");
  }

  function getIdentity() {
    const storageKey = "pulsews-demo-identity";
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      return JSON.parse(existing);
    }

    const suffix = crypto.randomUUID().slice(0, 6);
    const identity = { id: `guest-${suffix}`, name: `Guest ${suffix}` };
    sessionStorage.setItem(storageKey, JSON.stringify(identity));
    return identity;
  }

  function memberLabel(member) {
    return member.info?.name || member.id;
  }

  function formatError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
})();
