const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Tutup koneksi setiap selesai respons agar setiap request = koneksi baru.
// Ini membuat efek toxic (terutama toxicity < 1) konsisten per request.
app.use((req, res, next) => {
  res.set('Connection', 'close');
  next();
});

const products = [
  { id: 1, name: 'Laptop', price: 8500000 },
  { id: 2, name: 'Mouse', price: 150000 },
  { id: 3, name: 'Keyboard', price: 350000 },
];

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/products', (req, res) => {
  res.json({ source: 'backend', data: products });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend berjalan di port ${PORT}`);
});
