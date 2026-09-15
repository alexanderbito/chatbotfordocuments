import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import uploadRouter from './routes/upload.js';
import chatRouter from './routes/chat.js';
import organizationsRouter from './routes/organizations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Phục vụ giao diện web tĩnh trong thư mục /public
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/upload', uploadRouter);
app.use('/chat', chatRouter);
app.use('/organizations', organizationsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
