const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken } = require('../middleware/auth');

// JUGAR
router.post('/jugar', verificarToken, async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();

        const { apuesta, resultado, ganancia, combinacion } = req.body;
        const usuarioId = req.usuario.id;

        // Verificar fichas suficientes
        const [usuario] = await connection.query(
            'SELECT fichas FROM usuarios WHERE id = ? FOR UPDATE',
            [usuarioId]
        );

        if (usuario.length === 0) {
            throw new Error('Usuario no encontrado');
        }

        if (usuario[0].fichas < apuesta) {
            return res.status(400).json({ error: 'Fichas insuficientes' });
        }

        // Registrar jugada
        await connection.query(
            `INSERT INTO historial_juego 
             (usuario_id, apuesta, ganancia, combinacion) 
             VALUES (?, ?, ?, ?)`,
            [usuarioId, apuesta, ganancia, combinacion]
        );

        // Actualizar fichas (el trigger lo hace automáticamente)
        await connection.query(
            `UPDATE usuarios 
             SET fichas = fichas - ? + ? 
             WHERE id = ?`,
            [apuesta, ganancia, usuarioId]
        );

        await connection.commit();

        // Obtener fichas actualizadas
        const [nuevoSaldo] = await db.query(
            'SELECT fichas FROM usuarios WHERE id = ?',
            [usuarioId]
        );

        res.json({
            success: true,
            nuevas_fichas: nuevoSaldo[0].fichas,
            ganancia
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error en jugada:', error);
        res.status(500).json({ error: error.message || 'Error en el servidor' });
    } finally {
        connection.release();
    }
});

// HISTORIAL DEL USUARIO
router.get('/historial', verificarToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT * FROM historial_juego 
             WHERE usuario_id = ? 
             ORDER BY fecha DESC 
             LIMIT 50`,
            [req.usuario.id]
        );

        res.json(rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ESTADÍSTICAS DEL USUARIO
router.get('/estadisticas', verificarToken, async (req, res) => {
    try {
        const [stats] = await db.query(
            `SELECT 
                COUNT(*) as total_jugadas,
                SUM(CASE WHEN ganancia > 0 THEN 1 ELSE 0 END) as victorias,
                SUM(ganancia) as ganancias_totales,
                MAX(ganancia) as mayor_premio,
                AVG(ganancia) as promedio_premio
             FROM historial_juego
             WHERE usuario_id = ?`,
            [req.usuario.id]
        );

        res.json(stats[0]);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

module.exports = router;