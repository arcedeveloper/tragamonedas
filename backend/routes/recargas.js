const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken } = require('../middleware/auth');

// SOLICITAR RECARGA
router.post('/solicitar', verificarToken, async (req, res) => {
    try {
        const { fichas, monto } = req.body;
        const usuarioId = req.usuario.id;

        if (!fichas || !monto) {
            return res.status(400).json({ error: 'Fichas y monto requeridos' });
        }

        const [result] = await db.query(
            `INSERT INTO solicitudes_recarga 
             (usuario_id, fichas, monto) 
             VALUES (?, ?, ?)`,
            [usuarioId, fichas, monto]
        );

        res.json({
            success: true,
            message: 'Solicitud enviada',
            id: result.insertId
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// VER MIS SOLICITUDES
router.get('/mis-solicitudes', verificarToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT * FROM solicitudes_recarga 
             WHERE usuario_id = ? 
             ORDER BY fecha_solicitud DESC`,
            [req.usuario.id]
        );

        res.json(rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

module.exports = router;