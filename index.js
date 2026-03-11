require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

// ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      address TEXT PRIMARY KEY,
      nickname TEXT,
      avatar_index INTEGER DEFAULT 0,
      gender TEXT DEFAULT '',
      mushroom_type TEXT DEFAULT 'red',
      experience_days INTEGER DEFAULT 0,
      status TEXT DEFAULT '',
      joined_at TIMESTAMP DEFAULT NOW(),
      post_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      address TEXT REFERENCES users(address),
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      address TEXT REFERENCES users(address),
      folder_id INTEGER REFERENCES folders(id),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      comment_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id),
      address TEXT REFERENCES users(address),
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database initialized!');
}

// ===== USERS =====

// Получить профиль
app.get('/api/users/:address', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE address = $1', [req.params.address.toLowerCase()]);
    if (rows.length === 0) return res.json(null);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создать или обновить профиль
app.post('/api/users', async (req, res) => {
  try {
    const { address, nickname, avatar_index, gender, mushroom_type, experience_days, status } = req.body;
    const addr = address.toLowerCase();
    await pool.query(`
      INSERT INTO users (address, nickname, avatar_index, gender, mushroom_type, experience_days, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (address) DO UPDATE SET
        nickname = EXCLUDED.nickname,
        avatar_index = EXCLUDED.avatar_index,
        gender = EXCLUDED.gender,
        mushroom_type = EXCLUDED.mushroom_type,
        experience_days = EXCLUDED.experience_days,
        status = EXCLUDED.status
    `, [addr, nickname, avatar_index || 0, gender || '', mushroom_type || 'red', experience_days || 0, status || '']);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить всех пользователей
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY post_count DESC, joined_at ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FOLDERS =====

// Получить папки пользователя
app.get('/api/folders/:address', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM folders WHERE address = $1 ORDER BY created_at ASC', [req.params.address.toLowerCase()]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создать папку
app.post('/api/folders', async (req, res) => {
  try {
    const { address, name } = req.body;
    const { rows } = await pool.query('INSERT INTO folders (address, name) VALUES ($1, $2) RETURNING *', [address.toLowerCase(), name]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Переименовать папку
app.put('/api/folders/:id', async (req, res) => {
  try {
    const { name, address } = req.body;
    await pool.query('UPDATE folders SET name = $1 WHERE id = $2 AND address = $3', [name, req.params.id, address.toLowerCase()]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== POSTS =====

// Получить посты пользователя
app.get('/api/posts/:address', async (req, res) => {
  try {
    const { folder_id } = req.query;
    let query = 'SELECT p.*, f.name as folder_name FROM posts p LEFT JOIN folders f ON p.folder_id = f.id WHERE p.address = $1';
    const params = [req.params.address.toLowerCase()];
    if (folder_id) { query += ' AND p.folder_id = $2'; params.push(folder_id); }
    query += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создать пост
app.post('/api/posts', async (req, res) => {
  try {
    const { address, folder_id, title, content } = req.body;
    const addr = address.toLowerCase();
    const { rows } = await pool.query(
      'INSERT INTO posts (address, folder_id, title, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [addr, folder_id || null, title, content]
    );
    await pool.query('UPDATE users SET post_count = post_count + 1 WHERE address = $1', [addr]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить все посты (лента)
app.get('/api/feed', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, u.nickname, u.avatar_index
      FROM posts p
      LEFT JOIN users u ON p.address = u.address
      ORDER BY p.created_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== COMMENTS =====

// Получить комментарии поста
app.get('/api/comments/:post_id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, u.nickname, u.avatar_index
      FROM comments c
      LEFT JOIN users u ON c.address = u.address
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.post_id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создать комментарий
app.post('/api/comments', async (req, res) => {
  try {
    const { post_id, address, content } = req.body;
    const addr = address.toLowerCase();
    const { rows } = await pool.query(
      'INSERT INTO comments (post_id, address, content) VALUES ($1, $2, $3) RETURNING *',
      [post_id, addr, content]
    );
    await pool.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [post_id]);
    await pool.query('UPDATE users SET comment_count = comment_count + 1 WHERE address = $1', [addr]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on port ${PORT}`);
});