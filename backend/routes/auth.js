const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { verificarToken } = require('../middleware/auth');  // <--- ESTA ES LA LÍNEA QUE FALTA

// REGISTRO
router.post('/register', async (req, res) => {
    try {
        const { usuario, password, role = 'user' } = req.body;

        if (!usuario || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        // Verificar si usuario existe
        const [existing] = await db.query(
            'SELECT id FROM usuarios WHERE usuario = ?',
            [usuario]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }

        // Hashear contraseña
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insertar usuario
        const [result] = await db.query(
            'INSERT INTO usuarios (usuario, password, role, fichas) VALUES (?, ?, ?, ?)',
            [usuario, hashedPassword, role, 0]
        );

        res.json({ 
            success: true, 
            message: 'Usuario registrado correctamente',
            id: result.insertId 
        });

    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// LOGIN
router.post('/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;

        if (!usuario || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        // Buscar usuario
        const [rows] = await db.query(
            'SELECT * FROM usuarios WHERE usuario = ?',
            [usuario]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const user = rows[0];

        // Verificar si está activo
        if (!user.activo) {
            return res.status(403).json({ error: 'Usuario bloqueado' });
        }

        // Verificar contraseña
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        }

        // Crear token
        const token = jwt.sign(
            { 
                id: user.id, 
                usuario: user.usuario, 
                role: user.role 
            },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            usuario: {
                id: user.id,
                usuario: user.usuario,
                role: user.role,
                fichas: user.fichas
            }
        });

    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// OBTENER DATOS DEL USUARIO
router.get('/usuario', verificarToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT u.*, 
                    COUNT(DISTINCT h.id) as veces_jugadas,
                    IFNULL(MAX(h.ganancia), 0) as mayor_premio
             FROM usuarios u
             LEFT JOIN historial_juego h ON u.id = h.usuario_id
             WHERE u.id = ?
             GROUP BY u.id`,
            [req.usuario.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ usuario: rows[0] });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

module.exports = router;