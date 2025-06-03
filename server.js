// server.js
import express from 'express';
import cors from 'cors';
import pricesRouter from './api/prices.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use('/prices', pricesRouter);

app.get('/', (req, res) => {
  res.send('✅ Fuel proxy is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
