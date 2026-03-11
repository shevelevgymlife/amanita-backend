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
      comment_count INTEGER DEFAULT 0,
      vote_count INTEGER DEFAULT 0
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
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      comment_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      dislike_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      address TEXT REFERENCES users(address),
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      voter TEXT REFERENCES users(address),
      target TEXT REFERENCES users(address),
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (voter, target)
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      address TEXT REFERENCES users(address),
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      PRIMARY KEY (address, post_id)
    );
  `);

  // Добавляем колонки если их нет (для существующих баз)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vote_count INTEGER DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS dislike_count INTEGER DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
  `).catch(() => {});

  console.log('Database initialized!');
}

// ===== USERS =====

app.get('/api/users/:address', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE address = $1', [req.params.address.toLowerCase()]);
    res.json(rows.length === 0 ? null : rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY vote_count DESC, post_count DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== VOTES =====

app.post('/api/votes', async (req, res) => {
  try {
    const { voter, target } = req.body;
    const v = voter.toLowerCase();
    const t = target.toLowerCase();
    if (v === t) return res.status(400).json({ error: 'Нельзя голосовать за себя' });

    // Проверяем не голосовал ли уже за этого
    const { rows } = await pool.query('SELECT * FROM votes WHERE voter = $1 AND target = $2', [v, t]);
    if (rows.length > 0) return res.status(400).json({ error: 'Уже голосовали за этого пользователя' });

    // Проверяем за кого голосовал раньше
    const prev = await pool.query('SELECT * FROM votes WHERE voter = $1 ORDER BY created_at DESC LIMIT 1', [v]);

    await pool.query('INSERT INTO votes (voter, target) VALUES ($1, $2)', [v, t]);
    await pool.query('UPDATE users SET vote_count = vote_count + 1 WHERE address = $1', [t]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/votes', async (req, res) => {
  try {
    const { voter, target } = req.body;
    const v = voter.toLowerCase();
    const t = target.toLowerCase();
    const { rowCount } = await pool.query('DELETE FROM votes WHERE voter = $1 AND target = $2', [v, t]);
    if (rowCount > 0) await pool.query('UPDATE users SET vote_count = GREATEST(vote_count - 1, 0) WHERE address = $1', [t]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/votes/:voter', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT target FROM votes WHERE voter = $1', [req.params.voter.toLowerCase()]);
    res.json(rows.map(r => r.target));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== POST LIKES =====

app.post('/api/post-likes', async (req, res) => {
  try {
    const { address, post_id, type } = req.body;
    const addr = address.toLowerCase();

    const { rows } = await pool.query('SELECT * FROM post_likes WHERE address = $1 AND post_id = $2', [addr, post_id]);

    if (rows.length > 0) {
      if (rows[0].type === type) {
        // Убираем реакцию
        await pool.query('DELETE FROM post_likes WHERE address = $1 AND post_id = $2', [addr, post_id]);
        const col = type === 'like' ? 'like_count' : 'dislike_count';
        await pool.query(`UPDATE posts SET ${col} = GREATEST(${col} - 1, 0) WHERE id = $1`, [post_id]);
      } else {
        // Меняем реакцию
        const oldCol = rows[0].type === 'like' ? 'like_count' : 'dislike_count';
        const newCol = type === 'like' ? 'like_count' : 'dislike_count';
        await pool.query('UPDATE post_likes SET type = $1 WHERE address = $2 AND post_id = $3', [type, addr, post_id]);
        await pool.query(`UPDATE posts SET ${oldCol} = GREATEST(${oldCol} - 1, 0), ${newCol} = ${newCol} + 1 WHERE id = $1`, [post_id]);
      }
    } else {
      await pool.query('INSERT INTO post_likes (address, post_id, type) VALUES ($1, $2, $3)', [addr, post_id, type]);
      const col = type === 'like' ? 'like_count' : 'dislike_count';
      await pool.query(`UPDATE posts SET ${col} = ${col} + 1 WHERE id = $1`, [post_id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/post-likes/:address', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT post_id, type FROM post_likes WHERE address = $1', [req.params.address.toLowerCase()]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== FOLDERS =====

app.get('/api/folders/:address', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM folders WHERE address = $1 ORDER BY created_at ASC', [req.params.address.toLowerCase()]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', async (req, res) => {
  try {
    const { address, name } = req.body;
    const { rows } = await pool.query('INSERT INTO folders (address, name) VALUES ($1, $2) RETURNING *', [address.toLowerCase(), name]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/folders/:id', async (req, res) => {
  try {
    const { name, address } = req.body;
    await pool.query('UPDATE folders SET name = $1 WHERE id = $2 AND address = $3', [name, req.params.id, address.toLowerCase()]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id', async (req, res) => {
  try {
    const { address } = req.body;
    // Посты остаются, просто убираем папку
    await pool.query('UPDATE posts SET folder_id = NULL WHERE folder_id = $1', [req.params.id]);
    await pool.query('DELETE FROM folders WHERE id = $1 AND address = $2', [req.params.id, address.toLowerCase()]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== POSTS =====

app.get('/api/posts/:address', async (req, res) => {
  try {
    const { folder_id } = req.query;
    let query = 'SELECT p.*, f.name as folder_name FROM posts p LEFT JOIN folders f ON p.folder_id = f.id WHERE p.address = $1';
    const params = [req.params.address.toLowerCase()];
    if (folder_id) { query += ' AND p.folder_id = $2'; params.push(folder_id); }
    query += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/posts/:id', async (req, res) => {
  try {
    const { address, title, content, folder_id } = req.body;
    await pool.query(
      'UPDATE posts SET title = $1, content = $2, folder_id = $3, updated_at = NOW() WHERE id = $4 AND address = $5',
      [title, content, folder_id || null, req.params.id, address.toLowerCase()]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    const { address } = req.body;
    const addr = address.toLowerCase();
    await pool.query('DELETE FROM posts WHERE id = $1 AND address = $2', [req.params.id, addr]);
    await pool.query('UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE address = $1', [addr]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/feed', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, u.nickname, u.avatar_index
      FROM posts p LEFT JOIN users u ON p.address = u.address
      ORDER BY p.created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== COMMENTS =====

app.get('/api/comments/:post_id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, u.nickname, u.avatar_index
      FROM comments c LEFT JOIN users u ON c.address = u.address
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.post_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comments', async (req, res) => {
  try {
    const { post_id, parent_id, address, content } = req.body;
    const addr = address.toLowerCase();
    const { rows } = await pool.query(
      'INSERT INTO comments (post_id, parent_id, address, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [post_id, parent_id || null, addr, content]
    );
    await pool.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [post_id]);
    await pool.query('UPDATE users SET comment_count = comment_count + 1 WHERE address = $1', [addr]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/comments/:id', async (req, res) => {
  try {
    const { address, content } = req.body;
    await pool.query(
      'UPDATE comments SET content = $1, updated_at = NOW() WHERE id = $2 AND address = $3',
      [content, req.params.id, address.toLowerCase()]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const { address, post_owner } = req.body;
    const addr = address.toLowerCase();
    const owner = post_owner ? post_owner.toLowerCase() : null;
    // Удалить может автор комментария или владелец страницы
    const { rows } = await pool.query('SELECT * FROM comments WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    if (rows[0].address !== addr && owner !== addr) return res.status(403).json({ error: 'Нет прав' });
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [rows[0].post_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on port ${PORT}`);
});