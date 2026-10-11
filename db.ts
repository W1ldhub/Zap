// ============================================================
//  ЭТОТ ФАЙЛ ОТВЕЧАЕТ ЗА ХРАНЕНИЕ ДАННЫХ
// ============================================================
//  Все данные лежат в одном файле базы данных: data/messenger.db
//  База называется SQLite. Это как обычная таблица Excel:
//  есть листы (таблицы) со строками. Ничего устанавливать не надо.
// ============================================================

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// 1. Создаём папку "data" (и подпапку "uploads" для файлов), если их ещё нет.
//    Если задана переменная ZAP_DATA_DIR — берём папку оттуда (нужно для проверок).
const dataDir = process.env.ZAP_DATA_DIR
  ? path.resolve(process.env.ZAP_DATA_DIR)
  : path.join(__dirname, "data");
export const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// 2. Открываем (или создаём) сам файл базы данных.
export const db = new Database(path.join(dataDir, "messenger.db"));

// Небольшие настройки, чтобы база работала надёжно и быстро.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// 3. Создаём таблицы, если их ещё нет.
db.exec(`
  -- Таблица "пользователи": кто представился в мессенджере.
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- номер пользователя, выдаётся сам
    name       TEXT    NOT NULL UNIQUE,             -- имя, повторяться не может
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Таблица "беседы": это пара двух людей, которые переписываются.
  -- user_a — всегда меньший номер, user_b — всегда больший.
  -- Так одна и та же пара не создастся дважды.
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a     INTEGER NOT NULL,
    user_b     INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (user_a, user_b),
    FOREIGN KEY (user_a) REFERENCES users(id),
    FOREIGN KEY (user_b) REFERENCES users(id)
  );

  -- Таблица "сообщения": сами тексты, которые люди друг другу написали.
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,              -- в какой беседе написано
    sender_id       INTEGER NOT NULL,              -- кто написал
    text            TEXT    NOT NULL DEFAULT '',   -- что написал
    attachment_name TEXT,                          -- имя прикреплённого файла
    attachment_file TEXT,                          -- имя файла на диске
    attachment_type TEXT,                          -- вид файла (картинка или нет)
    edited_at       TEXT,                          -- когда сообщение изменили
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id)       REFERENCES users(id)
  );

  -- Ускоряет поиск сообщений внутри беседы.
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`);

// ------------------------------------------------------------
//  Если база была создана раньше (без новых полей) — тихонько
//  добавляем недостающие столбцы. Так старая переписка не пропадёт.
// ------------------------------------------------------------
function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("messages", "attachment_name", "TEXT");
ensureColumn("messages", "attachment_file", "TEXT");
ensureColumn("messages", "attachment_type", "TEXT");
ensureColumn("messages", "edited_at", "TEXT");

// ============================================================
//  Далее — простые функции-помощники.
//  Каждая делает одно маленькое дело с базой данных.
// ============================================================

export interface User {
  id: number;
  name: string;
  created_at: string;
}

export interface Attachment {
  file: string; // имя файла на диске
  name: string; // имя, как его видел человек
  type: string; // вид файла, например "image/png"
}

export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  text: string;
  attachment_name: string | null;
  attachment_file: string | null;
  attachment_type: string | null;
  edited_at: string | null;
  created_at: string;
}

// Найти пользователя по имени. Если такого нет — создать нового.
export function findOrCreateUser(name: string): User {
  const found = db.prepare("SELECT * FROM users WHERE name = ?").get(name) as User | undefined;
  if (found) return found;

  const result = db.prepare("INSERT INTO users (name) VALUES (?)").run(name);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid) as User;
}

// Получить одного пользователя по его номеру (id).
export function getUser(id: number): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

// Список всех пользователей, кроме меня самого.
export function listUsers(exceptId: number): User[] {
  return db
    .prepare("SELECT id, name, created_at FROM users WHERE id != ? ORDER BY name COLLATE NOCASE")
    .all(exceptId) as User[];
}

// Найти беседу двух людей. Возвращает её номер или null, если беседы ещё не было.
export function getConversation(userA: number, userB: number): number | null {
  const a = Math.min(userA, userB);
  const b = Math.max(userA, userB);
  const row = db
    .prepare("SELECT id FROM conversations WHERE user_a = ? AND user_b = ?")
    .get(a, b) as { id: number } | undefined;
  return row ? row.id : null;
}

// Найти беседу двух людей. Если её нет — создать новую и вернуть её номер.
export function findOrCreateConversation(userA: number, userB: number): number {
  const existing = getConversation(userA, userB);
  if (existing !== null) return existing;

  const a = Math.min(userA, userB);
  const b = Math.max(userA, userB);
  const result = db.prepare("INSERT INTO conversations (user_a, user_b) VALUES (?, ?)").run(a, b);
  return Number(result.lastInsertRowid);
}

// Кто участвует в беседе (два номера пользователей).
export function getConversationUsers(conversationId: number): number[] {
  const row = db
    .prepare("SELECT user_a, user_b FROM conversations WHERE id = ?")
    .get(conversationId) as { user_a: number; user_b: number } | undefined;
  return row ? [row.user_a, row.user_b] : [];
}

// Все сообщения одной беседы, от старых к новым.
export function getMessages(conversationId: number): Message[] {
  return db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId) as Message[];
}

// Одно сообщение по его номеру.
export function getMessage(id: number): Message | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | undefined;
}

// Записать новое сообщение в базу и вернуть его (уже с номером и временем).
export function addMessage(
  conversationId: number,
  senderId: number,
  text: string,
  attachment: Attachment | null
): Message {
  const result = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, text, attachment_name, attachment_file, attachment_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      conversationId,
      senderId,
      text,
      attachment ? attachment.name : null,
      attachment ? attachment.file : null,
      attachment ? attachment.type : null
    );
  return getMessage(Number(result.lastInsertRowid))!;
}

// Изменить текст своего сообщения. Вернёт обновлённое сообщение или null,
// если сообщения нет или оно написано не этим человеком.
export function updateMessageText(id: number, senderId: number, text: string): Message | null {
  const message = getMessage(id);
  if (!message || message.sender_id !== senderId) return null;

  db.prepare("UPDATE messages SET text = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
    text,
    id
  );
  return getMessage(id)!;
}

// Удалить своё сообщение. Вернёт данные удалённого сообщения или null.
export function deleteMessage(id: number, senderId: number): Message | null {
  const message = getMessage(id);
  if (!message || message.sender_id !== senderId) return null;

  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  return message;
}
