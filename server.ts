// ============================================================
//  ЭТО ГЛАВНЫЙ ФАЙЛ ПРОГРАММЫ (СЕРВЕР)
// ============================================================
//  Он делает четыре вещи:
//   1) отдаёт браузеру страницу мессенджера;
//   2) отвечает на запросы: "войти", "список людей", "переписка";
//   3) принимает прикреплённые файлы и фото;
//   4) держит живой канал связи, чтобы сообщения приходили мгновенно.
// ============================================================

import express from "express";
import http from "node:http";
import path from "node:path";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import * as storage from "./db";

const app = express();
app.use(express.json()); // учим сервер понимать данные, присланные из браузера

// Отдаём браузеру три файла страницы Zap — они лежат рядом с этим файлом.
// Мы перечисляем их явно, чтобы наружу не попали лишние файлы (например, база данных).
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));

// Отдаём браузеру прикреплённые файлы и фото.
app.use("/uploads", express.static(storage.uploadsDir));

// ============================================================
//  ПРИЁМ ФАЙЛОВ И ФОТО
// ============================================================
//  multer — это помощник, который принимает файл, отправленный из браузера,
//  и кладёт его в папку data/uploads под новым (случайным) именем.
//  Так два файла с одинаковым названием не затрут друг друга.
const upload = multer({
  storage: multer.diskStorage({
    destination: storage.uploadsDir,
    filename: (_req, file, done) => {
      const ext = path.extname(file.originalname);
      const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      done(null, unique + ext);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // не больше 15 МБ на файл
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Файл не получен" });
  }
  // Браузер присылает русские имена файлов в «сыром» виде — приводим в порядок.
  let originalName = req.file.originalname;
  try {
    originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  } catch {
    /* оставляем как есть */
  }

  res.json({
    file: req.file.filename,
    name: originalName,
    type: req.file.mimetype,
  });
});

// ============================================================
//  ЗАПРОСЫ ОТ БРАУЗЕРА (обычные: вопрос — ответ)
// ============================================================

// "Войти": пользователь ввёл имя — находим его или создаём нового.
app.post("/api/login", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 32) {
    return res.status(400).json({ error: "Введите имя от 1 до 32 символов" });
  }
  const user = storage.findOrCreateUser(name);
  broadcastUserList(); // сообщаем всем открытым окнам: появился новый человек
  res.json({ user });
});

// "Дай список людей, с кем можно общаться".
app.get("/api/users", (req, res) => {
  const me = Number(req.query.me);
  if (!Number.isInteger(me)) {
    return res.status(400).json({ error: "Не указан пользователь" });
  }
  res.json({ users: storage.listUsers(me) });
});

// "Дай всю переписку меня и выбранного человека".
// Важно: здесь мы СРАЗУ создаём беседу, если её ещё не было.
// Именно поэтому отправитель теперь видит свои первые сообщения.
app.get("/api/messages", (req, res) => {
  const me = Number(req.query.me);
  const peer = Number(req.query.peer);
  if (!Number.isInteger(me) || !Number.isInteger(peer)) {
    return res.status(400).json({ error: "Не указаны собеседники" });
  }
  if (!storage.getUser(me) || !storage.getUser(peer)) {
    return res.status(400).json({ error: "Неизвестный пользователь" });
  }
  const conversationId = storage.findOrCreateConversation(me, peer);
  res.json({ conversationId, messages: storage.getMessages(conversationId) });
});

// "Изменить моё сообщение".
app.put("/api/messages/:id", (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.body?.userId);
  const text = String(req.body?.text ?? "").trim();

  if (!text || text.length > 2000) {
    return res.status(400).json({ error: "Текст от 1 до 2000 символов" });
  }

  const message = storage.updateMessageText(id, userId, text);
  if (!message) {
    return res.status(403).json({ error: "Можно изменять только свои сообщения" });
  }

  // Сообщаем обоим собеседникам, что сообщение изменилось.
  broadcastToUsers(storage.getConversationUsers(message.conversation_id), {
    type: "edited",
    message,
  });
  res.json({ message });
});

// "Удалить моё сообщение".
app.delete("/api/messages/:id", (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.query.userId);

  const message = storage.deleteMessage(id, userId);
  if (!message) {
    return res.status(403).json({ error: "Можно удалять только свои сообщения" });
  }

  broadcastToUsers(storage.getConversationUsers(message.conversation_id), {
    type: "deleted",
    id: message.id,
    conversationId: message.conversation_id,
  });
  res.json({ ok: true });
});

// ============================================================
//  ЖИВОЙ КАНАЛ (WebSocket) — благодаря ему сообщения приходят
//  сразу, без перезагрузки страницы.
// ============================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Здесь запоминаем, кто сейчас "на связи": номер пользователя -> его окна.
const online = new Map<number, Set<WebSocket>>();

// Отправить сообщение всем окнам указанных людей.
function broadcastToUsers(userIds: number[], payload: unknown) {
  const text = JSON.stringify(payload);
  for (const userId of userIds) {
    for (const socket of online.get(userId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }
}

// Сообщить всем открытым окнам, что список людей изменился.
function broadcastUserList() {
  const text = JSON.stringify({ type: "users" });
  for (const sockets of online.values()) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }
}

// Когда браузер подключается к живому каналу.
wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "", "http://localhost");
  const userId = Number(url.searchParams.get("userId"));

  // Если номер некорректный — закрываем соединение.
  if (!Number.isInteger(userId) || !storage.getUser(userId)) {
    socket.close();
    return;
  }

  // Записываем это окно в список "на связи".
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId)!.add(socket);

  // Когда окно закрывается — убираем его из списка.
  socket.on("close", () => {
    const set = online.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) online.delete(userId);
  });

  // Когда приходит новое сообщение из браузера.
  socket.on("message", (raw) => {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // мусор — игнорируем
    }
    if (data?.type !== "send") return;

    const to = Number(data.to);
    const text = String(data.text ?? "").trim();

    // Прикреплённый файл (если есть).
    const attachment =
      data.attachment && typeof data.attachment.file === "string"
        ? {
            file: String(data.attachment.file),
            name: String(data.attachment.name ?? "файл"),
            type: String(data.attachment.type ?? ""),
          }
        : null;

    if (!Number.isInteger(to) || !storage.getUser(to)) return;
    if (text.length > 2000) return;
    if (!text && !attachment) return; // пустое сообщение отправлять нельзя

    // Сохраняем сообщение в базу — значит, оно не потеряется.
    const conversationId = storage.findOrCreateConversation(userId, to);
    const message = storage.addMessage(conversationId, userId, text, attachment);
    const participants = storage.getConversationUsers(conversationId);

    // Рассылаем сообщение ОБОИМ: и отправителю, и получателю.
    // Благодаря этому вы видите и свои сообщения тоже.
    broadcastToUsers(participants, { type: "message", message, participants });
  });
});

// ============================================================
//  ЗАПУСК
// ============================================================
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log("");
  console.log("  Мессенджер запущен!");
  console.log("  Откройте в браузере:  http://localhost:" + PORT);
  console.log("  Чтобы остановить — нажмите Ctrl + C");
  console.log("");
});
