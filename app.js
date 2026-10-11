// ============================================================
//  ZAP — этот файл работает в браузере
// ============================================================
//  Он делает всё, что видит и нажимает человек:
//  вход, список людей, переписку, файлы, изменение и удаление.
// ============================================================

// Короткая "находилка" элементов на странице по их id.
const el = (id) => document.getElementById(id);

// То, что программа помнит прямо сейчас.
let me = null;              // кто я (моя запись: номер и имя)
let peer = null;            // с кем я сейчас переписываюсь
let conversationId = null;  // номер текущей беседы
let socket = null;          // живой канал связи с сервером
let usersById = {};         // список людей: номер -> имя
let pendingAttachment = null; // файл, который я прикрепил, но ещё не отправил

// -------------------- ВХОД --------------------

// Если человек уже входил раньше, браузер помнит его — не спрашиваем имя снова.
const savedUser = localStorage.getItem("zap-user");
if (savedUser) {
  try {
    me = JSON.parse(savedUser);
  } catch {
    me = null;
  }
}

if (me) {
  startChat();
} else {
  el("screen-login").classList.remove("hidden");
}

el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = el("login-name").value.trim();
  if (!name) return;

  const answer = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => r.json());

  if (answer.error) {
    el("login-error").textContent = answer.error;
    return;
  }

  me = answer.user;
  localStorage.setItem("zap-user", JSON.stringify(me));
  startChat();
});

// -------------------- ОСНОВНОЙ ЭКРАН --------------------

function startChat() {
  el("screen-login").classList.add("hidden");
  el("screen-chat").classList.remove("hidden");
  el("my-name").textContent = me.name;

  connectLiveChannel();
  loadPeople();
}

el("logout-button").addEventListener("click", () => {
  localStorage.removeItem("zap-user");
  if (socket) socket.close();
  me = null;
  location.reload();
});

// -------------------- СПИСОК ЛЮДЕЙ --------------------

async function loadPeople() {
  const answer = await fetch("/api/users?me=" + me.id).then((r) => r.json());
  const people = answer.users || [];

  usersById = {};
  people.forEach((person) => (usersById[person.id] = person.name));

  const list = el("people-list");
  list.innerHTML = "";

  el("no-people").classList.toggle("hidden", people.length > 0);

  people.forEach((person) => {
    const item = document.createElement("li");
    item.dataset.person = String(person.id);
    if (peer && peer.id === person.id) item.classList.add("active");
    item.innerHTML =
      '<span class="avatar">' + escapeHtml(firstLetter(person.name)) + "</span>" +
      "<span>" + escapeHtml(person.name) + "</span>";
    item.addEventListener("click", () => openDialog(person));
    list.appendChild(item);
  });
}

// -------------------- ОТКРЫТЬ ПЕРЕПИСКУ --------------------

async function openDialog(person) {
  peer = person;
  clearAttachment();

  // Загружаем всю сохранённую переписку с этим человеком.
  const answer = await fetch("/api/messages?me=" + me.id + "&peer=" + person.id).then((r) => r.json());
  conversationId = answer.conversationId;

  el("placeholder").classList.add("hidden");
  el("dialog-header").classList.remove("hidden");
  el("messages").classList.remove("hidden");
  el("send-area").classList.remove("hidden");
  el("dialog-header").textContent = person.name;

  const box = el("messages");
  box.innerHTML = "";
  (answer.messages || []).forEach((message) => box.appendChild(createBubble(message)));
  box.scrollTop = box.scrollHeight;

  // Подсвечиваем выбранного человека в списке.
  document.querySelectorAll("#people-list li").forEach((li) => {
    li.classList.toggle("active", Number(li.dataset.person) === person.id);
  });

  el("send-text").focus();
}

// -------------------- ФАЙЛЫ И ФОТО --------------------

el("attach-button").addEventListener("click", () => el("attach-input").click());
el("attach-remove").addEventListener("click", clearAttachment);

el("attach-input").addEventListener("change", async () => {
  const file = el("attach-input").files[0];
  if (!file) return;

  el("attach-preview").classList.remove("hidden");
  el("attach-preview-content").textContent = "⏳ Загружаю " + file.name + "...";

  const form = new FormData();
  form.append("file", file);

  let answer;
  try {
    answer = await fetch("/api/upload", { method: "POST", body: form }).then((r) => r.json());
  } catch {
    answer = { error: "Не удалось загрузить файл" };
  }
  el("attach-input").value = "";

  if (answer.error) {
    alert(answer.error);
    clearAttachment();
    return;
  }

  pendingAttachment = answer;
  renderAttachment();
});

function renderAttachment() {
  const box = el("attach-preview");
  const content = el("attach-preview-content");

  if (!pendingAttachment) {
    box.classList.add("hidden");
    content.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  const a = pendingAttachment;
  if ((a.type || "").startsWith("image/")) {
    content.innerHTML =
      '<img src="/uploads/' + encodeURIComponent(a.file) + '" alt="" />' + escapeHtml(a.name);
  } else {
    content.textContent = "📄 " + a.name;
  }
}

function clearAttachment() {
  pendingAttachment = null;
  renderAttachment();
}

// -------------------- ОТПРАВКА СООБЩЕНИЯ --------------------

el("send-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el("send-text").value.trim();

  if (!text && !pendingAttachment) return;
  if (!peer) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    alert("Нет связи с сервером. Подождите пару секунд и попробуйте снова.");
    return;
  }

  // Отправляем через живой канал. Ответ вернётся сам — и мы его покажем.
  socket.send(JSON.stringify({ type: "send", to: peer.id, text, attachment: pendingAttachment }));
  el("send-text").value = "";
  clearAttachment();
  el("send-text").focus();
});

// -------------------- ЖИВОЙ КАНАЛ --------------------

function connectLiveChannel() {
  const address = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?userId=" + me.id;
  socket = new WebSocket(address);

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    // Пришло новое сообщение.
    if (data.type === "message") {
      const parties = data.participants || [];
      const involvesMe = parties.includes(me.id);
      const involvesPeer = peer && parties.includes(peer.id);
      if (involvesMe && involvesPeer) {
        conversationId = data.message.conversation_id;
        appendBubble(data.message);
      }
      return;
    }

    // Сообщение изменили — перерисовываем его у всех.
    if (data.type === "edited") {
      const old = document.querySelector('.bubble[data-id="' + data.message.id + '"]');
      if (old) old.replaceWith(createBubble(data.message));
      return;
    }

    // Сообщение удалили — убираем его у всех.
    if (data.type === "deleted") {
      const old = document.querySelector('.bubble[data-id="' + data.id + '"]');
      if (old) old.remove();
      return;
    }

    // Список людей изменился (кто-то новый зашёл).
    if (data.type === "users") {
      loadPeople();
    }
  });

  // Если связь оборвалась — тихонько пробуем снова.
  socket.addEventListener("close", () => {
    if (me) setTimeout(connectLiveChannel, 2000);
  });
}

// -------------------- ПОКАЗ СООБЩЕНИЙ --------------------

function appendBubble(message) {
  const box = el("messages");
  box.appendChild(createBubble(message));
  box.scrollTop = box.scrollHeight;
}

function createBubble(message) {
  const isMine = message.sender_id === me.id;

  const bubble = document.createElement("div");
  bubble.className = "bubble " + (isMine ? "own" : "other");
  bubble.dataset.id = message.id;

  let html = "";

  // Прикреплённый файл или фото.
  if (message.attachment_file) {
    const url = "/uploads/" + encodeURIComponent(message.attachment_file);
    if ((message.attachment_type || "").startsWith("image/")) {
      html += '<img class="attachment-image" src="' + url + '" alt="фото" />';
    } else {
      html +=
        '<a class="attachment-file" href="' + url + '" target="_blank" download="' +
        escapeHtml(message.attachment_name || "файл") + '">📄 ' +
        escapeHtml(message.attachment_name || "файл") + "</a>";
    }
  }

  // Текст сообщения.
  if (message.text) {
    html += "<span>" + escapeHtml(message.text) + "</span>";
  }

  // Время и отметка «изменено».
  html +=
    '<span class="time">' + formatTime(message.created_at) +
    (message.edited_at ? " · изменено" : "") + "</span>";

  bubble.innerHTML = html;

  // Клик по фото — открыть его в новой вкладке.
  const image = bubble.querySelector(".attachment-image");
  if (image) image.addEventListener("click", () => window.open(image.src, "_blank"));

  // Для своих сообщений добавляем кнопки «изменить» и «удалить».
  if (isMine) {
    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    actions.innerHTML =
      '<button type="button" data-act="edit" title="Изменить">✏️</button>' +
      '<button type="button" data-act="delete" title="Удалить">🗑️</button>';

    actions.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit(bubble, message);
    });
    actions.querySelector('[data-act="delete"]').addEventListener("click", (e) => {
      e.stopPropagation();
      removeMessage(message);
    });

    bubble.appendChild(actions);
  }

  return bubble;
}

// -------------------- ИЗМЕНИТЬ СВОЁ СООБЩЕНИЕ --------------------

function startEdit(bubble, message) {
  bubble.classList.add("editing");
  bubble.innerHTML =
    '<textarea class="edit-text"></textarea>' +
    '<div class="edit-actions">' +
    '<button type="button" class="save">Сохранить</button>' +
    '<button type="button" class="cancel">Отмена</button>' +
    "</div>";

  const area = bubble.querySelector(".edit-text");
  area.value = message.text || "";
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  bubble.querySelector(".save").addEventListener("click", async () => {
    const text = area.value.trim();
    if (!text) {
      alert("Сообщение не может быть пустым.");
      return;
    }
    const answer = await fetch("/api/messages/" + message.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: me.id, text }),
    }).then((r) => r.json());

    if (answer.error) {
      alert(answer.error);
      return;
    }
    // Дальше сервер сам пришлёт «edited», и сообщение перерисуется.
  });

  bubble.querySelector(".cancel").addEventListener("click", () => {
    bubble.replaceWith(createBubble(message));
  });
}

// -------------------- УДАЛИТЬ СВОЁ СООБЩЕНИЕ --------------------

async function removeMessage(message) {
  if (!confirm("Удалить это сообщение?")) return;

  const answer = await fetch(
    "/api/messages/" + message.id + "?userId=" + me.id,
    { method: "DELETE" }
  ).then((r) => r.json());

  if (answer.error) alert(answer.error);
}

// -------------------- МАЛЕНЬКИЕ ПОМОЩНИКИ --------------------

function formatTime(value) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Первая буква имени — для кружка-аватарки.
function firstLetter(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

// Защита от вредных символов в тексте.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
