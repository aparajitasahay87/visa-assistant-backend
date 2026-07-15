const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/visa-check', async (req, res) => {
  const { passport, destination } = req.body;
  try {
    const response = await fetch('https://visa-requirement.p.rapidapi.com/v2/visa/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'visa-requirement.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY
      },
      body: JSON.stringify({ passport, destination })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Visa lookup failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));