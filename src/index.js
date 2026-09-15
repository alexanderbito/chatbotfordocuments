import express from 'express';
import 'dotenv/config';
import uploadRouter from './routes/upload.js';
import chatRouter from './routes/chat.js';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Doc Chatbot Demo API đang chạy' });
});

app.use('/upload', uploadRouter);
app.use('/chat', chatRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
