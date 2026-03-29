const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// ✅ Configuración de CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware para JSON
app.use(express.json());

// ✅ SERVIR ARCHIVOS ESTÁTICOS DESDE LA RAÍZ DEL REPOSITORIO
// __dirname = /opt/render/project/src/backend
// .. = /opt/render/project/src (donde están los HTML)
app.use(express.static(path.join(__dirname, '..')));

// ✅ RUTA PRINCIPAL - sirve index.html desde la raíz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Importar rutas
const authRoutes = require('./routes/auth');
const juegoRoutes = require('./routes/juego');
const recargasRoutes = require('./routes/recargas');
const adminRoutes = require('./routes/admin');

// Usar rutas
app.use('/api', authRoutes);
app.use('/api', juegoRoutes);
app.use('/api/recargas', recargasRoutes);
app.use('/api/admin', adminRoutes);

// Ruta de prueba
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        database: 'connected'
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`✅ Frontend disponible en: http://localhost:${PORT}`);
    console.log(`✅ API disponible en: http://localhost:${PORT}/api`);
    console.log('✅ Base de datos conectada');
});
