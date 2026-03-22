const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken } = require('../middleware/auth');

// JUGAR
router.post('/jugar', verificarToken, async (req, res) => {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        const { apuesta, ganancia, combinacion } = req.body;
        const usuarioId = req.usuario.id;

        // Verificar fichas suficientes
        const usuario = await client.query(
            'SELECT fichas FROM usuarios WHERE id = $1 FOR UPDATE',
            [usuarioId]
        );

        if (usuario.rows.length === 0) {
            throw new Error('Usuario no encontrado');
        }

        if (usuario.rows[0].fichas < apuesta) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Fichas insuficientes' });
        }

        // Si es solo una apuesta sin ganancia (primer paso)
        if (ganancia === 0 && combinacion === 'pendiente') {
            // Solo restar apuesta
            await client.query(
                `UPDATE usuarios 
                 SET fichas = fichas - $1,
                     veces_jugadas = veces_jugadas + 1
                 WHERE id = $2`,
                [apuesta, usuarioId]
            );

            await client.query('COMMIT');
            
            const nuevoSaldo = await db.query(
                'SELECT fichas FROM usuarios WHERE id = $1',
                [usuarioId]
            );

            return res.json({
                success: true,
                nuevas_fichas: nuevoSaldo.rows[0].fichas,
                ganancia: 0
            });
        }

        // Registrar jugada completa (con ganancia)
        await client.query(
            `INSERT INTO historial_juego 
             (usuario_id, apuesta, ganancia, combinacion) 
             VALUES ($1, $2, $3, $4)`,
            [usuarioId, apuesta, ganancia, combinacion]
        );

        // Actualizar fichas
        await client.query(
            `UPDATE usuarios 
             SET fichas = fichas - $1 + $2
             WHERE id = $3`,
            [apuesta, ganancia, usuarioId]
        );

        // Registrar transacción
        try {
            await client.query(
                `INSERT INTO transacciones (usuario_id, tipo, fichas, descripcion) 
                 VALUES ($1, 'jugada', $2, $3)`,
                [usuarioId, -apuesta, `Apuesta de ${apuesta} fichas`]
            );

            if (ganancia > 0) {
                await client.query(
                    `INSERT INTO transacciones (usuario_id, tipo, fichas, descripcion) 
                     VALUES ($1, 'premio', $2, $3)`,
                    [usuarioId, ganancia, `Premio por combinación ${combinacion}`]
                );
            }
        } catch (transError) {
            console.log('⚠️ Tabla transacciones no existe, continuando...');
        }

        await client.query('COMMIT');

        // Obtener nuevo saldo
        const nuevoSaldo = await db.query(
            'SELECT fichas FROM usuarios WHERE id = $1',
            [usuarioId]
        );

        res.json({
            success: true,
            nuevas_fichas: nuevoSaldo.rows[0].fichas,
            ganancia
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en jugada:', error);
        res.status(500).json({ error: error.message || 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// HISTORIAL DEL USUARIO
router.get('/historial', verificarToken, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM historial_juego 
             WHERE usuario_id = $1 
             ORDER BY fecha DESC 
             LIMIT 50`,
            [req.usuario.id]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ESTADÍSTICAS DEL USUARIO
router.get('/estadisticas', verificarToken, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_jugadas,
                SUM(CASE WHEN ganancia > 0 THEN 1 ELSE 0 END) as victorias,
                COALESCE(SUM(ganancia), 0) as ganancias_totales,
                COALESCE(MAX(ganancia), 0) as mayor_premio,
                COALESCE(AVG(ganancia), 0) as promedio_premio
             FROM historial_juego
             WHERE usuario_id = $1`,
            [req.usuario.id]
        );

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

module.exports = router;
